// test/adoption-edge.test.ts — adoption edge cases with real processes.
// Ported from the pi-mesh job-runner test assets (cgarrot/pi-mesh PR #11):
// the scenarios pi-jobd's own suite does not cover yet — the signal-path
// identity guard against pid reuse, zombies under a non-reaping init
// (containers), adopted-job stop escalation, and the daemon-close resume
// path. Skips are visible with reasons, never silent early-returns.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/daemon.js";
import { JobRegistry } from "../src/registry.js";
import { JobdClient, JobdError } from "../src/client.js";
import { ipcPath, isAlive, isWindows, processIdentity } from "../src/platform.js";
import { nowIso, type JobRecord } from "../src/protocol.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Cross-platform long-running command (cmd.exe has no sleep binary).
const LONG = isWindows ? "ping -n 31 127.0.0.1 >nul" : "sleep 30";
const SLEEP_FIXTURE = fileURLToPath(new URL("./fixtures/sleep.mjs", import.meta.url));

const IS_LINUX = process.platform === "linux";
const LINUX_ONLY = IS_LINUX ? false : "needs Linux /proc (zombie state / stat parsing)";
const POSIX_ONLY = isWindows ? "POSIX signals only (SIGSTOP/SIGCONT semantics)" : false;

/** /proc state char (R/S/T/Z…); Linux-only observation helper. */
function procState(pid: number): string | undefined {
  if (!IS_LINUX) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  } catch {
    return undefined;
  }
}

const CI_SCALE = process.env.CI ? 3 : 1;

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000 * CI_SCALE): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("waitFor timed out");
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // best effort: a leftover temp dir must not fail the suite
  }
}

/** An innocent bystander process that must NEVER receive our signals. */
function spawnInnocent(): ChildProcess {
  return spawn(process.execPath, [SLEEP_FIXTURE, "30000"], { stdio: "ignore" });
}

function killPid(pid: number | undefined, ...rest: Array<number | undefined>): void {
  for (const p of [pid, ...rest]) {
    if (p === undefined) continue;
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Spawn a python3 helper that forks a child which exits immediately and is
 * never waited on: while the helper lives, that child is a REAL zombie. This
 * is what a container without a reaping init (pid 1 = app, not tini) leaves
 * behind. Killing the helper re-parents (and reaps) the zombie.
 */
async function spawnZombie(): Promise<{ holder: ChildProcess; zombiePid: number }> {
  const holder = spawn(
    "python3",
    ["-c", "import os,time\npid=os.fork()\nif pid==0: os._exit(0)\nprint(pid,flush=True)\ntime.sleep(60)"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const zombiePid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("zombie helper printed nothing")), 5_000 * CI_SCALE);
    holder.stdout!.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(Number.parseInt(chunk.toString().trim().split(/\s+/)[0] ?? "", 10));
    });
  });
  await waitFor(() => procState(zombiePid) === "Z");
  return { holder, zombiePid };
}

