/**
 * src/platform.ts — the only file that knows the OS.
 *
 * Why: the first job-runner attempt hard-coded a filesystem `.sock` path and
 * `/bin/bash`; that cannot work on Windows (named pipes, cmd.exe) and its
 * tests read `/proc` on macOS. Every OS-specific decision lives here, with a
 * documented degradation instead of a fake success.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

export const isWindows = process.platform === "win32";

/** Per-user state root: `$PI_JOBD_STATE_DIR` or `~/.pi-jobd`. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PI_JOBD_STATE_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(homedir(), ".pi-jobd");
}

/** Private runtime dir for the daemon socket/pid (0700). */
export function runtimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(stateRoot(env), "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // non-POSIX: best effort
  }
  return dir;
}

/**
 * IPC endpoint. POSIX: a unix socket file. Windows: a named pipe.
 * `name` is a short, stable identifier ("jobd").
 */
export function ipcPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isWindows) {
    const user = userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_");
    // One pipe per STATE DIR, exactly like the POSIX socket path. Without
    // this, two isolated daemons (tests, or PI_JOBD_STATE_DIR runs) fight
    // over the same pipe and clients reach the wrong registry.
    const scope = createHash("sha1").update(stateRoot(env)).digest("hex").slice(0, 8);
    return `\\\\.\\pipe\\pi-jobd-${user}-${scope}-${name}`;
  }
  // macOS caps a unix socket path at ~104 chars; ~/.pi-jobd/run/xxx.sock is short.
  return join(runtimeRoot(env), `${name}.sock`);
}

/** Remove a stale unix socket; a Windows named pipe is a kernel object. */
export function unlinkEndpoint(path: string): void {
  if (isWindows) return;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best effort
  }
}

/** The shell invocation for a command string (one process group / tree). */
export function shellArgs(command: string): { bin: string; args: string[] } {
  if (isWindows) return { bin: process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { bin: "/bin/bash", args: ["-lc", command] };
}

/** Windows cannot pause/resume a console process without external tools. */
export function supportsPause(): boolean {
  return !isWindows;
}

/**
 * Send a signal to the job's process TREE.
 * POSIX: negative pid = the process group (the job is spawned detached).
 * Windows: taskkill /T (then /F for a forced stop).
 */
export function killTree(pid: number, signal: "SIGTERM" | "SIGKILL" | "SIGSTOP" | "SIGCONT"): boolean {
  if (isWindows) {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL" || signal === "SIGSTOP" || signal === "SIGCONT") args.push("/F");
    try {
      spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ProcessIdentity {
  /** OS-specific start token: pid reuse changes it. */
  startToken: string;
  /** Boot id/time: a restart invalidates start tokens. */
  bootId: string;
}

/**
 * Best-effort process identity for a future adoption phase. The MVP does not
 * adopt (a daemon restart marks jobs lost, fail-closed), but the primitive is
 * here so adoption can be added without another platform file.
 */
/**
 * Boot id is constant for the life of a boot: cache it. On Windows this
 * matters — the old code spawned PowerShell twice per identity check (and
 * canSignal runs on every stop/pause/resume).
 */
let cachedBootId: string | undefined;
function bootId(): string | undefined {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    if (process.platform === "linux") {
      cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else if (process.platform === "darwin") {
      cachedBootId = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
    } else if (isWindows) {
      cachedBootId = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"],
        { encoding: "utf8" },
      ).trim();
    }
  } catch {
    return undefined;
  }
  if (cachedBootId === undefined || cachedBootId === "") {
    cachedBootId = undefined;
    return undefined;
  }
  return cachedBootId;
}

export function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const state = stat.slice(close + 2, close + 3);
      // A zombie has already exited; it lingers only because nobody reaped
      // it (e.g. a container without a reaping init). kill(pid, 0) stays
      // true for it, so the state char is the only honest tell.
      if (state === "Z") return undefined;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startToken = fields[19]; // field 22 overall
      const boot = bootId();
      if (startToken === undefined || startToken === "" || boot === undefined) return undefined;
      return { startToken, bootId: boot };
    }
    if (process.platform === "darwin") {
      // Same zombie tell as Linux, via ps: Z means already exited. BSD ps may
      // append a suffix (e.g. "Z+"), so prefix-match instead of equality.
      const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
      if (state.startsWith("Z")) return undefined;
      const startToken = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const boot = bootId();
      if (startToken === "" || boot === undefined) return undefined;
      return { startToken, bootId: boot };
    }
    if (isWindows) {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
      const startToken = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
      const boot = bootId();
      if (startToken === "" || boot === undefined) return undefined;
      return { startToken, bootId: boot };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A short, human-readable temp fallback (tests only; never used for jobs). */
export function tempDir(label: string): string {
  return join(tmpdir(), `pi-jobd-${label}-${process.pid}-${Date.now()}`);
}
