/**
 * src/registry.ts — one JSON file per job under <stateDir>/jobs.
 *
 * Why files (not a single index): a crash mid-write can corrupt one record,
 * never the whole table; the atomic tmp+rename keeps a reader from observing a
 * half-written job. Jobs are the unit of truth, so a lost record never claims
 * a job is dead (the OS process may still be alive and is reported `lost`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_LIST_JOBS, TERMINAL_RECORD_TTL_MS } from "./limits.js";
import { isTerminal, nowIso, type JobRecord } from "./protocol.js";

export class JobRegistry {
  readonly jobsDir: string;

  constructor(readonly stateDir: string) {
    this.jobsDir = join(stateDir, "jobs");
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
  }

  pathFor(jobId: string): string {
    return join(this.jobsDir, `${jobId}.json`);
  }

  private readFile(file: string): JobRecord | undefined {
    try {
      const raw = JSON.parse(readFileSync(join(this.jobsDir, file), "utf8")) as JobRecord;
      if (typeof raw.jobId !== "string" || typeof raw.state !== "string") return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  get(jobId: string): JobRecord | undefined {
    return this.readFile(`${jobId}.json`);
  }

  loadAll(): JobRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.jobsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const out: JobRecord[] = [];
    for (const name of names) {
      const job = this.readFile(name);
      if (job !== undefined) out.push(job);
    }
    return out;
  }

  save(job: JobRecord): void {
    const target = this.pathFor(job.jobId);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  }

  remove(jobId: string): void {
    try {
      unlinkSync(this.pathFor(jobId));
    } catch {
      // best effort
    }
  }

  /**
   * A restarted daemon cannot prove that a pid is still the same process
   * (pid reuse), so it refuses to guess: running/paused jobs become `lost`
   * with an honest `exitCode: null`. Adoption is a later phase; fail-closed
   * is the only safe MVP.
   */
  /** Fail-closed finalization used by adoption when identity is unprovable. */
  markLost(job: JobRecord, note: string): JobRecord {
    const next: JobRecord = {
      ...job,
      state: "lost",
      endedAt: nowIso(),
      exitCode: null,
      signal: null,
      note,
    };
    this.save(next);
    return next;
  }

  markLostOnStart(): JobRecord[] {
    const lost: JobRecord[] = [];
    for (const job of this.loadAll()) {
      if (isTerminal(job.state)) continue;
      const next: JobRecord = {
        ...job,
        state: "lost",
        endedAt: nowIso(),
        exitCode: null,
        signal: null,
        note: "daemon restarted; process identity not proven (no adoption in v1)",
      };
      this.save(next);
      lost.push(next);
    }
    return lost;
  }

  /** Best-effort prune of old terminal records (keeps the latest MAX_LIST_JOBS). */
  prune(): void {
    const terminal = this.loadAll()
      .filter((job) => isTerminal(job.state))
      .sort((a, b) => (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt));
    const cutoff = Date.now() - TERMINAL_RECORD_TTL_MS;
    for (const [index, job] of terminal.entries()) {
      const ended = Date.parse(job.endedAt ?? job.createdAt);
      if (index >= MAX_LIST_JOBS || (Number.isFinite(ended) && ended < cutoff)) this.remove(job.jobId);
    }
  }

  list(): JobRecord[] {
    return this.loadAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  exists(jobId: string): boolean {
    return existsSync(this.pathFor(jobId));
  }
}
