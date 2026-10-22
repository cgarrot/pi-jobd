/**
 * src/protocol.ts — the local job protocol (NDJSON over the IPC endpoint).
 * Same user, same machine, no network. Bodies never leave this socket.
 */
import { createHash, randomBytes } from "node:crypto";

export type JobState =
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "exited"
  | "failed"
  | "lost";

export interface JobRecord {
  jobId: string;
  owner: string;
  /** Full command line. Stored 0600; `PI_JOBD_REDACT_COMMAND=1` keeps only the hash. */
  command: string;
  commandHash: string;
  cwd: string;
  pid?: number;
  pgid?: number;
  state: JobState;
  pausable: boolean;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** Honest: `null` means "unknowable" (adopted/orphaned), not zero. */
  exitCode?: number | null;
  signal?: string | null;
  /** Why a job is `lost` (daemon restart, no re-attach in v1). */
  note?: string;
  /** Process identity captured at spawn: a pid reuse changes it. */
  startToken?: string;
  bootId?: string;
  /** True when a restarted daemon re-attached after verifying the identity. */
  adopted?: boolean;
  logPath: string;
}

export type JobdOp = "ping" | "run" | "status" | "list" | "stop" | "pause" | "resume" | "log" | "shutdown";

export interface JobdRequest {
  id: string;
  op: JobdOp;
  command?: string;
  cwd?: string;
  owner?: string;
  pausable?: boolean;
  jobId?: string;
  lines?: number;
}

export interface JobdResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export interface RunData {
  job: JobRecord;
}

export interface StatusData {
  job: JobRecord | undefined;
}

export interface ListData {
  jobs: JobRecord[];
}

export interface StopData {
  job: JobRecord;
  killed: boolean;
}

export interface PauseData {
  job: JobRecord;
  status: "paused" | "resumed" | "not_pausable" | "not_paused" | "not_running" | "not_supported";
}

export interface LogData {
  jobId: string;
  lines: string[];
  truncated: boolean;
}

export interface JobdError {
  code: string;
  message: string;
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isTerminal(state: JobState): boolean {
  return state === "stopped" || state === "exited" || state === "failed" || state === "lost";
}
