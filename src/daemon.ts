#!/usr/bin/env node
/**
 * src/daemon.ts — the per-user detached job supervisor.
 *
 * Why a daemon: the agent turn must not be the parent of long work. Jobs run
 * in their own process group (POSIX) / tree (Windows) and survive the session.
 * Why ONE daemon per user: a per-session daemon (the first attempt) multiplied
 * sockets, registries and mesh peers; here every job carries an `owner`, and
 * the same-user 0600 socket is the trust boundary.
 *
 * MVP scope: run/status/list/stop/pause/resume/log. A daemon restart marks
 * in-flight jobs `lost` (fail-closed); adoption is a later phase.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { userInfo } from "node:os";
import {
  ADOPT_POLL_MS,
  DAEMON_POLL_MS,
  DEFAULT_TAIL_LINES,
  KILL_SETTLE_MS,
  MAX_COMMAND_CHARS,
  MAX_TAIL_BYTES,
  MAX_TAIL_LINES,
  STOP_GRACE_MS,
} from "./limits.js";
import {
  ipcPath,
  isAlive,
  isZombie,
  killTree,
  processIdentity,
  shellArgs,
  stateRoot,
  supportsPause,
  unlinkEndpoint,
} from "./platform.js";
import {
  isTerminal,
  makeId,
  nowIso,
  sha256,
  type JobdRequest,
  type JobdResponse,
  type JobRecord,
  type LogData,
  type PauseData,
  type RunData,
  type StopData,
} from "./protocol.js";
import { JobRegistry } from "./registry.js";
import { JOB_VERSION } from "./version.js";

const VERSION = JOB_VERSION;

export interface JobDaemonOptions {
  socketPath: string;
  stateDir: string;
  owner: string;
  stopGraceMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tailFile(path: string, lines: number): LogData {
  try {
    const stat = statSync(path);
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const length = stat.size - start;
    if (length === 0) return { jobId: "", lines: [], truncated: false };
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(length);
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const all = buf.toString("utf8").split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return { jobId: "", lines: all.slice(-lines), truncated: start > 0 || all.length > lines };
  } catch {
    return { jobId: "", lines: [], truncated: false };
  }
}

export class JobDaemon {
  readonly socketPath: string;
  readonly stateDir: string;
  readonly owner: string;
  readonly registry: JobRegistry;
  private readonly stopGraceMs: number;
  private server: Server | null = null;
  private started = false;
  private readonly children = new Map<string, ChildProcess>();
  private adoptTimer: NodeJS.Timeout | null = null;

  constructor(opts: JobDaemonOptions) {
    this.socketPath = opts.socketPath;
    this.stateDir = opts.stateDir;
    this.owner = opts.owner;
    this.stopGraceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
    this.registry = new JobRegistry(opts.stateDir);
  }

  async start(): Promise<void> {
    if (this.started) return;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    unlinkEndpoint(this.socketPath);
    // A Windows named pipe is released a moment after the owning process
    // dies; a supervised restart after a crash can race it. Retry EADDRINUSE
    // for a bounded ~2 s instead of failing the whole daemon.
    for (let attempt = 0; ; attempt += 1) {
      const server = createServer((socket) => this.onConnection(socket));
      this.server = server;
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(this.socketPath, () => {
            server.removeListener("error", rejectListen);
            resolveListen();
          });
        });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE" && attempt < 50) {
          await sleep(100);
          continue;
        }
        throw err;
      }
    }
    try {
      // Same-user trust boundary. Windows named pipes ignore chmod.
      const { chmodSync } = await import("node:fs");
      chmodSync(this.socketPath, 0o600);
    } catch {
      // non-POSIX: best effort
    }
    writeFileSync(join(this.stateDir, "daemon.pid"), `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    this.adoptOnStart();
    this.startAdoptedMonitor();
    this.registry.prune();
    this.started = true;
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.adoptTimer !== null) {
      clearInterval(this.adoptTimer);
      this.adoptTimer = null;
    }
    // A paused job must never stay frozen because its daemon went away. Jobs
    // themselves are detached on purpose: shutting the daemon down must not
    // kill work that the user asked to run in the background.
    for (const job of this.registry.loadAll()) {
      if (job.state !== "paused" || job.pid === undefined) continue;
      // Only signal a process whose identity we can still prove.
      if (this.canSignal(job) && killTree(job.pid, "SIGCONT")) {
        job.state = "running";
        job.note = "daemon shut down; resumed (never leave a job stopped forever)";
        this.registry.save(job);
      }
    }
    if (this.server !== null) {
      await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
      this.server = null;
    }
    unlinkEndpoint(this.socketPath);
    try {
      unlinkSync(join(this.stateDir, "daemon.pid"));
    } catch {
      // best effort
    }
  }

  private onConnection(socket: Socket): void {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 256 * 1024) {
        socket.destroy();
        return;
      }
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === "") continue;
        let req: JobdRequest;
        try {
          req = JSON.parse(line) as JobdRequest;
        } catch {
          continue;
        }
        void this.handle(req).then((res) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
        });
      }
    });
  }

  private respond(req: JobdRequest, data: unknown): JobdResponse {
    return { id: req.id, ok: true, data };
  }

  private fail(req: JobdRequest, code: string, error: string): JobdResponse {
    return { id: req.id, ok: false, code, error };
  }

  private async handle(req: JobdRequest): Promise<JobdResponse> {
    try {
      switch (req.op) {
        case "ping":
          return this.respond(req, {
            version: VERSION,
            pid: process.pid,
            owner: this.owner,
            socketPath: this.socketPath,
            stateDir: this.stateDir,
            supportsPause: supportsPause(),
            jobs: this.registry.list().length,
          });
        case "run":
          return this.runJob(req);
        case "status": {
          const job = req.jobId !== undefined ? this.registry.get(req.jobId) : undefined;
          return this.respond(req, { job });
        }
        case "list":
          return this.respond(req, { jobs: this.registry.list() });
        case "stop":
          return this.stopJob(req);
        case "pause":
          return this.pauseJob(req);
        case "resume":
          return this.resumeJob(req);
        case "log": {
          if (req.jobId === undefined) return this.fail(req, "invalid_request", "jobId is required");
          const job = this.registry.get(req.jobId);
          if (job === undefined) return this.fail(req, "not_found", `no job ${req.jobId}`);
          const lines = Math.max(1, Math.min(req.lines ?? DEFAULT_TAIL_LINES, MAX_TAIL_LINES));
          const data = tailFile(job.logPath, lines);
          return this.respond(req, { ...data, jobId: job.jobId } satisfies LogData);
        }
        case "shutdown":
          setImmediate(() => void this.close().then(() => process.exit(0)));
          return this.respond(req, { stopping: true });
        default:
          return this.fail(req, "invalid_request", `unknown op ${String((req as { op?: unknown }).op)}`);
      }
    } catch (err) {
      return this.fail(req, "internal", err instanceof Error ? err.message : String(err));
    }
  }

  private runJob(req: JobdRequest): JobdResponse {
    const command = (req.command ?? "").trim();
    if (command === "") return this.fail(req, "invalid_request", "command is required");
    if (command.length > MAX_COMMAND_CHARS) {
      return this.fail(req, "invalid_request", `command exceeds ${MAX_COMMAND_CHARS} chars`);
    }
    const cwd = resolve(req.cwd ?? process.cwd());
    if (!existsSync(cwd)) return this.fail(req, "invalid_request", `cwd does not exist: ${cwd}`);
    const owner = (req.owner ?? this.owner).trim() || this.owner;
    if (owner.length > 128) return this.fail(req, "invalid_request", "owner exceeds 128 chars");
    const jobId = makeId("j");
    const logPath = join(this.registry.jobsDir, `${jobId}.log`);
    const redact = process.env.PI_JOBD_REDACT_COMMAND === "1";
    const job: JobRecord = {
      jobId,
      owner,
      command: redact ? "<redacted>" : command,
      commandHash: sha256(command),
      cwd,
      state: "starting",
      pausable: req.pausable === true,
      createdAt: nowIso(),
      logPath,
    };
    this.registry.save(job);

    let fd: number;
    try {
      fd = openSync(logPath, "a", 0o600);
    } catch (err) {
      job.state = "failed";
      job.endedAt = nowIso();
      job.exitCode = null;
      job.note = `log open failed: ${err instanceof Error ? err.message : String(err)}`;
      this.registry.save(job);
      return this.fail(req, "log_failed", job.note);
    }

    const { bin, args } = shellArgs(command);
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd,
        detached: true, // own process group (POSIX) / tree (Windows)
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        // cmd.exe must see the command verbatim: Node's CRT quoting escapes
        // inner quotes in a way cmd does not understand (node "path" ...).
        windowsVerbatimArguments: process.platform === "win32",
        env: { ...process.env, PI_JOBD: "1", PI_JOBD_JOB_ID: jobId, PI_JOBD_OWNER: owner },
      });
    } catch (err) {
      closeSync(fd);
      job.state = "failed";
      job.endedAt = nowIso();
      job.exitCode = null;
      job.note = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.registry.save(job);
      return this.fail(req, "spawn_failed", job.note);
    }
    closeSync(fd);

    job.pid = child.pid ?? undefined;
    job.pgid = process.platform === "win32" ? undefined : child.pid ?? undefined;
    job.state = "running";
    job.startedAt = nowIso();
    this.registry.save(job);
    if (child.pid !== undefined) this.children.set(jobId, child);

    // Identity anchor for a future daemon restart (adoption). Captured AFTER
    // the run response: on Windows processIdentity spawns PowerShell, and a
    // synchronous call here made `run` time out on loaded runners. If the
    // daemon dies before this lands, the job is unprovable -> lost (safe).
    if (child.pid !== undefined) {
      const identityPid = child.pid;
      const capture = (): void => {
        const identity = processIdentity(identityPid);
        if (identity === undefined) return;
        const current = this.registry.get(jobId);
        if (current === undefined) return;
        current.startToken = identity.startToken;
        current.bootId = identity.bootId;
        this.registry.save(current);
      };
      // /proc and ps are fast: capture BEFORE the response so the job is
      // adoptable even if the daemon dies immediately. PowerShell is slow:
      // on Windows capture AFTER the response (a sync call timed out `run`).
      if (process.platform === "win32") setImmediate(capture);
      else capture();
    }

    child.on("error", (err) => {
      const current = this.registry.get(jobId);
      if (current === undefined) return;
      current.state = "failed";
      current.endedAt = nowIso();
      current.exitCode = null;
      current.note = `child error: ${err.message}`;
      this.registry.save(current);
    });
    child.on("exit", (code, signal) => {
      this.children.delete(jobId);
      const current = this.registry.get(jobId);
      if (current === undefined) return;
      // `stop` owns the terminal state while it is stopping the job, and a
      // job already finalized as `stopped` must stay stopped (the exit event
      // only enriches it with the real code/signal).
      if (current.state !== "stopping" && current.state !== "stopped") {
        current.state = code === 0 && signal === null ? "exited" : "failed";
      }
      current.exitCode = code;
      current.signal = signal;
      current.endedAt = current.endedAt ?? nowIso();
      this.registry.save(current);
    });

    return this.respond(req, { job } satisfies RunData);
  }

  /** True when the pid is alive AND its start token + boot id match the record. */
  private identityOk(job: JobRecord): boolean {
    if (job.pid === undefined || !isAlive(job.pid)) return false;
    if (job.startToken === undefined || job.bootId === undefined) return false;
    const identity = processIdentity(job.pid);
    return identity !== undefined && identity.startToken === job.startToken && identity.bootId === job.bootId;
  }

  /**
   * A job we spawned ourselves is proven by the live child handle; an adopted
   * job must re-prove its identity before EVERY signal (pid reuse guard).
   */
  private canSignal(job: JobRecord): boolean {
    if (this.children.has(job.jobId)) return true;
    return this.identityOk(job);
  }

  private markLost(job: JobRecord, note: string): JobRecord {
    return this.registry.markLost(job, note);
  }

  /** A zombie has already exited (it lingers only because nobody reaped it):
   *  the honest terminal state is `exited` with an unknowable exit code,
   *  never `lost` (which claims the pid is live but unprovable). */
  private markEnded(job: JobRecord, note: string): JobRecord {
    job.state = "exited";
    job.exitCode = null;
    job.signal = null;
    job.endedAt = job.endedAt ?? nowIso();
    job.note = note;
    this.registry.save(job);
    return job;
  }

  /**
   * Restart policy: verify, never guess. A job whose pid+start token+boot id
   * still match is ADOPTED (it may still be running); anything unprovable is
   * `lost` with an honest unknown exit code. This is the phase-3 counterpart
   * of the previous fail-closed MVP.
   */
  private adoptOnStart(): void {
    for (const job of this.registry.loadAll()) {
      if (isTerminal(job.state)) continue;
      if (job.pid !== undefined && isZombie(job.pid)) {
        this.markEnded(job, "already exited (zombie, unreaped); outcome unknowable");
        continue;
      }
      if (job.pid !== undefined && this.identityOk(job)) {
        job.adopted = true;
        job.note = "adopted after daemon restart (process identity verified)";
        this.registry.save(job);
      } else {
        this.markLost(job, "daemon restarted; process identity not proven (pid gone or reused)");
      }
    }
  }

  /** Adopted jobs have no child handle: death is observed by bounded polling.
   *  The check is IDENTITY, not just liveness: kill(pid, 0) is also true for
   *  a zombie (no reaping init) and for a reused pid — both mean the process
   *  we watched has ended, and the outcome stays unknowable either way. */
  private startAdoptedMonitor(): void {
    if (this.adoptTimer !== null) return;
    this.adoptTimer = setInterval(() => {
      for (const job of this.registry.loadAll()) {
        if (job.adopted !== true || isTerminal(job.state)) continue;
        if (job.pid !== undefined && this.identityOk(job)) continue;
        job.state = job.state === "stopping" ? "stopped" : "exited";
        job.exitCode = null; // not our child: waitpid is unavailable, stay honest
        job.signal = null;
        job.endedAt = job.endedAt ?? nowIso();
        job.note = "adopted process ended; exit code unknowable (not our child)";
        this.registry.save(job);
      }
    }, ADOPT_POLL_MS);
    this.adoptTimer.unref();
  }

  private async stopJob(req: JobdRequest): Promise<JobdResponse> {
    if (req.jobId === undefined) return this.fail(req, "invalid_request", "jobId is required");
    const job = this.registry.get(req.jobId);
    if (job === undefined) return this.fail(req, "not_found", `no job ${req.jobId}`);
    if (job.state === "lost") {
      return this.fail(req, "identity_mismatch", `job ${job.jobId} is lost; refusing to signal an unproven pid`);
    }
    if (isTerminal(job.state)) return this.respond(req, { job, killed: false } satisfies StopData);
    if (job.pid !== undefined && isZombie(job.pid)) {
      const ended = this.markEnded(job, "already exited (zombie, unreaped); outcome unknowable");
      return this.respond(req, { job: ended, killed: false } satisfies StopData);
    }
    if (!this.canSignal(job)) {
      const lost = this.markLost(job, "refusing to signal: process identity not proven (pid gone or reused)");
      return this.fail(req, "identity_mismatch", `job ${job.jobId} is ${lost.state}; refusing to signal an unproven pid`);
    }
    const wasPaused = job.state === "paused";
    job.state = "stopping";
    this.registry.save(job);
    const pid = job.pid;
    if (pid === undefined || !isAlive(pid)) {
      const final = this.finishStopped(job.jobId);
      return this.respond(req, { job: final, killed: false } satisfies StopData);
    }
    if (wasPaused) {
      // A SIGSTOPed process ignores SIGTERM until it is continued.
      killTree(pid, "SIGCONT");
    }
    killTree(pid, "SIGTERM");
    const deadline = Date.now() + this.stopGraceMs;
    while (Date.now() < deadline && isAlive(pid)) await sleep(DAEMON_POLL_MS);
    let killed = false;
    if (isAlive(pid)) {
      // Re-prove ownership before the final, ungraceful signal: the pid may
      // have been reaped and reused during the grace window.
      if (!this.canSignal(job)) {
        const lost = this.markLost(job, "refusing SIGKILL: process identity not proven (pid gone or reused)");
        return this.fail(req, "identity_mismatch", `job ${job.jobId} is ${lost.state}; refusing to SIGKILL an unproven pid`);
      }
      killed = true;
      killTree(pid, "SIGKILL");
      const killDeadline = Date.now() + KILL_SETTLE_MS;
      while (Date.now() < killDeadline && isAlive(pid)) await sleep(25);
    }
    // m3: a signal that failed (EPERM, missing taskkill) must not be reported
    // as stopped. The process is still alive: that is a failure, not a state.
    if (isAlive(pid)) {
      const current = this.registry.get(job.jobId) ?? job;
      current.state = "failed";
      current.endedAt = current.endedAt ?? nowIso();
      current.exitCode = null;
      current.signal = null;
      current.note = "stop failed: process still alive after SIGKILL (permissions or taskkill failure)";
      this.registry.save(current);
      return this.fail(req, "kill_failed", current.note);
    }
    // Give the child's exit event one tick to land so the ack carries the
    // real exit code/signal instead of "unknown".
    await sleep(20);
    const final = this.finishStopped(job.jobId, killed ? "SIGKILL" : undefined);
    return this.respond(req, { job: final, killed } satisfies StopData);
  }

  private finishStopped(jobId: string, signal?: string): JobRecord {
    const job = this.registry.get(jobId);
    if (job === undefined) throw new Error(`job ${jobId} disappeared`);
    job.state = "stopped";
    job.endedAt = job.endedAt ?? nowIso();
    if (signal !== undefined) job.signal = signal;
    if (job.exitCode === undefined) job.exitCode = null; // unknowable, never 0
    this.registry.save(job);
    return job;
  }

  private pauseJob(req: JobdRequest): JobdResponse {
    if (req.jobId === undefined) return this.fail(req, "invalid_request", "jobId is required");
    const job = this.registry.get(req.jobId);
    if (job === undefined) return this.fail(req, "not_found", `no job ${req.jobId}`);
    if (job.state === "lost") {
      return this.fail(req, "identity_mismatch", `job ${job.jobId} is lost; refusing to signal an unproven pid`);
    }
    if (!job.pausable) {
      return this.respond(req, { job, status: "not_pausable" } satisfies PauseData);
    }
    if (!supportsPause()) {
      return this.respond(req, { job, status: "not_supported" } satisfies PauseData);
    }
    if (job.state !== "running" || job.pid === undefined) {
      return this.respond(req, { job, status: "not_running" } satisfies PauseData);
    }
    if (isZombie(job.pid)) {
      const ended = this.markEnded(job, "already exited (zombie, unreaped); outcome unknowable");
      return this.respond(req, { job: ended, status: "not_running" } satisfies PauseData);
    }
    if (!this.canSignal(job)) {
      const lost = this.markLost(job, "refusing to signal: process identity not proven (pid gone or reused)");
      return this.fail(req, "identity_mismatch", `job ${job.jobId} is ${lost.state}; refusing to SIGSTOP an unproven pid`);
    }
    if (!killTree(job.pid, "SIGSTOP")) {
      return this.fail(req, "signal_failed", `could not SIGSTOP pid ${job.pid}`);
    }
    job.state = "paused";
    this.registry.save(job);
    return this.respond(req, { job, status: "paused" } satisfies PauseData);
  }

  private resumeJob(req: JobdRequest): JobdResponse {
    if (req.jobId === undefined) return this.fail(req, "invalid_request", "jobId is required");
    const job = this.registry.get(req.jobId);
    if (job === undefined) return this.fail(req, "not_found", `no job ${req.jobId}`);
    if (job.state === "lost") {
      return this.fail(req, "identity_mismatch", `job ${job.jobId} is lost; refusing to signal an unproven pid`);
    }
    if (job.state !== "paused" || job.pid === undefined) {
      return this.respond(req, { job, status: "not_paused" } satisfies PauseData);
    }
    if (isZombie(job.pid)) {
      const ended = this.markEnded(job, "already exited (zombie, unreaped); outcome unknowable");
      return this.respond(req, { job: ended, status: "not_paused" } satisfies PauseData);
    }
    if (!this.canSignal(job)) {
      const lost = this.markLost(job, "refusing to signal: process identity not proven (pid gone or reused)");
      return this.fail(req, "identity_mismatch", `job ${job.jobId} is ${lost.state}; refusing to SIGCONT an unproven pid`);
    }
    if (!killTree(job.pid, "SIGCONT")) {
      return this.fail(req, "signal_failed", `could not SIGCONT pid ${job.pid}`);
    }
    job.state = "running";
    this.registry.save(job);
    return this.respond(req, { job, status: "resumed" } satisfies PauseData);
  }
}

// ---- entry point (detached spawn target) ----

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const stateDir = argValue(process.argv, "--state-dir") ?? stateRoot();
  const env = { ...process.env, PI_JOBD_STATE_DIR: stateDir };
  const socketPath = argValue(process.argv, "--socket") ?? ipcPath("jobd", env);
  const owner = argValue(process.argv, "--owner") ?? userInfo().username;
  const daemon = new JobDaemon({ socketPath, stateDir, owner });
  await daemon.start();
  const shutdown = (): void => {
    void daemon.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isMain = process.argv[1] !== undefined && /daemon\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`pi-jobd daemon failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
