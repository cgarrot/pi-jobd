/** src/format.ts — shared human formatting for the CLI and the tool results. */
import type { JobRecord } from "./protocol.js";

export function duration(job: JobRecord): string {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.endedAt !== undefined ? Date.parse(job.endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "?";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function jobLine(job: JobRecord): string {
  const pid = job.pid !== undefined ? ` pid=${job.pid}` : "";
  const hasSignal = job.signal !== null && job.signal !== undefined;
  const exit =
    job.exitCode !== undefined && job.exitCode !== null
      ? ` exit=${job.exitCode}`
      : job.exitCode === null && !hasSignal
        ? " exit=unknown"
        : "";
  const signal = hasSignal ? ` signal=${job.signal}` : "";
  return `${job.jobId} ${job.state}${pid} owner=${job.owner} ${duration(job)}${exit}${signal} :: ${job.command}`;
}

export function jobDetail(job: JobRecord): string {
  const lines = [
    `job:      ${job.jobId}`,
    `state:    ${job.state}`,
    `owner:    ${job.owner}`,
    `pid:      ${job.pid ?? "?"}`,
    `cwd:      ${job.cwd}`,
    `command:  ${job.command}`,
    `hash:     ${job.commandHash}`,
    `log:      ${job.logPath}`,
    `created:  ${job.createdAt}`,
    `started:  ${job.startedAt ?? "?"}`,
    `ended:    ${job.endedAt ?? "—"}`,
    `exit:     ${job.exitCode === null ? (job.signal !== null && job.signal !== undefined ? "— (terminated by signal)" : "unknown") : job.exitCode === undefined ? "—" : job.exitCode}`,
    `signal:   ${job.signal ?? "—"}`,
    `pausable: ${job.pausable}`,
    `duration: ${duration(job)}`,
  ];
  if (job.note !== undefined) lines.push(`note:     ${job.note}`);
  return lines.join("\n");
}
