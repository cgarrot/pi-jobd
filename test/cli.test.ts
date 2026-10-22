// test/cli.test.ts — the user-facing `pijob` flow, including the detached
// auto-start (the daemon test runs it in-process; this one proves the CLI can
// find/spawn it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const isWindows = process.platform === "win32";
const ECHO_JOB = isWindows ? "echo cli-ok & ping -n 6 127.0.0.1 >nul" : "echo cli-ok; sleep 5";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function run(args: string[], stateDir: string): { code: number | null; out: string; err: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PI_JOBD_STATE_DIR: stateDir },
  });
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "" };
}

describe("cli: doctor + run + status + stop (auto-start)", () => {
  it("auto-starts the daemon, runs a job, reports it, stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-cli-"));
    try {
      const before = run(["doctor"], dir);
      assert.equal(before.code, 0, before.err);
      assert.match(before.out, /not running/);

      const started = run(["run", ECHO_JOB], dir);
      assert.equal(started.code, 0, started.err);
      const match = /started (j_[A-Za-z0-9_]+)/.exec(started.out);
      assert.ok(match, started.out);
      const jobId = match[1]!;

      const listed = run(["list", "--json"], dir);
      assert.equal(listed.code, 0, listed.err);
      const jobs = JSON.parse(listed.out) as Array<{ jobId: string; state: string }>;
      assert.ok(jobs.some((job) => job.jobId === jobId));

      const status = run(["status", jobId, "--json"], dir);
      assert.equal(status.code, 0, status.err);
      const job = JSON.parse(status.out) as { state: string; pid?: number };
      assert.equal(job.state, "running");

      const stopped = run(["stop", jobId], dir);
      assert.equal(stopped.code, 0, stopped.err);
      assert.match(stopped.out, /stopped|killed/);

      const after = run(["status", jobId, "--json"], dir);
      assert.equal((JSON.parse(after.out) as { state: string }).state, "stopped");
    } finally {
      run(["daemon", "stop"], dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
