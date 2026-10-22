#!/usr/bin/env node
// scripts/mesh-control-smoke.mjs — cross-package E2E (dev only, not CI):
// pi-mesh ctl handler  ->  local event bus  ->  pi-jobd handler  ->  ack.
//
// This is the contract the two packages share. It imports the sibling
// pi-mesh build with a relative path, so run it from this checkout only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleCtlFrame } from "../../pi-mesh/dist/src/extension/ctl.js";
import { buildFrame } from "../../pi-mesh/dist/src/protocol/envelope.js";
import { registerMeshCtl } from "../dist/src/extension/ctl.js";
import { JobdClient } from "../dist/src/client.js";

const isWindows = process.platform === "win32";
const LONG = isWindows ? "ping -n 61 127.0.0.1 >nul" : "sleep 60";
const stateDir = mkdtempSync(join(tmpdir(), "pi-jobd-mesh-smoke-"));

function bus() {
  const handlers = new Map();
  return {
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
  };
}

async function main() {
  process.env.PI_JOBD_STATE_DIR = stateDir;
  process.env.PI_MESH_ALIAS = "bob";
  const events = bus();
  registerMeshCtl({ events });

  const client = new JobdClient({ stateDir });
  const job = await client.run({ command: LONG, owner: "bob" });
  console.log("started", job.jobId, "pid", job.pid);

  const acks = [];
  const rt = {
    client: { alias: "bob", sendCtlAck: (ack) => acks.push(ack) },
    ctx: { abort: () => {}, isIdle: () => true },
  };
  const pi = { sendMessage: () => {}, events };

  const frame = buildFrame({
    type: "ctl",
    id: "m_smoke_1",
    from: "alice",
    to: "bob",
    room: "default",
    action: "job_stop",
    target: job.jobId,
  });
  await handleCtlFrame(rt, frame, pi, { localTimeoutMs: 5_000 });
  console.log("ack:", JSON.stringify(acks[0]));
  assert.equal(acks[0]?.status, "stopped", "the job must be stopped");
  assert.equal(acks[0]?.settled, true);
  const after = await client.status(job.jobId);
  assert.equal(after?.state, "stopped");
  console.log("PASS: pi-mesh ctl -> pi-jobd -> ctl_ack");

  await client.shutdown();
  rmSync(stateDir, { recursive: true, force: true });
}

main().catch(async (err) => {
  console.error("SMOKE FAILED:", err);
  try {
    await new JobdClient({ stateDir }).shutdown();
  } catch {
    // ignore
  }
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(1);
});
