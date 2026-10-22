/**
 * src/client.ts — local client for the job daemon (one request per
 * connection; the daemon is the long-lived side).
 *
 * Auto-start: the first `pijob run` spawns the detached daemon and waits for
 * its ping. `stateDir`/`socketPath` are injectable so tests never touch the
 * user's real daemon.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { ipcPath, stateRoot } from "./platform.js";
import {
  DAEMON_POLL_MS,
  DAEMON_START_TIMEOUT_MS,
  JOB_REQUEST_TIMEOUT_MS,
  JOB_STOP_TIMEOUT_MS,
} from "./limits.js";
import {
  makeId,
  type JobdOp,
  type JobdRequest,
  type JobdResponse,
  type JobRecord,
  type ListData,
  type LogData,
  type PauseData,
  type RunData,
  type StatusData,
  type StopData,
} from "./protocol.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface JobdClientOptions {
  stateDir?: string;
  socketPath?: string;
  owner?: string;
  /** false disables auto-spawn (tests with an explicitly started daemon). */
  autoStart?: boolean;
}

export class JobdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobdError";
  }
}

export class JobdClient {
  readonly stateDir: string;
  readonly socketPath: string;
  readonly owner: string;
  private readonly autoStart: boolean;
  private seq = 0;

  constructor(opts: JobdClientOptions = {}) {
    this.stateDir = opts.stateDir ?? stateRoot();
    this.owner = opts.owner ?? process.env.USER ?? process.env.USERNAME ?? "user";
    this.socketPath = opts.socketPath ?? ipcPath("jobd", { ...process.env, PI_JOBD_STATE_DIR: this.stateDir });
    this.autoStart = opts.autoStart !== false;
  }

  private send(op: JobdOp, payload: Record<string, unknown>, timeoutMs: number): Promise<JobdResponse> {
    const req: JobdRequest = { id: makeId("r"), op, ...payload };
    return new Promise<JobdResponse>((resolvePromise, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buf = "";
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new JobdError("timeout", `jobd request timed out: ${op}`)));
      }, timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
      socket.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        let res: JobdResponse;
        try {
          res = JSON.parse(line) as JobdResponse;
        } catch {
          finish(() => reject(new JobdError("protocol_error", "jobd sent invalid JSON")));
          return;
        }
        finish(() => resolvePromise(res));
      });
      socket.on("error", (err) => {
        finish(() => reject(new JobdError("unreachable", err.message)));
      });
      socket.on("close", () => {
        finish(() => reject(new JobdError("unreachable", "jobd closed the connection")));
      });
    });
  }

  private async unwrap<T>(op: JobdOp, payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const res = await this.send(op, payload, timeoutMs);
    if (!res.ok) throw new JobdError(res.code ?? "error", res.error ?? `${op} failed`);
    return res.data as T;
  }

  /** Best-effort probe; never auto-starts. */
  async ping(timeoutMs = 1_000): Promise<Record<string, unknown>> {
    return this.unwrap<Record<string, unknown>>("ping", {}, timeoutMs);
  }

  /** Spawn the daemon if it is not reachable, then wait until it answers. */
  async ensure(): Promise<void> {
    try {
      await this.ping(700);
      return;
    } catch {
      // not running
    }
    if (!this.autoStart) throw new JobdError("unreachable", "jobd is not running (autoStart disabled)");
    const daemonEntry = fileURLToPath(new URL("./daemon.js", import.meta.url));
    const child = spawn(
      process.execPath,
      [daemonEntry, "--socket", this.socketPath, "--state-dir", this.stateDir, "--owner", this.owner],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, PI_JOBD_STATE_DIR: this.stateDir },
      },
    );
    child.unref();
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(DAEMON_POLL_MS);
      try {
        await this.ping(500);
        return;
      } catch {
        // keep polling
      }
    }
    throw new JobdError("unavailable", `jobd did not start (state ${this.stateDir})`);
  }

  async run(opts: { command: string; cwd?: string; owner?: string; pausable?: boolean }): Promise<JobRecord> {
    await this.ensure();
    const data = await this.unwrap<RunData>(
      "run",
      {
        command: opts.command,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        ...(opts.pausable === true ? { pausable: true } : {}),
      },
      JOB_REQUEST_TIMEOUT_MS,
    );
    return data.job;
  }

  async status(jobId: string): Promise<JobRecord | undefined> {
    await this.ensure();
    const data = await this.unwrap<StatusData>("status", { jobId }, JOB_REQUEST_TIMEOUT_MS);
    return data.job;
  }

  async list(): Promise<JobRecord[]> {
    await this.ensure();
    const data = await this.unwrap<ListData>("list", {}, JOB_REQUEST_TIMEOUT_MS);
    return data.jobs;
  }

  async stop(jobId: string): Promise<StopData> {
    await this.ensure();
    return this.unwrap<StopData>("stop", { jobId }, JOB_STOP_TIMEOUT_MS);
  }

  async pause(jobId: string): Promise<PauseData> {
    await this.ensure();
    return this.unwrap<PauseData>("pause", { jobId }, JOB_REQUEST_TIMEOUT_MS);
  }

  async resume(jobId: string): Promise<PauseData> {
    await this.ensure();
    return this.unwrap<PauseData>("resume", { jobId }, JOB_REQUEST_TIMEOUT_MS);
  }

  async log(jobId: string, lines?: number): Promise<LogData> {
    await this.ensure();
    return this.unwrap<LogData>("log", { jobId, ...(lines !== undefined ? { lines } : {}) }, JOB_REQUEST_TIMEOUT_MS);
  }

  async shutdown(): Promise<void> {
    await this.send("shutdown", {}, 2_000).catch(() => undefined);
  }
}

/** Convenience for tools/CLI: create a client rooted at the resolved state dir. */
export function createClient(opts: JobdClientOptions = {}): JobdClient {
  return new JobdClient(opts);
}
