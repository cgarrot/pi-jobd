/**
 * src/extension/ctl.ts — remote job control from pi-mesh (the TARGET side).
 *
 * pi-mesh never imports this package: it emits `mesh-ctl` on the local event
 * bus with an already-authorized action. This handler answers on
 * `mesh-ctl:reply:<ctlId>` with an honest status.
 *
 * Ownership rule: only a job whose `owner` is THIS session's mesh alias can be
 * controlled remotely. Jobs started from the CLI (OS user) are not remotely
 * controllable by a peer — a deliberate boundary.
 */
import { JobdClient, JobdError } from "../client.js";
import type { EventBusApi, ExtensionAPI } from "./pi-types.js";

interface MeshCtlRequest {
  ctlId?: unknown;
  action?: unknown;
  target?: unknown;
}

interface MeshCtlReply {
  status: string;
  reason?: string;
  settled?: boolean;
}

function asRequest(raw: unknown): { ctlId: string; action: string; target: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const req = raw as MeshCtlRequest;
  if (typeof req.ctlId !== "string" || typeof req.action !== "string" || typeof req.target !== "string") return undefined;
  return { ctlId: req.ctlId, action: req.action, target: req.target };
}

/** Map a daemon error to the ctl_ack vocabulary (never a generic success). */
function errorStatus(err: unknown): MeshCtlReply {
  if (err instanceof JobdError) {
    if (err.code === "not_found") return { status: "not_found" };
    if (err.code === "identity_mismatch") return { status: "identity_mismatch", reason: err.message };
    return { status: "error", reason: `${err.code}: ${err.message}` };
  }
  return { status: "error", reason: err instanceof Error ? err.message : String(err) };
}

async function handleRequest(req: { ctlId: string; action: string; target: string }, events: EventBusApi): Promise<void> {
  const reply = (payload: MeshCtlReply): void => {
    try {
      events.emit(`mesh-ctl:reply:${req.ctlId}`, payload);
    } catch {
      // The sender will report an honest timeout if the bus is gone.
    }
  };

  if (!req.action.startsWith("job_")) return; // not a job action: another extension owns it

  const localAlias = process.env.PI_MESH_ALIAS;
  if (localAlias === undefined || localAlias === "") {
    reply({ status: "not_authorized", reason: "this session has no mesh identity" });
    return;
  }

  // A remote control must never auto-spawn a daemon just to answer
  // "not found": the target must already be running.
  const client = new JobdClient({ autoStart: false });
  try {
    await client.ping(700);
  } catch {
    reply({ status: "error", reason: "jobd is not running (no daemon to control)" });
    return;
  }
  const job = await client.status(req.target).catch(() => undefined);
  if (job === undefined) {
    reply({ status: "not_found" });
    return;
  }
  if (job.owner !== localAlias) {
    reply({ status: "not_authorized", reason: "job owned by another alias" });
    return;
  }

  try {
    if (req.action === "job_stop") {
      const result = await client.stop(req.target);
      reply({ status: "stopped", settled: true, reason: result.killed ? "SIGKILL" : undefined });
      return;
    }
    if (req.action === "job_pause") {
      const result = await client.pause(req.target);
      reply({ status: result.status, settled: true });
      return;
    }
    if (req.action === "job_resume") {
      const result = await client.resume(req.target);
      reply({ status: result.status, settled: true });
      return;
    }
    reply({ status: "unsupported" });
  } catch (err) {
    reply(errorStatus(err));
  }
}

/** Register the mesh-ctl handler (no-op when the host has no event bus). */
export function registerMeshCtl(pi: ExtensionAPI): void {
  const events = pi.events;
  if (events === undefined || typeof events.on !== "function") return;
  events.on("mesh-ctl", (raw) => {
    const req = asRequest(raw);
    if (req === undefined) return;
    void handleRequest(req, events).catch(() => {
      try {
        events.emit(`mesh-ctl:reply:${req.ctlId}`, { status: "error", reason: "handler crashed" });
      } catch {
        // best effort
      }
    });
  });
}
