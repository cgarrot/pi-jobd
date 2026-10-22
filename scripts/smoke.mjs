#!/usr/bin/env node
// scripts/smoke.mjs — user-facing E2E for `pijob` (no model, no network).
// Proves: auto-start, immediate return, log tail, pause/resume, stop, and the
// honest daemon-restart `lost` state.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "pi-jobd-smoke-"));
const env = { ...process.env, PI_JOBD_STATE_DIR: stateDir };
const isWindows = process.platform === "win32";
const LONG = isWindows ? "ping -n 61 127.0.0.1 >nul" : "sleep 60";
const ECHO_JOB = isWindows ? "echo smoke-ok & ping -n 31 127.0.0.1 >nul" : "echo smoke-ok; sleep 30";
let passed = 0;
let failed = 0;

function run(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000, env });
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "" };
}

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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("pi-jobd smoke");
  console.log(`state: ${stateDir}`);
  try {
    console.log("[1] doctor before any job");
    await check("daemon not running yet", () => {
      const r = run(["doctor"]);
      assert(r.code === 0, r.err);
      assert(/not running/.test(r.out), r.out);
    });

    console.log("[2] run returns immediately");
    let jobId;
    await check("run acks in < 2s", () => {
      const t0 = Date.now();
      const r = run(["run", ECHO_JOB, "--pausable"]);
      const ms = Date.now() - t0;
      assert(r.code === 0, r.err);
      const m = /started (j_[A-Za-z0-9_]+)/.exec(r.out);
      assert(m, r.out);
      jobId = m[1];
      assert(ms < 2000, `run took ${ms}ms`);
    });

    console.log("[3] status + log");
    await check("job is running", () => {
      const r = run(["status", jobId, "--json"]);
      assert(r.code === 0, r.err);
      assert(JSON.parse(r.out).state === "running", r.out);
    });
    await sleep(300);
    await check("log has the echo output", () => {
      const r = run(["log", jobId, "--lines", "5"]);
      assert(r.code === 0, r.err);
      assert(r.out.includes("smoke-ok"), r.out);
    });

    console.log("[4] pause / resume");
    if (isWindows) {
      await check("pause is honestly not_supported on win32", () => {
        const r = run(["pause", jobId]);
        assert(r.out.includes("not_supported"), r.out);
      });
    } else {
      await check("pause", () => {
        const r = run(["pause", jobId]);
        assert(r.code === 0, r.err);
        assert(r.out.includes("paused"), r.out);
      });
      await check("resume", () => {
        const r = run(["resume", jobId]);
        assert(r.code === 0, r.err);
        assert(r.out.includes("resumed"), r.out);
      });
    }

    console.log("[5] stop");
    await check("stop terminates the job", () => {
      const r = run(["stop", jobId]);
      assert(r.code === 0, r.err);
      assert(/stopped|killed/.test(r.out), r.out);
    });
    await check("status is terminal", () => {
      const r = run(["status", jobId, "--json"]);
      assert(JSON.parse(r.out).state === "stopped", r.out);
    });

    console.log("[6] daemon restart ADOPTS a verifiable job");
    let adoptedJobId;
    let adoptedPid;
    await check("start a long job", () => {
      const r = run(["run", LONG]);
      const m = /started (j_[A-Za-z0-9_]+)/.exec(r.out);
      assert(m, r.out);
      adoptedJobId = m[1];
      adoptedPid = JSON.parse(run(["status", adoptedJobId, "--json"]).out).pid;
    });
    run(["daemon", "stop"]);
    await sleep(500);
    await check("the job is adopted, not lost", () => {
      const job = JSON.parse(run(["status", adoptedJobId, "--json"]).out);
      assert(job.state === "running", JSON.stringify(job));
      assert(job.adopted === true, "adopted flag missing");
    });
    await check("an adopted job can be stopped", () => {
      const r = run(["stop", adoptedJobId]);
      assert(r.code === 0, r.err);
      assert(/stopped|killed/.test(r.out), r.out);
    });
    try {
      process.kill(adoptedPid, "SIGKILL");
    } catch {
      // already gone
    }

    console.log("[7] a tampered identity is LOST (never signalled)");
    let lostJobId;
    let lostPid;
    await check("start a long job", () => {
      const r = run(["run", LONG]);
      const m = /started (j_[A-Za-z0-9_]+)/.exec(r.out);
      assert(m, r.out);
      lostJobId = m[1];
      lostPid = JSON.parse(run(["status", lostJobId, "--json"]).out).pid;
    });
    run(["daemon", "stop"]);
    await sleep(500);
    // Simulate pid reuse: the stored start token no longer matches the pid.
    const recordPath = join(stateDir, "jobs", `${lostJobId}.json`);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.startToken = "pid-reused";
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
    await check("the job is lost, not stopped", () => {
      const job = JSON.parse(run(["status", lostJobId, "--json"]).out);
      assert(job.state === "lost", JSON.stringify(job));
      assert(job.exitCode === null, "lost must have an unknown exit code");
    });
    await check("the OS process is still alive (we never signalled it)", () => {
      try {
        process.kill(lostPid, 0);
      } catch {
        throw new Error("orphan process disappeared");
      }
    });
    try {
      process.kill(lostPid, "SIGKILL");
    } catch {
      // already gone
    }
  } finally {
    run(["daemon", "stop"]);
    rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE CRASHED:", err);
  run(["daemon", "stop"]);
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(1);
});
