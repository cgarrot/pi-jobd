// test/extension.test.ts — the Pi tools over a real auto-started daemon.
// Uses a stub ExtensionAPI (no host SDK) and a temp state dir.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { registerJobTools } from "../src/extension/tools.js";
import { JobdClient } from "../src/client.js";
import type { ExtensionAPI, SessionContext, ToolDefinition, ToolResult } from "../src/extension/pi-types.js";

const isWindows = process.platform === "win32";
const ECHO_FIXTURE = fileURLToPath(new URL("../../test/fixtures/echo.mjs", import.meta.url));
const ECHO_JOB = isWindows ? `"${process.execPath}" "${ECHO_FIXTURE}" ext-ok 5000` : "echo ext-ok; sleep 5";
const LONG_JOB = isWindows ? "ping -n 11 127.0.0.1 >nul" : "sleep 5";

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // best effort
  }
}

const created: Array<{ dir: string }> = [];

afterEach(async () => {
  while (created.length > 0) {
    const item = created.pop();
    if (item === undefined) continue;
    await new JobdClient({ stateDir: item.dir }).shutdown().catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    cleanupDir(item.dir);
  }
  delete process.env.PI_JOBD_STATE_DIR;
});

function harness(): { tools: Map<string, ToolDefinition>; ctx: SessionContext } {
  const dir = mkdtempSync(join(tmpdir(), "pi-jobd-ext-"));
  created.push({ dir });
  process.env.PI_JOBD_STATE_DIR = dir;
  const tools = new Map<string, ToolDefinition>();
  const api: ExtensionAPI = { registerTool: (tool) => tools.set(tool.name, tool) };
  registerJobTools(api);
  return { tools, ctx: { cwd: dir } };
}

async function call(
  tools: Map<string, ToolDefinition>,
  name: string,
  params: Record<string, unknown>,
  ctx: SessionContext,
): Promise<ToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return tool.execute("call", params, undefined, undefined, ctx);
}

function details(result: ToolResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

describe("extension: registration", () => {
  it("registers the seven one-action tools", () => {
    const { tools } = harness();
    assert.deepEqual([...tools.keys()].sort(), [
      "job_list",
      "job_log",
      "job_pause",
      "job_resume",
      "job_run",
      "job_status",
      "job_stop",
    ]);
    for (const tool of tools.values()) {
      assert.ok(tool.description.length > 0);
      assert.ok(tool.promptSnippet !== undefined && tool.promptSnippet.length > 0);
      assert.equal(tool.parameters.type, "object");
      assert.equal(typeof tool.execute, "function");
    }
  });
});

describe("extension: run → status → log → stop", () => {
  it("runs a job and exposes honest states", async () => {
    const { tools, ctx } = harness();
    const started = await call(tools, "job_run", { command: ECHO_JOB }, ctx);
    assert.equal(details(started).status, "started");
    const jobId = details(started).jobId;
    assert.equal(typeof jobId, "string");

    const status = await call(tools, "job_status", { jobId }, ctx);
    assert.equal(details(status).state, "running");

    await new Promise((r) => setTimeout(r, 250));
    const log = await call(tools, "job_log", { jobId, lines: 5 }, ctx);
    assert.match(log.content[0]!.text, /ext-ok/);

    const listed = await call(tools, "job_list", {}, ctx);
    assert.equal(details(listed).count, 1);

    const stopped = await call(tools, "job_stop", { jobId }, ctx);
    assert.equal(details(stopped).status, "stopped");

    const after = await call(tools, "job_status", { jobId }, ctx);
    assert.equal(details(after).state, "stopped");
  });

  it("pause refuses a non-pausable job", async () => {
    const { tools, ctx } = harness();
    const started = await call(tools, "job_run", { command: LONG_JOB }, ctx);
    const jobId = details(started).jobId;
    const paused = await call(tools, "job_pause", { jobId }, ctx);
    assert.equal(details(paused).status, "not_pausable");
    await call(tools, "job_stop", { jobId }, ctx);
  });

  it("unknown job ids are honest not_found", async () => {
    const { tools, ctx } = harness();
    for (const name of ["job_status", "job_log", "job_stop"]) {
      const res = await call(tools, name, { jobId: "j_nope" }, ctx);
      assert.equal(details(res).status, "not_found", name);
    }
  });
});
