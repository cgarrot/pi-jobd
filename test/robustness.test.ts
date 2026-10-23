// test/robustness.test.ts — protocol and lifecycle edges that must never
// crash either side. Ported from the pi-mesh job-runner test assets
// (cgarrot/pi-mesh PR #11): a missing endpoint must reject (not kill the
// caller), garbage on the socket must not kill the daemon, pause/resume
// answer idempotently, and an externally killed paused job records its real
// ending instead of staying "paused" forever.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/daemon.js";
import { JobdClient, JobdError } from "../src/client.js";
import { ipcPath, isAlive, isWindows } from "../src/platform.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LONG = isWindows ? "ping -n 31 127.0.0.1 >nul" : "sleep 30";
const POSIX_ONLY = isWindows ? "POSIX signals only (SIGSTOP/SIGCONT semantics)" : false;

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
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
    // best effort
  }
}

describe("robustness: client and protocol edges", () => {
  it("a missing endpoint rejects with unreachable — the caller process survives", async () => {
    const dir = join(tmpdir(), `pi-jobd-no-endpoint-${randomBytes(4).toString("hex")}`);
    const socketPath = ipcPath(`ghost-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
    await assert.rejects(
      client.ping(),
      (err: unknown) => err instanceof JobdError && (err.code === "unreachable" || err.code === "timeout"),
    );
    // The suite reaching the next assertion is itself the regression test:
    // a socket error must reject the request, never crash the caller.
    assert.ok(true);
  });

  it("garbage NDJSON on the socket never kills the daemon; the next request works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-garbage-"));
    const socketPath = ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    const daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice" });
    await daemon.start();
    const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
    try {
      const socket = net.createConnection(socketPath);
      await new Promise<void>((resolveConnect, rejectConnect) => {
        socket.once("connect", resolveConnect);
        socket.once("error", rejectConnect);
      });
      socket.write("this is not json\n");
      socket.write("{ broken\n");
      socket.end();
      // The daemon may or may not answer garbage (silently skipping it is a
      // valid design); the invariant is that it is still alive afterwards.
      const ping = await client.ping();
      assert.ok(ping.version !== undefined);
    } finally {
      await daemon.close();
      cleanupDir(dir);
    }
  });
});

describe("robustness: pause lifecycle edges", () => {
  it("a second pause answers not_running (pi-jobd semantics); resume of a non-paused job says not_paused", { skip: POSIX_ONLY }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-pause-idem-"));
    const socketPath = ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    const daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice", stopGraceMs: 500 });
    await daemon.start();
    const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
    try {
      const job = await client.run({ command: LONG, pausable: true });
      assert.equal((await client.pause(job.jobId)).status, "paused");
      // pi-jobd maps an already-paused job to not_running (the record still
      // says paused) — pi-mesh's jobd was idempotent here; his enum wins.
      assert.equal((await client.pause(job.jobId)).status, "not_running");
      assert.equal(daemon.registry.get(job.jobId)?.state, "paused");
      assert.equal((await client.resume(job.jobId)).status, "resumed");
      assert.equal((await client.resume(job.jobId)).status, "not_paused");
      const stopped = await client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
    } finally {
      await daemon.close();
      cleanupDir(dir);
    }
  });

  it("an externally killed paused job records its real ending, never stays paused", { skip: POSIX_ONLY }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-pause-killed-"));
    const socketPath = ipcPath(`t-${randomBytes(4).toString("hex")}`, { ...process.env, PI_JOBD_STATE_DIR: dir });
    const daemon = new JobDaemon({ socketPath, stateDir: dir, owner: "alice", stopGraceMs: 500 });
    await daemon.start();
    const client = new JobdClient({ stateDir: dir, socketPath, owner: "alice", autoStart: false });
    try {
      const job = await client.run({ command: LONG, pausable: true });
      assert.equal((await client.pause(job.jobId)).status, "paused");
      try {
        process.kill(-job.pid!, "SIGKILL");
      } catch {
        process.kill(job.pid!, "SIGKILL");
      }
      await waitFor(() => {
        const state = daemon.registry.get(job.jobId)?.state;
        return state === "failed" || state === "stopped";
      }, 5_000);
      const ended = daemon.registry.get(job.jobId);
      assert.notEqual(ended?.state, "paused");
      assert.equal(isAlive(job.pid!), false);
    } finally {
      await daemon.close();
      cleanupDir(dir);
    }
  });
});
