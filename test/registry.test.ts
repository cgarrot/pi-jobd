// test/registry.test.ts — one JSON file per job; a daemon restart is
// fail-closed (running/paused -> lost with an honest unknown exit code).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobRegistry } from "../src/registry.js";
import { nowIso, sha256, type JobRecord } from "../src/protocol.js";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "pi-jobd-registry-"));
}

function record(jobId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId,
    owner: "alice",
    command: "sleep 1",
    commandHash: sha256("sleep 1"),
    cwd: "/tmp",
    state: "running",
    pausable: false,
    createdAt: nowIso(),
    logPath: `/tmp/${jobId}.log`,
    ...overrides,
  };
}

describe("registry: atomic persistence", () => {
  it("save -> get -> list roundtrip", () => {
    const dir = tempState();
    try {
      const reg = new JobRegistry(dir);
      reg.save(record("j_1"));
      reg.save(record("j_2", { state: "exited", exitCode: 0, endedAt: nowIso() }));
      assert.equal(reg.get("j_1")?.owner, "alice");
      assert.deepEqual(reg.list().map((j) => j.jobId).sort(), ["j_1", "j_2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupt record is skipped, never fatal", () => {
    const dir = tempState();
    try {
      const reg = new JobRegistry(dir);
      reg.save(record("j_ok"));
      // Simulate a half-written file (the atomic rename prevents this, but a
      // disk/partial restore must not take the whole list down).
      writeFileSync(join(reg.jobsDir, "j_bad.json"), "{not-json", "utf8");
      assert.deepEqual(reg.list().map((j) => j.jobId), ["j_ok"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry: restart is fail-closed", () => {
  it("running and paused jobs become lost with exitCode=null", () => {
    const dir = tempState();
    try {
      const reg = new JobRegistry(dir);
      reg.save(record("j_run", { state: "running", pid: 123 }));
      reg.save(record("j_pause", { state: "paused", pid: 124 }));
      reg.save(record("j_done", { state: "exited", exitCode: 0, endedAt: nowIso() }));
      const lost = reg.markLostOnStart();
      assert.deepEqual(lost.map((j) => j.jobId).sort(), ["j_pause", "j_run"]);
      for (const job of lost) {
        assert.equal(job.state, "lost");
        assert.equal(job.exitCode, null);
        assert.match(job.note ?? "", /no adoption/);
      }
      assert.equal(reg.get("j_done")?.state, "exited", "terminal jobs are untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
