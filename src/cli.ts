#!/usr/bin/env node
/**
 * src/cli.ts — `pijob`, the zero-dependency job runner CLI.
 *
 * Honest exit codes: 0 success · 1 error · 2 usage · 3 not_found ·
 * 4 unsupported/not_pausable/not_paused. A job that is `lost` after a daemon
 * restart is reported as lost, never as stopped.
 */
import { JobdClient, JobdError } from "./client.js";
import { DEFAULT_TAIL_LINES, MAX_TAIL_LINES } from "./limits.js";
import { supportsPause } from "./platform.js";
import { duration, jobDetail, jobLine } from "./format.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_UNSUPPORTED = 4;

const USAGE = `pijob — detached local job runner

usage:
  pijob run <command...> [--cwd DIR] [--owner NAME] [--pausable] [--json]
  pijob status <jobId> [--json]
  pijob list [--json]
  pijob log <jobId> [--lines N] [--json]
  pijob stop <jobId> [--json]
  pijob pause <jobId>        (POSIX only; --pausable jobs)
  pijob resume <jobId>       (POSIX only)
  pijob doctor [--json]
  pijob daemon stop

The first command auto-starts a per-user daemon (~/.pi-jobd, 0600 socket).
Jobs run detached and survive the agent session.`;

interface Parsed {
  positionals: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const valueFlags = new Set(["cwd", "owner", "lines"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const value = argv[i + 1];
        if (value === undefined) {
          flags[name] = "";
        } else {
          flags[name] = value;
          i += 1;
        }
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  const { positionals, flags } = parseArgs(argv.slice(1));
  const json = flags.json === true;
  const client = new JobdClient();
  const value = (name: string): string | undefined => {
    const v = flags[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  };

  try {
    switch (command) {
      case "run": {
        if (positionals.length === 0) {
          process.stderr.write("pijob: run requires a command\n");
          return EXIT_USAGE;
        }
        const job = await client.run({
          command: positionals.join(" "),
          ...(value("cwd") !== undefined ? { cwd: value("cwd")! } : {}),
          ...(value("owner") !== undefined ? { owner: value("owner")! } : {}),
          pausable: flags.pausable === true,
        });
        if (json) printJson(job);
        else process.stdout.write(`started ${jobLine(job)}\n`);
        return EXIT_OK;
      }
      case "status": {
        const jobId = positionals[0];
        if (jobId === undefined) {
          process.stderr.write("pijob: status requires a jobId\n");
          return EXIT_USAGE;
        }
        const job = await client.status(jobId);
        if (job === undefined) {
          process.stderr.write(`pijob: no job ${jobId}\n`);
          return EXIT_NOT_FOUND;
        }
        if (json) printJson(job);
        else process.stdout.write(`${jobDetail(job)}\n`);
        return EXIT_OK;
      }
      case "list": {
        const jobs = await client.list();
        if (json) {
          printJson(jobs);
          return EXIT_OK;
        }
        if (jobs.length === 0) {
          process.stdout.write("no jobs\n");
          return EXIT_OK;
        }
        process.stdout.write(`jobs (${jobs.length}):\n`);
        for (const job of jobs) process.stdout.write(`  ${jobLine(job)}\n`);
        return EXIT_OK;
      }
      case "log": {
        const jobId = positionals[0];
        if (jobId === undefined) {
          process.stderr.write("pijob: log requires a jobId\n");
          return EXIT_USAGE;
        }
        const lines = value("lines") !== undefined ? Number(value("lines")) : DEFAULT_TAIL_LINES;
        if (!Number.isInteger(lines) || lines <= 0 || lines > MAX_TAIL_LINES) {
          process.stderr.write(`pijob: --lines must be 1..${MAX_TAIL_LINES}\n`);
          return EXIT_USAGE;
        }
        const data = await client.log(jobId, lines);
        if (json) {
          printJson(data);
          return EXIT_OK;
        }
        if (data.lines.length === 0) {
          process.stdout.write("(no output yet)\n");
          return EXIT_OK;
        }
        if (data.truncated) process.stdout.write(`… (last ${data.lines.length} lines)\n`);
        for (const line of data.lines) process.stdout.write(`${line}\n`);
        return EXIT_OK;
      }
      case "stop": {
        const jobId = positionals[0];
        if (jobId === undefined) {
          process.stderr.write("pijob: stop requires a jobId\n");
          return EXIT_USAGE;
        }
        const data = await client.stop(jobId);
        if (json) printJson(data);
        else process.stdout.write(`${data.killed ? "killed" : "stopped"} ${jobLine(data.job)}\n`);
        return EXIT_OK;
      }
      case "pause": {
        const jobId = positionals[0];
        if (jobId === undefined) {
          process.stderr.write("pijob: pause requires a jobId\n");
          return EXIT_USAGE;
        }
        const data = await client.pause(jobId);
        if (json) printJson(data);
        else process.stdout.write(`${data.status} ${jobLine(data.job)}\n`);
        return data.status === "paused" ? EXIT_OK : data.status === "not_pausable" || data.status === "not_supported" ? EXIT_UNSUPPORTED : EXIT_ERROR;
      }
      case "resume": {
        const jobId = positionals[0];
        if (jobId === undefined) {
          process.stderr.write("pijob: resume requires a jobId\n");
          return EXIT_USAGE;
        }
        const data = await client.resume(jobId);
        if (json) printJson(data);
        else process.stdout.write(`${data.status} ${jobLine(data.job)}\n`);
        return data.status === "resumed" ? EXIT_OK : EXIT_ERROR;
      }
      case "doctor": {
        try {
          const ping = await client.ping(1_000);
          if (json) printJson({ reachable: true, ...ping });
          else {
            process.stdout.write(
              [
                "jobd:      running",
                `version:   ${String(ping.version ?? "?")}`,
                `pid:       ${String(ping.pid ?? "?")}`,
                `owner:     ${String(ping.owner ?? "?")}`,
                `socket:    ${String(ping.socketPath ?? "?")}`,
                `state:     ${String(ping.stateDir ?? "?")}`,
                `pause:     ${ping.supportsPause === true ? "supported" : "not_supported (win32)"}`,
                `jobs:      ${String(ping.jobs ?? "?")}`,
              ].join("\n") + "\n",
            );
          }
        } catch {
          if (json) printJson({ reachable: false, stateDir: client.stateDir, socketPath: client.socketPath, pauseSupported: supportsPause() });
          else {
            process.stdout.write(
              [
                "jobd:      not running (auto-starts on the first `pijob run`)",
                `socket:    ${client.socketPath}`,
                `state:     ${client.stateDir}`,
                `pause:     ${supportsPause() ? "supported" : "not_supported (win32)"}`,
              ].join("\n") + "\n",
            );
          }
        }
        return EXIT_OK;
      }
      case "daemon": {
        if (positionals[0] !== "stop") {
          process.stderr.write("pijob: daemon stop\n");
          return EXIT_USAGE;
        }
        await client.shutdown();
        process.stdout.write("jobd stopping (running jobs keep running)\n");
        return EXIT_OK;
      }
      default:
        process.stderr.write(`pijob: unknown command ${command}\n${USAGE}\n`);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof JobdError && err.code === "not_found") {
      process.stderr.write(`pijob: ${err.message}\n`);
      return EXIT_NOT_FOUND;
    }
    process.stderr.write(`pijob: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_ERROR;
  }
}

const isMain = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`pijob: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(EXIT_ERROR);
    });
}
