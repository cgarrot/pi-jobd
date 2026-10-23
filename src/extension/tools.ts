/**
 * src/extension/tools.ts — Pi tools for the job runner.
 *
 * ONE TOOL = ONE ACTION:
 *   job_run    start a detached job
 *   job_status one job
 *   job_list   this user's jobs
 *   job_log    tail a job's log
 *   job_stop   stop a job (and its tree)
 *   job_pause  SIGSTOP (POSIX, --pausable only)
 *   job_resume SIGCONT (POSIX)
 *
 * Honest statuses, never "delivered": started / running / stopped / not_found /
 * not_pausable / not_supported / error. A `lost` job is reported as lost.
 */
import { JobdClient, JobdError } from "../client.js";
import { DEFAULT_TAIL_LINES, MAX_TAIL_LINES } from "../limits.js";
import { jobDetail, jobLine } from "../format.js";
import type { ExtensionAPI, SessionContext, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";
import type { JobRecord } from "../protocol.js";

const SCHEMA = "pi-jobd.v1";

function details(partial: Record<string, unknown>): Record<string, unknown> {
  return { schema: SCHEMA, ...partial };
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v === "" ? undefined : v;
}

function asLines(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_TAIL_LINES)
    : DEFAULT_TAIL_LINES;
}

function jobDetails(job: JobRecord, status: string): Record<string, unknown> {
  return details({
    status,
    jobId: job.jobId,
    state: job.state,
    pid: job.pid,
    owner: job.owner,
    cwd: job.cwd,
    command: job.command,
    logPath: job.logPath,
    exitCode: job.exitCode,
    signal: job.signal,
    pausable: job.pausable,
    note: job.note,
  });
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof JobdError) {
    const status = err.code === "not_found" ? "not_found" : "error";
    return textResult(`${status}: ${err.message}`, details({ status, reason: err.code }));
  }
  const reason = err instanceof Error ? err.message : String(err);
  return textResult(`error: ${reason}`, details({ status: "error", reason }));
}

const RUN_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", description: "Shell command line (same trust as your bash tool)." },
    cwd: { type: "string", description: "Working directory (default: this session's cwd)." },
    pausable: {
      type: "boolean",
      description: "Opt in to SIGSTOP/SIGCONT (POSIX only). Default false: never pause git/pip/network work implicitly.",
    },
  },
};

const STATUS_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["jobId"],
  properties: { jobId: { type: "string", description: "Job id from job_run." } },
};

const LIST_PARAMS: Record<string, unknown> = { type: "object", properties: {} };

const LOG_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["jobId"],
  properties: {
    jobId: { type: "string" },
    lines: { type: "integer", minimum: 1, maximum: MAX_TAIL_LINES, description: "Tail size (default 40)." },
  },
};

const STOP_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["jobId"],
  properties: { jobId: { type: "string" } },
};

const PAUSE_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["jobId"],
  properties: { jobId: { type: "string" } },
};

const RESUME_PARAMS: Record<string, unknown> = {
  type: "object",
  required: ["jobId"],
  properties: { jobId: { type: "string" } },
};

