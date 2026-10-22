// test/platform.test.ts — the OS-specific surface is explicit, never assumed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ipcPath, isWindows, killTree, shellArgs, supportsPause, processIdentity } from "../src/platform.js";

describe("platform: endpoint + shell", () => {
  it("POSIX uses a .sock file, Windows uses a named pipe", () => {
    const path = ipcPath("test", { ...process.env, PI_JOBD_STATE_DIR: "/tmp/pi-jobd-platform" });
    if (isWindows) {
      assert.match(path, /^\\\\\.\\pipe\\pi-jobd-/);
    } else {
      assert.match(path, /\.sock$/);
    }
  });

  it("shell args match the platform (never a hard-coded /bin/bash on win32)", () => {
    const { bin, args } = shellArgs("echo hi");
    if (isWindows) {
      assert.notEqual(bin, "/bin/bash");
      assert.deepEqual(args.slice(-1), ["echo hi"]);
    } else {
      assert.equal(bin, "/bin/bash");
      assert.deepEqual(args, ["-lc", "echo hi"]);
    }
  });

  it("pause is POSIX-only and says so", () => {
    assert.equal(supportsPause(), !isWindows);
  });
});

describe("platform: process identity is best effort", () => {
  it("returns a token for the current process (or undefined, never throws)", () => {
    const id = processIdentity(process.pid);
    if (id !== undefined) {
      assert.equal(typeof id.startToken, "string");
      assert.ok(id.startToken.length > 0);
    }
  });

  it("a dead pid has no identity", () => {
    // 2^22 is above the usual pid range and not a real pid.
    assert.equal(processIdentity(4_194_303), undefined);
  });

  it("killTree on a dead pid is a boolean, never a throw", () => {
    assert.equal(typeof killTree(4_194_303, "SIGTERM"), "boolean");
  });
});
