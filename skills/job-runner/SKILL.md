---
name: job-runner
description: Run long shell work (builds, renders, test sweeps, training, big installs) OUTSIDE the agent turn with pi-jobd, so the turn is not blocked and the job survives /reload or session end. Read it when a command will take minutes, when you want to keep working while it runs, or when you must stop/pause someone's long job.
---

# Long shell work with pi-jobd

`bash` blocks your turn until the command finishes. That is correct for short
commands and wrong for anything that takes minutes: you cannot answer, cannot
think, and a `/reload` or a session end kills it.

`pi-jobd` runs the command in a **detached process group** supervised by a
per-user daemon, so it survives your session, and it returns in ~150 ms.

## The decision rule

Use **`job_run`** when ANY of these is true:

- the command is expected to run **longer than ~60–90 s** (build, render,
  test sweep, install, training, big `find`/`rsync`, ffmpeg, docker build);
- you must **keep working while it runs** (write code, answer the user,
  inspect other files);
- it must **survive `/reload`, a crash, or the end of the session**;
- another agent should be able to **stop/pause** it (`mesh_job_control`);
- the command would otherwise blow the provider/turn timeout.

Use **`bash`** when ANY of these is true:

- it is short (< ~60 s) and you need its output **to decide the next step**;
- it is interactive, a REPL, a watcher, or a streaming command;
- the failure mode is the information (a failing test you will diagnose
  immediately, a compile error) — you want it in your context, not in a log
  to fetch later;
- you need the exit code *in this turn* to branch.

In doubt: if you would otherwise sit and wait, `job_run` is the better choice.

## The loop

```
job_run  { "command": "npm run build", "cwd": "/repo" }
→ started j_7k2… running pid=4242

# … do other work, then, when you actually need the result:
job_log    { "jobId": "j_7k2…", "lines": 40 }
job_status { "jobId": "j_7k2…" }   → exited exit=0 4m12s
```

**Do not poll in a loop.** `job_status`/`job_log` are on-demand reads, not a
wait primitive: check once when you need the answer, keep working otherwise.
There is no "wait for job" tool — if you truly must wait, tell the user and
use a bounded `bash` probe instead.

## Stopping and pausing

- `job_stop { jobId }` — SIGTERM to the process group, SIGKILL after 5 s.
  Use this **instead of aborting your turn** (ESC) when the runaway thing is
  a job you started: the job dies, your turn survives.
- `job_pause` / `job_resume` — SIGSTOP/SIGCONT, **only** for jobs started with
  `"pausable": true`, **POSIX only** (Windows returns `not_supported`).
  Never pause git/pip/network transfers: a half-written transfer is worse
  than a slow one.

## Facts you can rely on (honest states)

`running` · `paused` · `stopped` · `exited` · `failed` · **`lost`**.

- `exitCode: null` means **unknowable** (an adopted job that ended), never 0.
- `lost` = the daemon restarted and cannot prove the pid is still ours;
  `stop`/`pause` on a `lost` job is **refused** (`identity_mismatch`) — we
  never signal an unproven pid.
- a job that ignores SIGTERM still dies: the stop escalates to SIGKILL.
- `pijob` (the CLI) shows the same state from a terminal:
  `pijob list`, `pijob log <id> --lines 40`, `pijob stop <id>`.

## Concurrency

Several jobs can run at once (`job_run` × N). If jobs and your own edits touch
the same files, claim the paths first (`mesh_reserve` in pi-mesh) so peers do
not write over each other.

## What it is not

- Not a sandbox: a job runs with **your** user privileges, exactly like `bash`.
- Not a scheduler/queue: no priorities, no retries, no cron.
- Not a token saver by itself: it saves **turn time**; the log is only read
  when you ask for it.
