# pi-jobd — detached local job runner

![CI](https://github.com/cgarrot/pi-jobd/actions/workflows/ci.yml/badge.svg)

Long shell work (builds, renders, test sweeps) should not block an agent's
turn. `pi-jobd` runs a command in a **detached process group**, supervises it
from a **per-user daemon**, and reports honest states: `running` / `paused` /
`stopped` / `exited` / `failed` / **`lost`**.

Zero runtime dependencies. Node ≥ 20. Linux, macOS and Windows.

```
pi session ──run──▶ jobd (per user, 0600 IPC) ──spawn──▶ job (own process group)
   │                    │                                   │
   └── status/log/stop ─┘                                   └── output → 0600 log
```

## Quick start

```bash
npm install && npm run build

# from a repo (the command runs in the daemon, not in your turn)
pijob run "npm run build" --cwd /path/to/repo
# → started j_... running pid=4242 owner=you 0s :: npm run build

pijob status j_...
pijob log j_... --lines 40
pijob list
pijob stop j_...
```

The first command **auto-starts** the daemon (`~/.pi-jobd`, or
`$PI_JOBD_STATE_DIR`). Jobs survive the session that started them; the daemon
survives too (it is detached).

## Cross-platform behavior (honest by construction)

| operation | Linux | macOS | Windows |
|---|---|---|---|
| `run` / `status` / `list` / `log` / `stop` | ✅ | ✅ | ✅ |
| `pause` / `resume` | SIGSTOP / SIGCONT | SIGSTOP / SIGCONT | **`not_supported`** (exit 4) |
| process tree kill | `kill(-pgid)` | `kill(-pgid)` | `taskkill /T` then `/F` |
| shell | `/bin/bash -lc` | `/bin/bash -lc` | `cmd.exe /d /s /c` |
| socket | unix socket | unix socket | named pipe |
| daemon restart | **adopted** if pid+start token+boot id match, else **`lost`** | idem | idem |

> **Windows status:** the named-pipe, `taskkill /T` and
> `pause = not_supported` paths are implemented, but the real-process suite
> is not yet CI-green on Windows (the runner keeps a crashed daemon's pipe
> bound long enough to break the adoption tests). CI covers Linux and macOS;
> treat Windows as experimental until the follow-up lands.

Windows has no SIGSTOP and no graceful SIGTERM for console processes:
`pause` says `not_supported`, `stop` is `taskkill /T` then `/F`. It never
pretends to have paused something.

## States and the honest limits

- `running` — the daemon spawned the command and it is alive.
- `paused` — SIGSTOPed (only jobs started with `--pausable`; POSIX only).
- `stopped` — terminated by `stop` (SIGTERM → grace 5 s → SIGKILL).
- `exited` / `failed` — the daemon observed the child exit (`exitCode` 0 or
  non-zero). If a signal ended it, `exitCode` is `null` and `signal` is set.
- **`adopted`** — after a daemon restart, a job whose pid **and** start token
  **and** boot id still match is re-attached (`adopted: true`) and can be
  stopped/paused normally. Identity is re-checked before **every** signal, so
  a reused pid is never signalled.
- **`lost`** — the daemon restarted and cannot **prove** that the pid is still
  the same process (pid gone or reused). It refuses to guess:
  - the record says `lost`, `exitCode: null`, and a note;
  - the OS process may still be running — **kill it manually**;
  - `stop`/`pause`/`resume` on a `lost` job are refused
    (`identity_mismatch`), never a false `stopped`.

An adopted process that ends later is marked `exited` with `exitCode: null`
(not our child, `waitpid` is unavailable) — the outcome is unknowable and stays
that way.

## Security model

- Same-user trust boundary: the IPC endpoint is 0600 (`chmod` on POSIX;
  same-user named pipe on Windows). Anyone who can use it can already run
  `bash` as that user.
- The daemon never accepts a command from another user or over the network.
- The command and the log are stored under `~/.pi-jobd/jobs` with mode 0600.
  Set `PI_JOBD_REDACT_COMMAND=1` to persist only the command hash (the running
  process still sees the command, of course).
- The mesh is **not** involved. Remote `stop`/`pause` of another agent's job is
  a later phase (a mesh `ctl` frame with policy + ack), deliberately not bolted
  on here.

## Remote control (pi-mesh)

When both extensions are loaded, an authorized peer can stop/pause/resume one
of your jobs:

```
mesh_job_control { "to": "bob", "jobId": "j_…", "action": "stop" }
```

- pi-mesh checks its **policy** and emits the request on the local
  `pi.events` bus (`mesh-ctl`); pi-jobd answers on
  `mesh-ctl:reply:<ctlId>`. No package imports, no shell string on the wire.
- **Owner rule**: a job is remotely controllable only when its `owner` is
  this session's mesh alias (`PI_MESH_ALIAS`, set by pi-mesh). Jobs started
  from the CLI (OS user) are refused with `not_authorized` — deliberate.
- `ctl` is online-only (offline = `unreachable`, never queued); a timeout
  means the target may have acted and is never retried.
- A `lost` job answers `identity_mismatch` (we never signal an unproven pid);
  Windows `pause` answers `not_supported`.
- **Renaming the session** (mesh alias) leaves existing jobs owned by the old
  alias: they stay controllable locally (`pijob`), but remote control answers
  `not_authorized` until they are restarted under the new alias.
- Remote control never starts a process: the action is a closed enum
  (`stop`/`pause`/`resume`) plus an opaque job id.

## CLI

```
pijob run <command...> [--cwd DIR] [--owner NAME] [--pausable] [--json]
pijob status <jobId> [--json]
pijob list [--json]
pijob log <jobId> [--lines N] [--json]
pijob stop <jobId> [--json]
pijob pause <jobId>          # POSIX + --pausable
pijob resume <jobId>         # POSIX
pijob doctor [--json]
pijob daemon stop            # running jobs keep running
```

Exit codes: `0` success · `1` error · `2` usage · `3` not_found ·
`4` unsupported / `not_pausable` / `not_paused`.

## API (for tools / scripts)

```ts
import { JobdClient } from "pi-jobd";

const client = new JobdClient();          // ~/.pi-jobd
const job = await client.run({ command: "make -j8", cwd: "/repo" });
const state = await client.status(job.jobId);
const log = await client.log(job.jobId, 50);
await client.stop(job.jobId);
```

## Releasing

`prepublishOnly` runs `npm run ci` (build + tests + smoke). The repository
currently has **no `NPM_TOKEN` secret**, so do **not** push a `v*` tag yet:
tag and publish must be one atomic act (a tag whose publish fails would point
at an artifact that does not exist). Once the secret is added:
`npm version 0.1.0` then `git push && git push --tags`.

## Test

```bash
npm test              # unit + real-process integration + CLI auto-start
npm run smoke         # run → log → pause → stop → adopt → lost
npm run real:cases    # 9 real cases: concurrency, SIGKILL, pause, adoption,
                      # paused adoption, tampered identity, redaction, ...
npm run mesh:smoke    # cross-package ctl E2E (needs ../pi-mesh built)
```

The integration tests use **real processes and real signals**: a TERM-ignoring
job must escalate to SIGKILL, a paused job stops without hanging, and a daemon
crash must either **adopt** the job (identity verified) or report `lost` while
the OS process is still alive — never a false `stopped`.

## Roadmap

1. Log rotation and an opt-in command retention policy.
2. Daemon-only remote control: the target **session** is the mesh face, so a
   jobd on a machine with no pi session cannot be reached (run one, or wait
   for a daemon-side ctl listener).