/** Write a crafted record directly into the registry (pre-daemon-start). */
function craftRecord(dir: string, partial: Partial<JobRecord> & { jobId: string }): JobRecord {
  const jobsDir = join(dir, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const identity = partial.pid !== undefined ? processIdentity(partial.pid) : undefined;
  const { jobId, ...overrides } = partial;
  const record: JobRecord = {
    jobId,
    owner: "alice",
    command: "sleep 30",
    commandHash: "crafted",
    cwd: process.cwd(),
    state: "running",
    pausable: false,
    createdAt: nowIso(),
    startedAt: nowIso(),
    logPath: join(jobsDir, `${jobId}.log`),
    ...(identity !== undefined ? { startToken: identity.startToken, bootId: identity.bootId } : {}),
    ...overrides,
  };
  writeFileSync(join(jobsDir, `${jobId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

interface Detached {
  client: JobdClient;
  daemonPid: number;
}

/** Start the REAL detached daemon (auto-start), then SIGKILL it: the only
 *  honest way to test adoption — an in-process close would keep the old
 *  child handle and its exit event alive. */
async function detachedDaemon(dir: string, socketPath: string): Promise<Detached> {
  const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: true });
  await client.ensure();
  const ping = await client.ping();
  return { client, daemonPid: Number(ping.pid) };
}

async function crashDaemon(daemonPid: number): Promise<void> {
  try {
    process.kill(daemonPid, "SIGKILL");
  } catch {
    // already gone
  }
  await waitFor(() => !isAlive(daemonPid), 3_000 * CI_SCALE);
}

/**
 * Spawn a python3 helper holding a LIVE child it will never reap if the
 * child dies first (no wait() call): the adoption-then-zombie sequence in
 * miniature — exactly what a container without a reaping init produces
 * when the original daemon crashed before reaping.
 */
async function spawnHeldChild(): Promise<{ holder: ChildProcess; childPid: number }> {
  const holder = spawn(
    "python3",
    ["-c", "import os,time\npid=os.fork()\nif pid==0:\n    time.sleep(60)\nprint(pid,flush=True)\ntime.sleep(60)"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const childPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("held-child helper printed nothing")), 5_000 * CI_SCALE);
    holder.stdout!.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(Number.parseInt(chunk.toString().trim().split(/\s+/)[0] ?? "", 10));
    });
  });
  await waitFor(() => isAlive(childPid));
  return { holder, childPid };
}

async function waitForAnchor(client: JobdClient, jobId: string): Promise<void> {
  await waitFor(async () => (await client.status(jobId))?.startToken !== undefined, 10_000 * CI_SCALE);
}

/** In-process successor daemon on a fresh endpoint (the crashed daemon's
 *  Windows pipe stays bound briefly; a fresh name sidesteps it everywhere). */
async function successorDaemon(dir: string): Promise<{ daemon: JobDaemon; client: JobdClient; socketPath: string }> {
  const socketPath = ipcPath(`test-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
  const daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice", stopGraceMs: 500 });
  await daemon.start();
  const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
  return { daemon, client, socketPath };
}

describe("adoption edge: pid-reuse signal guards (real processes)", () => {
  it("a reused pid is never SIGCONTed: resume re-proves identity and fails closed", { skip: POSIX_ONLY }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-reuse-resume-"));
    let innocent: ChildProcess | undefined;
    let d2: Awaited<ReturnType<typeof successorDaemon>> | undefined;
    try {
      const d1 = await detachedDaemon(dir, ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir }));
      const job = await d1.client.run({ command: LONG, pausable: true });
      await waitForAnchor(d1.client, job.jobId);
      await crashDaemon(d1.daemonPid);

      d2 = await successorDaemon(dir);
      const adopted = await d2.client.status(job.jobId);
      assert.equal(adopted?.adopted, true);
      const paused = await d2.client.pause(job.jobId);
      assert.equal(paused.status, "paused");

      // The race in miniature: the job dies and a stranger takes a record
      // pointing at it (pid + wrong start token = pid reuse). The registry
      // is file-backed, so editing the record on disk is exactly what a
      // crash-then-reuse world produces.
      const bystander = spawnInnocent();
      innocent = bystander;
      await waitFor(() => isAlive(bystander.pid!));
      const registry = new JobRegistry(dir);
      const record = registry.get(job.jobId)!;
      const realPid = record.pid;
      const strangerIdentity = processIdentity(bystander.pid!)!;
      record.pid = bystander.pid;
      record.startToken = `${strangerIdentity.startToken}0`; // one char off = reuse
      registry.save(record);

      await assert.rejects(
        d2.client.resume(job.jobId),
        (err: unknown) => err instanceof JobdError && err.code === "identity_mismatch",
      );
      assert.equal(registry.get(job.jobId)?.state, "lost");
      await waitFor(() => isAlive(bystander.pid!)); // no SIGCONT was delivered
      killPid(realPid);
    } finally {
      killPid(innocent?.pid);
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });

  it("a reused pid is never TERM/SIGKILLed: stop re-proves identity before every signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-reuse-stop-"));
    let innocent: ChildProcess | undefined;
    let d2: Awaited<ReturnType<typeof successorDaemon>> | undefined;
    try {
      const d1 = await detachedDaemon(dir, ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir }));
      const job = await d1.client.run({ command: LONG });
      await waitForAnchor(d1.client, job.jobId);
      await crashDaemon(d1.daemonPid);

      d2 = await successorDaemon(dir);
      assert.equal((await d2.client.status(job.jobId))?.adopted, true);

      const bystander = spawnInnocent();
      innocent = bystander;
      await waitFor(() => isAlive(bystander.pid!));
      const registry = new JobRegistry(dir);
      const record = registry.get(job.jobId)!;
      const realPid = record.pid;
      const strangerIdentity = processIdentity(bystander.pid!)!;
      record.pid = bystander.pid;
      record.startToken = `${strangerIdentity.startToken}0`;
      registry.save(record);

      await assert.rejects(
        d2.client.stop(job.jobId),
        (err: unknown) => err instanceof JobdError && err.code === "identity_mismatch",
      );
      await waitFor(() => isAlive(bystander.pid!)); // no TERM, no SIGKILL
      killPid(realPid);
    } finally {
      killPid(innocent?.pid);
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });
});

