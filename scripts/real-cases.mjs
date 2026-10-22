#!/usr/bin/env node
// scripts/real-cases.mjs — real-world jobd cases (no mocks).
// Run after `npm run build`. Leaves no daemon/job behind.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { JobdClient } from "../dist/src/client.js";
import { isAlive } from "../dist/src/platform.js";

const isWindows = process.platform === "win32";
const LONG = isWindows ? "ping -n 11 127.0.0.1 >nul" : "sleep 10";
const LONG_ECHO = isWindows ? `node -e "console.log('case-ok');setTimeout(()=>{},10000)"` : "echo case-ok; sleep 10";
const SHORT = isWindows ? "ping -n 2 127.0.0.1 >nul" : "sleep 1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = mkdtempSync(join(tmpdir(), "pi-jobd-real-"));
process.env.PI_JOBD_STATE_DIR = stateDir;

let passed = 0;
let failed = 0;
const pids = new Set();

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function remember(job) {
  if (job.pid !== undefined) pids.add(job.pid);
  return job;
}

async function waitFor(fn, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error("waitFor timeout");
}

async function restartDaemon(client) {
  const ping = await client.ping();
  const pid = Number(ping.pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await waitFor(() => !isAlive(pid));
  const next = new JobdClient({ stateDir });
  await next.ensure();
  return next;
}

async function main() {
  console.log("pi-jobd real cases");
  console.log(`state: ${stateDir}`);
  let client = new JobdClient({ stateDir });

  await check("log tail + natural exit", async () => {
    const job = remember(await client.run({ command: "echo case-ok" }));
    await waitFor(() => client.status(job.jobId).then((j) => j?.state === "exited"));
    const log = await client.log(job.jobId, 3);
    assert.match(log.lines.join("\n"), /case-ok/);
  });

  await check("5 concurrent jobs, list, stop all", async () => {
    const jobs = [];
    for (let i = 0; i < 5; i += 1) jobs.push(remember(await client.run({ command: LONG })));
    const list = await client.list();
    const ids = new Set(jobs.map((j) => j.jobId));
    assert.ok(list.filter((j) => ids.has(j.jobId)).length === 5);
    for (const job of jobs) await client.stop(job.jobId);
    for (const job of jobs) await waitFor(() => !isAlive(job.pid));
  });

  if (!isWindows) {
    await check("TERM-ignoring job escalates to SIGKILL", async () => {
      const job = remember(await client.run({ command: "trap '' TERM; sleep 10" }));
      await sleep(100);
      const stopped = await client.stop(job.jobId);
      assert.equal(stopped.killed, true);
      assert.equal(stopped.job.signal, "SIGKILL");
      await waitFor(() => !isAlive(job.pid));
    });
  }

  if (!isWindows) {
    await check("pause (state T) / resume / stop a paused job", async () => {
      const job = remember(await client.run({ command: LONG, pausable: true }));
      const paused = await client.pause(job.jobId);
      assert.equal(paused.status, "paused");
      const stat = execFileSync("ps", ["-o", "stat=", "-p", String(job.pid)], { encoding: "utf8" }).trim();
      assert.match(stat, /^T/);
      const resumed = await client.resume(job.jobId);
      assert.equal(resumed.status, "resumed");
      const stopped = await client.stop(job.jobId);
      assert.equal(stopped.job.state, "stopped");
    });
  }

  await check("real daemon SIGKILL -> restart ADOPTS the running job", async () => {
    const job = remember(await client.run({ command: LONG }));
    client = await restartDaemon(client);
    const adopted = await client.status(job.jobId);
    assert.equal(adopted?.state, "running");
    assert.equal(adopted?.adopted, true);
    assert.equal(isAlive(job.pid), true);
    const stopped = await client.stop(job.jobId);
    assert.equal(stopped.job.state, "stopped");
  });

  if (!isWindows) {
    await check("real daemon SIGKILL -> a PAUSED job stays paused after adoption", async () => {
      const job = remember(await client.run({ command: LONG, pausable: true }));
      await client.pause(job.jobId);
      client = await restartDaemon(client);
      const adopted = await client.status(job.jobId);
      assert.equal(adopted?.state, "paused");
      assert.equal(adopted?.adopted, true);
      const resumed = await client.resume(job.jobId);
      assert.equal(resumed.status, "resumed");
      await client.stop(job.jobId);
    });
  }

  await check("tampered identity -> lost + stop refuses + process untouched", async () => {
    const job = remember(await client.run({ command: LONG }));
    client = await restartDaemon(client);
    // Simulate pid reuse after the restart check: tamper then restart again.
    client = await restartDaemon(client);
    const recordPath = join(stateDir, "jobs", `${job.jobId}.json`);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.startToken = "pid-reused";
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
    client = await restartDaemon(client);
    const lost = await client.status(job.jobId);
    assert.equal(lost?.state, "lost");
    assert.equal(lost?.exitCode, null);
    await assert.rejects(client.stop(job.jobId), /identity|refusing|unproven/);
    assert.equal(isAlive(job.pid), true, "the unproven process must still be alive");
    try {
      process.kill(job.pid, "SIGKILL");
    } catch {
      // gone
    }
  });

  await check("REDACT_COMMAND=1 persists only the hash", async () => {
    const redactedState = mkdtempSync(join(tmpdir(), "pi-jobd-real-redact-"));
    const previous = process.env.PI_JOBD_REDACT_COMMAND;
    process.env.PI_JOBD_REDACT_COMMAND = "1";
    const redacted = new JobdClient({ stateDir: redactedState });
    try {
      const job = await redacted.run({ command: "echo super-secret-token" });
      const status = await redacted.status(job.jobId);
      assert.equal(status?.command, "<redacted>");
      assert.notEqual(status?.commandHash, "");
      await redacted.stop(job.jobId);
    } finally {
      await redacted.shutdown();
      if (previous === undefined) delete process.env.PI_JOBD_REDACT_COMMAND;
      else process.env.PI_JOBD_REDACT_COMMAND = previous;
      rmSync(redactedState, { recursive: true, force: true });
    }
  });

  await check("daemon stop leaves jobs running (then clean up)", async () => {
    const job = remember(await client.run({ command: LONG }));
    await client.shutdown();
    await sleep(300);
    assert.equal(isAlive(job.pid), true, "daemon shutdown must not kill work");
    // The job survives; kill it manually (the point of the case).
    try {
      process.kill(job.pid, "SIGKILL");
    } catch {
      // gone
    }
    client = new JobdClient({ stateDir });
    await client.ensure(); // restart for the rest of the run
  });

  await client.shutdown();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("CRASHED:", err);
  try {
    await new JobdClient({ stateDir }).shutdown();
  } catch {
    // ignore
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(1);
});
