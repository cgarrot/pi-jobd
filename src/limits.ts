/**
 * src/limits.ts — every bound of the job runner, named.
 */
/** Max command line length accepted by the daemon. */
export const MAX_COMMAND_CHARS = 8_192;

/** Grace between SIGTERM and SIGKILL when stopping a job. */
export const STOP_GRACE_MS = 5_000;

/** Time to wait for the exit event after SIGKILL (best effort). */
export const KILL_SETTLE_MS = 1_000;

/** Daemon start probe: poll interval and deadline. */
export const DAEMON_POLL_MS = 50;
export const DAEMON_START_TIMEOUT_MS = 5_000;

/** Per-request timeout for local socket calls. */
export const JOB_REQUEST_TIMEOUT_MS = 10_000;

/** `pijob stop` ack timeout (must exceed STOP_GRACE_MS + KILL_SETTLE_MS). */
export const JOB_STOP_TIMEOUT_MS = STOP_GRACE_MS + KILL_SETTLE_MS + 2_000;

/** Poll interval for adopted jobs (we have no child handle, so death is
 *  observed by polling; 2 s is cheap and bounded). */
export const ADOPT_POLL_MS = 2_000;

/** Tail bound for `pijob log`. */
export const DEFAULT_TAIL_LINES = 40;
export const MAX_TAIL_LINES = 500;

/** Max bytes read from a log tail (never load a huge log into memory). */
export const MAX_TAIL_BYTES = 256 * 1024;

/** Keep terminal job records for this long (best-effort prune on start). */
export const TERMINAL_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Max terminal records kept in `pijob list`. */
export const MAX_LIST_JOBS = 200;