describe("adoption edge: zombies under a non-reaping init (containers)", () => {
  it("a zombie at daemon start is never adopted — already dead, not ours", { skip: LINUX_ONLY }, async () => {
    const { holder, zombiePid } = await spawnZombie();
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-zombie-load-"));
    let daemon: JobDaemon | undefined;
    try {
      craftRecord(dir, { jobId: "j_zombie_load", pid: zombiePid });
      const socketPath = ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
      daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice" });
      await daemon.start();
      assert.equal(daemon.registry.get("j_zombie_load")?.state, "lost", "a zombie has already exited; adopting it would be a lie");
    } finally {
      if (daemon !== undefined) await daemon.close();
      killPid(holder.pid);
      cleanupDir(dir);
    }
  });

  it("the adopted monitor treats a zombie as ended (exit code unknowable)", { skip: LINUX_ONLY }, async () => {
    const { holder, childPid } = await spawnHeldChild();
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-zombie-watch-"));
    let daemon: JobDaemon | undefined;
    try {
      // Adopt the job while it is genuinely alive, THEN let it die into a
      // zombie the holder never reaps — the monitor must notice.
      craftRecord(dir, { jobId: "j_zombie_watch", pid: childPid });
      const socketPath = ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
      daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice" });
      await daemon.start();
      assert.equal(daemon.registry.get("j_zombie_watch")?.adopted, true);
      killPid(childPid);
      await waitFor(() => procState(childPid) === "Z");
      await waitFor(() => daemon!.registry.get("j_zombie_watch")?.state === "exited", 4_000 * CI_SCALE);
      const ended = daemon.registry.get("j_zombie_watch");
      assert.equal(ended?.exitCode, null, "not our child: the outcome is unknowable, never invented");
    } finally {
      if (daemon !== undefined) await daemon.close();
      killPid(holder.pid);
      cleanupDir(dir);
    }
  });
});

describe("adoption edge: stop semantics for adopted jobs", () => {
  it("stopping a TERM-ignoring adopted job still ends stopped (SIGKILL re-proof path)", { skip: POSIX_ONLY }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-adopt-term-"));
    let d2: Awaited<ReturnType<typeof successorDaemon>> | undefined;
    let jobPid: number | undefined;
    try {
      const d1 = await detachedDaemon(dir, ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir }));
      // `exec` replaces the shell so the tracked pid IS the TERM-ignorer.
      const job = await d1.client.run({ command: `exec perl -e '$SIG{TERM}="IGNORE"; sleep 30'` });
      jobPid = job.pid;
      await waitForAnchor(d1.client, job.jobId);
      await crashDaemon(d1.daemonPid);

      d2 = await successorDaemon(dir);
      assert.equal((await d2.client.status(job.jobId))?.adopted, true);
      const stopped = await d2.client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
      if (stopped.killed) assert.equal(stopped.job.signal, "SIGKILL");
      await waitFor(() => !isAlive(jobPid!), 3_000 * CI_SCALE);
    } finally {
      killPid(jobPid);
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });

  it("stop of an adopted TERM-cooperating job settles within the grace, not the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-adopt-fast-"));
    let d2: Awaited<ReturnType<typeof successorDaemon>> | undefined;
    try {
      const d1 = await detachedDaemon(dir, ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir }));
      const job = await d1.client.run({ command: LONG });
      await waitForAnchor(d1.client, job.jobId);
      await crashDaemon(d1.daemonPid);

      d2 = await successorDaemon(dir);
      const started = Date.now();
      const stopped = await d2.client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
      assert.ok(Date.now() - started < 2_000, "an adopted job that honors TERM must not wait out the grace loop");
    } finally {
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });
});

