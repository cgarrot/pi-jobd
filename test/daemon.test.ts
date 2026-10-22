// test/daemon.test.ts — real processes, real signals, real socket.
// The daemon runs IN-PROCESS here (the CLI test covers the detached spawn).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/daemon.js";
import { JobRegistry } from "../src/registry.js";
import { JobdClient } from "../src/client.js";
import { ipcPath, isAlive, isWindows } from "../src/platform.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Cross-platform long-running commands: `sleep` does not exist in cmd.exe.
const LONG = isWindows ? "ping -n 31 127.0.0.1 >nul" : "sleep 10";
const ECHO_FIXTURE = fileURLToPath(new URL("../../test/fixtures/echo.mjs", import.meta.url));
const LONG_ECHO = isWindows ? `"${process.execPath}" "${ECHO_FIXTURE}" hello-job 10000` : "echo hello-job; sleep 10";
const SHORT = isWindows ? "ping -n 11 127.0.0.1 >nul" : "sleep 1";

interface Harness {
  dir: string;
  socketPath: string;
  daemon: JobDaemon;
  client: JobdClient;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pi-jobd-daemon-"));
  const socketPath = ipcPath(`test-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
  const daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice", stopGraceMs: 500 });
  await daemon.start();
  const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
  const close = async (): Promise<void> => {
    await daemon.close();
    cleanupDir(dir);
  };
  return { dir, socketPath, daemon, client, close };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("waitFor timed out");
}

/** Windows can keep the log/registry handles busy for a few ms after a kill. */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // best effort: a leftover temp dir must not fail the suite
  }
}

describe("daemon: run / status / log / stop", () => {
  it("runs a detached job, reports it, tails its log, and stops it", async () => {
    const h = await harness();
    try {
      const job = await h.client.run({ command: LONG_ECHO });
      assert.equal(job.state, "running");
      assert.ok(job.pid !== undefined);
      await waitFor(() => isAlive(job.pid!));
      // A loaded CI runner can take >200 ms to start bash and flush echo.
      let log = await h.client.log(job.jobId, 5);
      await waitFor(async () => {
        log = await h.client.log(job.jobId, 5);
        return log.lines.join("\n").includes("hello-job");
      }, 4_000);
      assert.match(log.lines.join("\n"), /hello-job/);

      const status = await h.client.status(job.jobId);
      assert.equal(status?.state, "running");
      assert.equal(status?.owner, "alice");

      const stopped = await h.client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
      await waitFor(() => !isAlive(job.pid!));
    } finally {
      await h.close();
    }
  });

  it("records a natural exit honestly (exitCode 0)", async () => {
    const h = await harness();
    try {
      const job = await h.client.run({ command: "exit 0" });
      await waitFor(() => h.daemon.registry.get(job.jobId)?.state === "exited");
      const status = await h.client.status(job.jobId);
      assert.equal(status?.state, "exited");
      assert.equal(status?.exitCode, 0);
    } finally {
      await h.close();
    }
  });

  it("a failing job is failed, not exited", async () => {
    const h = await harness();
    try {
      const job = await h.client.run({ command: "exit 7" });
      await waitFor(() => h.daemon.registry.get(job.jobId)?.state === "failed");
      const status = await h.client.status(job.jobId);
      assert.equal(status?.state, "failed");
      assert.equal(status?.exitCode, 7);
    } finally {
      await h.close();
    }
  });

  it("list returns jobs in creation order (newest first)", async () => {
    const h = await harness();
    try {
      const a = await h.client.run({ command: LONG });
      await sleep(20);
      const b = await h.client.run({ command: LONG });
      const jobs = await h.client.list();
      assert.deepEqual(jobs.map((j) => j.jobId).slice(0, 2), [b.jobId, a.jobId]);
      await h.client.stop(a.jobId);
      await h.client.stop(b.jobId);
    } finally {
      await h.close();
    }
  });
});

describe("daemon: pause / resume / stop escalation", () => {
  it("pauses and resumes a pausable job (POSIX), refuses a non-pausable one", async () => {
    const h = await harness();
    try {
      const pausable = await h.client.run({ command: LONG, pausable: true });
      if (isWindows) {
        const paused = await h.client.pause(pausable.jobId);
        assert.equal(paused.status, "not_supported");
      } else {
        const paused = await h.client.pause(pausable.jobId);
        assert.equal(paused.status, "paused");
        assert.equal(h.daemon.registry.get(pausable.jobId)?.state, "paused");
        const resumed = await h.client.resume(pausable.jobId);
        assert.equal(resumed.status, "resumed");
        assert.equal(h.daemon.registry.get(pausable.jobId)?.state, "running");
      }
      const plain = await h.client.run({ command: LONG });
      const refused = await h.client.pause(plain.jobId);
      assert.equal(refused.status, "not_pausable");
      await h.client.stop(plain.jobId);
      await h.client.stop(pausable.jobId);
    } finally {
      await h.close();
    }
  });

  it("stops a paused job (SIGCONT first, never leaves it frozen)", async () => {
    if (isWindows) return; // pause is POSIX-only
    const h = await harness();
    try {
      const job = await h.client.run({ command: LONG, pausable: true });
      await h.client.pause(job.jobId);
      const stopped = await h.client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
      await waitFor(() => !isAlive(job.pid!));
    } finally {
      await h.close();
    }
  });

  it("escalates to SIGKILL for a TERM-ignoring job (POSIX)", async () => {
    if (isWindows) return; // cmd.exe has no SIGTERM/SIGKILL semantics
    const h = await harness();
    try {
      const job = await h.client.run({ command: "trap '' TERM; sleep 10" });
      await sleep(100);
      const stopped = await h.client.stop(job.jobId);
      assert.equal(stopped.killed, true);
      assert.equal(stopped.job.signal, "SIGKILL");
      await waitFor(() => !isAlive(job.pid!));
    } finally {
      await h.close();
    }
  });
});

describe("daemon: adoption after a real daemon crash", () => {
  /** Start the REAL detached daemon (the client spawns it), then SIGKILL it:
   *  this is the only honest way to test adoption — an in-process close would
   *  keep the old child handle and its exit event alive. */
  async function detached(dir: string, socketPath: string): Promise<{ client: JobdClient; daemonPid: number }> {
    const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: true });
    await client.ensure();
    const ping = await client.ping();
    return { client, daemonPid: Number(ping.pid) };
  }

  async function crash(daemonPid: number): Promise<void> {
    try {
      process.kill(daemonPid, "SIGKILL");
    } catch {
      // already gone
    }
    await waitFor(() => {
      try {
        process.kill(daemonPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3_000);
  }

  async function waitAdoptable(client: JobdClient, jobId: string): Promise<void> {
    await waitFor(async () => (await client.status(jobId))?.startToken !== undefined, 10_000);
  }

  async function secondDaemon(dir: string, socketPath: string): Promise<{ daemon: JobDaemon; client: JobdClient }> {
    const daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice", stopGraceMs: 500 });
    await daemon.start();
    const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
    return { daemon, client };
  }

  it("adopts a running job when pid+start token+boot id match, and can stop it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-adopt-"));
    const socketPath = ipcPath(`test-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    let jobPid: number | undefined;
    let d2: { daemon: JobDaemon; client: JobdClient } | undefined;
    try {
      const d1 = await detached(dir, socketPath);
      const job = await d1.client.run({ command: LONG });
      jobPid = job.pid;
      assert.ok(jobPid !== undefined);
      await waitAdoptable(d1.client, job.jobId);
      await crash(d1.daemonPid);

      const socket2 = ipcPath(`test2-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
      d2 = await secondDaemon(dir, socket2);
      const adopted = await d2.client.status(job.jobId);
      assert.equal(adopted?.state, "running");
      assert.equal(adopted?.adopted, true);
      assert.match(adopted?.note ?? "", /identity verified/);
      assert.equal(isAlive(jobPid), true);
      const stopped = await d2.client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
      await waitFor(() => !isAlive(jobPid!));
    } finally {
      if (jobPid !== undefined && isAlive(jobPid)) {
        try {
          process.kill(jobPid, "SIGKILL");
        } catch {
          // gone
        }
      }
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });

  it("a tampered identity is lost and stop REFUSES to signal the pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-adopt-"));
    const socketPath = ipcPath(`test-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    let jobPid: number | undefined;
    let d2: { daemon: JobDaemon; client: JobdClient } | undefined;
    try {
      const d1 = await detached(dir, socketPath);
      const job = await d1.client.run({ command: LONG });
      jobPid = job.pid;
      assert.ok(jobPid !== undefined);
      await waitAdoptable(d1.client, job.jobId);
      await crash(d1.daemonPid);

      // Simulate pid reuse: the record's start token no longer matches the pid.
      const registry = new JobRegistry(dir);
      const record = registry.get(job.jobId);
      assert.ok(record !== undefined);
      record.startToken = "reused-pid-token";
      registry.save(record);

      const socket2 = ipcPath(`test2-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
      d2 = await secondDaemon(dir, socket2);
      const lost = await d2.client.status(job.jobId);
      assert.equal(lost?.state, "lost");
      assert.equal(lost?.exitCode, null);
      await assert.rejects(d2.client.stop(job.jobId), /identity|refusing|unproven/);
      assert.equal(isAlive(jobPid), true, "an unproven pid must still be alive — we never signalled it");
    } finally {
      if (jobPid !== undefined && isAlive(jobPid)) {
        try {
          process.kill(jobPid, "SIGKILL");
        } catch {
          // gone
        }
      }
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });

  it("keeps a PAUSED job paused after adoption; resume then works", async () => {
    if (isWindows) return; // pause is POSIX-only
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-adopt-"));
    const socketPath = ipcPath(`test-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    let jobPid: number | undefined;
    let d2: { daemon: JobDaemon; client: JobdClient } | undefined;
    try {
      const d1 = await detached(dir, socketPath);
      const job = await d1.client.run({ command: LONG, pausable: true });
      jobPid = job.pid;
      assert.ok(jobPid !== undefined);
      const paused = await d1.client.pause(job.jobId);
      assert.equal(paused.status, "paused");
      await waitAdoptable(d1.client, job.jobId);
      await crash(d1.daemonPid);

      const socket2 = ipcPath(`test2-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
      d2 = await secondDaemon(dir, socket2);
      const adopted = await d2.client.status(job.jobId);
      assert.equal(adopted?.state, "paused", "adoption must not silently SIGCONT");
      assert.equal(adopted?.adopted, true);
      const resumed = await d2.client.resume(job.jobId);
      assert.equal(resumed.status, "resumed");
      const stopped = await d2.client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
      await waitFor(() => !isAlive(jobPid!));
    } finally {
      if (jobPid !== undefined && isAlive(jobPid)) {
        try {
          process.kill(jobPid, "SIGKILL");
        } catch {
          // gone
        }
      }
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });

  it("an adopted process that ends is exited with an unknowable exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-adopt-"));
    const socketPath = ipcPath(`test-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    let d2: { daemon: JobDaemon; client: JobdClient } | undefined;
    try {
      const d1 = await detached(dir, socketPath);
      const job = await d1.client.run({ command: SHORT });
      assert.ok(job.pid !== undefined);
      await waitAdoptable(d1.client, job.jobId);
      await crash(d1.daemonPid);

      const socket2 = ipcPath(`test2-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
      d2 = await secondDaemon(dir, socket2);
      const adopted = await d2.client.status(job.jobId);
      assert.equal(adopted?.state, "running");
      assert.equal(adopted?.adopted, true);
      // The monitor polls every 2 s; give it one poll plus slack.
      await waitFor(() => d2!.daemon.registry.get(job.jobId)?.state === "exited", 5_000);
      const ended = await d2.client.status(job.jobId);
      assert.equal(ended?.state, "exited");
      assert.equal(ended?.exitCode, null, "not our child: exit code is unknowable, never invented");
      assert.match(ended?.note ?? "", /unknowable/);
    } finally {
      if (d2 !== undefined) await d2.daemon.close();
      cleanupDir(dir);
    }
  });
});