export function registerJobTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "job_run",
    label: "Job Run",
    description:
      "Start a detached local job (long build/render/test sweep/install/training) and return in ~150 ms. " +
      "The job runs in its own process group under a per-user daemon: it survives /reload, a crash and the end " +
      "of this session. Follow it with job_log/job_status; stop it with job_stop. Same privileges as bash.",
    promptSnippet: "Start long shell work detached instead of blocking the turn.",
    promptGuidelines:
      "Use job_run when the command will take more than ~60-90 s, when you must keep working while it runs, " +
      "when it must survive /reload or session end, or when a peer may need to stop it. " +
      "Use bash instead for short commands whose output you need to decide the next step, for interactive or " +
      "streaming commands, and when the failure itself is the information (you want it in context now). " +
      "After job_run, keep working; read job_log/job_status only when you actually need the result — never poll in a loop.",
    parameters: RUN_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const command = asString(params.command);
      if (command === undefined) {
        return textResult("error: command is required", details({ status: "error", reason: "invalid_request" }));
      }
      const cwd = asString(params.cwd) ?? (ctx as SessionContext | undefined)?.cwd;
      try {
        // The owner is the MESH alias when pi-mesh is present: remote ctl
        // (mesh_job_control) checks `job.owner === local alias`.
        const meshAlias = process.env.PI_MESH_ALIAS;
        const job = await new JobdClient().run({
          command,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(meshAlias !== undefined && meshAlias !== "" ? { owner: meshAlias } : {}),
          pausable: params.pausable === true,
        });
        return textResult(`started ${jobLine(job)}`, jobDetails(job, "started"));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: "job_status",
    label: "Job Status",
    description: "Inspect one job: state, pid, exit code/signal, duration, log path. `lost` is reported as lost.",
    promptSnippet: "Check a detached job's honest state.",
    promptGuidelines:
      "Read it on demand, not in a loop. `exitCode: null` means unknowable (an adopted job that ended), never 0. " +
      "`lost` means the daemon cannot prove the pid is ours: stop/pause are refused, inspect the pid manually.",
    parameters: STATUS_PARAMS,
    async execute(_toolCallId, params) {
      const jobId = asString(params.jobId);
      if (jobId === undefined) return textResult("error: jobId is required", details({ status: "error" }));
      try {
        const job = await new JobdClient().status(jobId);
        if (job === undefined) return textResult(`not_found: no job ${jobId}`, details({ status: "not_found", jobId }));
        return textResult(jobDetail(job), jobDetails(job, job.state));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: "job_list",
    label: "Job List",
    description: "List this user's jobs (newest first), including honest terminal states and `lost`.",
    promptSnippet: "List detached jobs.",
    promptGuidelines:
      "Use it to recover context after a /reload or a new session (a job started earlier may still be running), " +
      "or to find the id of a job you started in a previous turn.",
    parameters: LIST_PARAMS,
    async execute() {
      try {
        const jobs = await new JobdClient().list();
        const text =
          jobs.length === 0 ? "no jobs" : [`jobs (${jobs.length}):`, ...jobs.map((job) => `  ${jobLine(job)}`)].join("\n");
        return textResult(text, details({ status: "ok", count: jobs.length, jobs }));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: "job_log",
    label: "Job Log",
    description: "Tail a job's output log (bounded; never loads the whole file).",
    promptSnippet: "Tail a detached job's output.",
    promptGuidelines:
      "Fetch the tail only when you need the result or are diagnosing a failure; a running job's log is partial. " +
      "Increase `lines` for a stack trace; the read is bounded either way.",
    parameters: LOG_PARAMS,
    async execute(_toolCallId, params) {
      const jobId = asString(params.jobId);
      if (jobId === undefined) return textResult("error: jobId is required", details({ status: "error" }));
      try {
        const data = await new JobdClient().log(jobId, asLines(params.lines));
        const text =
          data.lines.length === 0
            ? "(no output yet)"
            : `${data.truncated ? `… (last ${data.lines.length} lines)\n` : ""}${data.lines.join("\n")}`;
        return textResult(text, details({ status: "ok", jobId: data.jobId, lines: data.lines.length, truncated: data.truncated }));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: "job_stop",
    label: "Job Stop",
    description:
      "Stop a job: SIGTERM to its process group, then SIGKILL after 5 s. Windows: taskkill /T then /F. " +
      "A `lost` job is refused (we do not signal a process we cannot prove is ours).",
    promptSnippet: "Stop a detached job and its process tree.",
    promptGuidelines:
      "Prefer job_stop over aborting the turn (ESC) when the runaway thing is a job you started: the job dies " +
      "and your turn survives. `already exited` means it had finished on its own before the stop.",
    parameters: STOP_PARAMS,
    async execute(_toolCallId, params) {
      const jobId = asString(params.jobId);
      if (jobId === undefined) return textResult("error: jobId is required", details({ status: "error" }));
      try {
        const data = await new JobdClient().stop(jobId);
        const verb = data.job.state === "exited" ? "already exited" : data.killed ? "killed" : "stopped";
        return textResult(`${verb} ${jobLine(data.job)}`, jobDetails(data.job, data.job.state));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: "job_pause",
    label: "Job Pause",
    description:
      "SIGSTOP a job started with pausable:true (POSIX only). A non-pausable job is refused; " +
      "Windows returns not_supported — never a fake pause.",
    promptSnippet: "Pause a pausable job (POSIX only).",
    promptGuidelines:
      "Only for jobs started with pausable:true, and never for git/pip/network transfers: a half-written " +
      "transfer is worse than a slow one.",
    parameters: PAUSE_PARAMS,
    async execute(_toolCallId, params) {
      const jobId = asString(params.jobId);
      if (jobId === undefined) return textResult("error: jobId is required", details({ status: "error" }));
      try {
        const data = await new JobdClient().pause(jobId);
        return textResult(`${data.status} ${jobLine(data.job)}`, jobDetails(data.job, data.status));
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: "job_resume",
    label: "Job Resume",
    description: "SIGCONT a paused job (POSIX only).",
    promptSnippet: "Resume a paused job (POSIX only).",
    promptGuidelines: "Resume only a job you paused; `not_paused` means it was not paused (or already ended).",
    parameters: RESUME_PARAMS,
    async execute(_toolCallId, params) {
      const jobId = asString(params.jobId);
      if (jobId === undefined) return textResult("error: jobId is required", details({ status: "error" }));
      try {
        const data = await new JobdClient().resume(jobId);
        return textResult(`${data.status} ${jobLine(data.job)}`, jobDetails(data.job, data.status));
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
