// test/mesh-ctl.test.ts — remote job control, target side (pi-mesh -> pi-jobd).
// A peer may control only a job whose owner is THIS session's mesh alias.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { registerJobTools } from "../src/extension/tools.js";
import { registerMeshCtl } from "../src/extension/ctl.js";
import { JobdClient } from "../src/client.js";
import { isWindows } from "../src/platform.js";
import type { ExtensionAPI, SessionContext, ToolDefinition, ToolResult } from "../src/extension/pi-types.js";

const LONG = isWindows ? "timeout /t 10 /nobreak >nul" : "sleep 10";

type Handler = (data: unknown) => void;

interface Bus {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: Handler) => void;
}

interface Stub {
  api: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  bus: Bus;
}

function stub(): Stub {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const bus: Bus = {
    emit: (channel, data) => {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on: (channel, handler) => {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
  };
  const api: ExtensionAPI = { registerTool: (tool) => tools.set(tool.name, tool), events: bus };
  return { api, tools, bus };
}

function call(tools: Map<string, ToolDefinition>, name: string, params: Record<string, unknown>, ctx: SessionContext): Promise<ToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return tool.execute("call", params, undefined, undefined, ctx);
}

function details(result: ToolResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

function waitReply(bus: Bus, ctlId: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${ctlId}`)), timeoutMs);
    bus.on(`mesh-ctl:reply:${ctlId}`, (data) => {
      clearTimeout(timer);
      resolve(data as Record<string, unknown>);
    });
  });
}

const created: Array<{ dir: string }> = [];

afterEach(async () => {
  while (created.length > 0) {
    const item = created.pop();
    if (item === undefined) continue;
    await new JobdClient({ stateDir: item.dir }).shutdown().catch(() => {});
    rmSync(item.dir, { recursive: true, force: true });
  }
  delete process.env.PI_JOBD_STATE_DIR;
  delete process.env.PI_MESH_ALIAS;
});

async function harness(alias: string): Promise<{ stub: Stub; ctx: SessionContext }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-jobd-meshctl-"));
  created.push({ dir });
  process.env.PI_JOBD_STATE_DIR = dir;
  process.env.PI_MESH_ALIAS = alias;
  const s = stub();
  registerJobTools(s.api);
  registerMeshCtl(s.api);
  return { stub: s, ctx: { cwd: dir } };
}

describe("mesh-ctl: remote job control", () => {
  it("stops a job owned by this session's mesh alias", async () => {
    const { stub: s, ctx } = await harness("bob");
    const started = await call(s.tools, "job_run", { command: LONG }, ctx);
    const jobId = details(started).jobId as string;
    assert.equal(typeof jobId, "string");

    const reply = waitReply(s.bus, "ctl_1");
    s.bus.emit("mesh-ctl", { ctlId: "ctl_1", action: "job_stop", target: jobId, from: "alice", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "stopped");
    assert.equal(data.settled, true);

    const status = await call(s.tools, "job_status", { jobId }, ctx);
    assert.equal(details(status).state, "stopped");
  });

  it("refuses a job owned by another alias (not_authorized)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-jobd-meshctl-"));
    created.push({ dir });
    process.env.PI_JOBD_STATE_DIR = dir;
    // Job started under alice's identity...
    process.env.PI_MESH_ALIAS = "alice";
    const s = stub();
    registerJobTools(s.api);
    registerMeshCtl(s.api);
    const started = await call(s.tools, "job_run", { command: LONG }, { cwd: dir });
    const jobId = details(started).jobId as string;
    // ...but the controlling session is bob.
    process.env.PI_MESH_ALIAS = "bob";
    const reply = waitReply(s.bus, "ctl_owner");
    s.bus.emit("mesh-ctl", { ctlId: "ctl_owner", action: "job_stop", target: jobId, from: "carol", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "not_authorized");
    // The job must still be running: a refused control never acted.
    const status = await call(s.tools, "job_status", { jobId }, { cwd: dir });
    assert.equal(details(status).state, "running");
    await call(s.tools, "job_stop", { jobId }, { cwd: dir });
  });

  it("a target with no daemon answers error, never auto-spawns", async () => {
    const { stub: s, ctx } = await harness("bob");
    const started = await call(s.tools, "job_run", { command: LONG }, ctx);
    const jobId = details(started).jobId as string;
    const status = await call(s.tools, "job_status", { jobId }, ctx);
    const pid = details(status).pid as number;

    const dir = process.env.PI_JOBD_STATE_DIR!;
    await new JobdClient({ stateDir: dir }).shutdown();
    await new Promise((r) => setTimeout(r, 400));

    const reply = waitReply(s.bus, "ctl_nodaemon");
    s.bus.emit("mesh-ctl", { ctlId: "ctl_nodaemon", action: "job_stop", target: jobId, from: "alice", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "error");
    assert.match(String(data.reason), /jobd is not running/);

    // The detached job is still alive (daemon shutdown never kills work).
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  });

  it("pauses and resumes a pausable job through the mesh", async () => {
    const { stub: s, ctx } = await harness("bob");
    const started = await call(s.tools, "job_run", { command: LONG, pausable: true }, ctx);
    const jobId = details(started).jobId as string;

    const pauseReply = waitReply(s.bus, "ctl_pause");
    s.bus.emit("mesh-ctl", { ctlId: "ctl_pause", action: "job_pause", target: jobId, from: "alice", to: "bob" });
    const paused = await pauseReply;
    if (isWindows) {
      assert.equal(paused.status, "not_supported");
    } else {
      assert.equal(paused.status, "paused");
      const resumeReply = waitReply(s.bus, "ctl_resume");
      s.bus.emit("mesh-ctl", { ctlId: "ctl_resume", action: "job_resume", target: jobId, from: "alice", to: "bob" });
      const resumed = await resumeReply;
      assert.equal(resumed.status, "resumed");
    }
    await call(s.tools, "job_stop", { jobId }, ctx);
  });

  it("unknown jobs are not_found, never a false stopped", async () => {
    const { stub: s, ctx } = await harness("bob");
    // The daemon must be running for "not_found" to mean "no such job",
    // not "no daemon" (that case is the previous test).
    const started = await call(s.tools, "job_run", { command: LONG }, ctx);
    const reply = waitReply(s.bus, "ctl_missing");
    s.bus.emit("mesh-ctl", { ctlId: "ctl_missing", action: "job_stop", target: "j_nope", from: "alice", to: "bob" });
    const data = await reply;
    assert.equal(data.status, "not_found");
    await call(s.tools, "job_stop", { jobId: details(started).jobId }, ctx);
  });
});