describe("adoption edge: daemon close and paused jobs", () => {
  it("close() resumes a paused job — it must exit naturally afterwards, not stay frozen", { skip: POSIX_ONLY }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-close-resume-"));
    const socketPath = ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    const daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice", stopGraceMs: 500 });
    await daemon.start();
    const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
    try {
      // sleep 1: if close() failed to SIGCONT, the job stays frozen forever
      // and never reaches "exited" — the natural exit IS the proof.
      const job = await client.run({ command: "sleep 1", pausable: true });
      assert.equal((await client.pause(job.jobId)).status, "paused");
      await daemon.close();
      await waitFor(() => daemon.registry.get(job.jobId)?.state === "exited", 5_000);
      assert.equal(daemon.registry.get(job.jobId)?.exitCode, 0);
    } finally {
      await daemon.close();
      cleanupDir(dir);
    }
  });

  it("close() resumes a job that was paused AFTER adoption (identity re-proven)", { skip: POSIX_ONLY }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-close-adopt-"));
    let d2: Awaited<ReturnType<typeof successorDaemon>> | undefined;
    try {
      const d1 = await detachedDaemon(dir, ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir }));
      const job = await d1.client.run({ command: LONG, pausable: true });
      await waitForAnchor(d1.client, job.jobId);
      assert.equal((await d1.client.pause(job.jobId)).status, "paused");
      await crashDaemon(d1.daemonPid);

      d2 = await successorDaemon(dir);
      const adopted = await d2.client.status(job.jobId);
      assert.equal(adopted?.state, "paused", "adoption keeps the paused state (no silent SIGCONT)");
      assert.equal(adopted?.adopted, true);
      await d2.daemon.close();
      const record = d2.daemon.registry.get(job.jobId);
      assert.equal(record?.state, "running", "close must never leave a job SIGSTOPed forever");
      killPid(job.pid);
    } finally {
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });

  it("an adopted job that disappears while paused is lost, never resumed", { skip: POSIX_ONLY }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-adopt-gone-"));
    let d2: Awaited<ReturnType<typeof successorDaemon>> | undefined;
    try {
      const d1 = await detachedDaemon(dir, ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir }));
      const job = await d1.client.run({ command: LONG, pausable: true });
      await waitForAnchor(d1.client, job.jobId);
      assert.equal((await d1.client.pause(job.jobId)).status, "paused");
      await crashDaemon(d1.daemonPid);
      killPid(job.pid); // dies while nobody watches

      d2 = await successorDaemon(dir);
      await assert.rejects(
        d2.client.resume(job.jobId),
        (err: unknown) => err instanceof JobdError && err.code === "identity_mismatch",
      );
      assert.equal(d2.daemon.registry.get(job.jobId)?.state, "lost");
    } finally {
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });
});

describe("adoption edge: unprovable records", () => {
  it("a record without an identity anchor is lost after a restart, never adopted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-no-anchor-"));
    let daemon: JobDaemon | undefined;
    try {
      // v1-era shape: pid only, no startToken/bootId (or a spawn whose
      // identity capture never landed before the crash).
      craftRecord(dir, { jobId: "j_no_anchor", pid: process.pid, startToken: undefined, bootId: undefined });
      const socketPath = ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
      daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice" });
      await daemon.start();
      const record = daemon.registry.get("j_no_anchor");
      assert.equal(record?.state, "lost");
      assert.equal(record?.exitCode, null);
    } finally {
      if (daemon !== undefined) await daemon.close();
      cleanupDir(dir);
    }
  });
});
