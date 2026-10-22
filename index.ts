/**
 * pi-jobd — root Pi extension entry point.
 *
 * Thin adapter only: the tools live in src/extension/tools.ts, the daemon in
 * src/daemon.ts. The daemon is per user, not per session.
 */
import { registerJobTools } from "./src/extension/tools.js";
import { registerMeshCtl } from "./src/extension/ctl.js";
import type { ExtensionAPI } from "./src/extension/pi-types.js";

export default function jobdExtension(pi: ExtensionAPI): void {
  registerJobTools(pi);
  // Remote job control from pi-mesh: the mesh emits `mesh-ctl` locally after
  // its own policy check; this handler enforces the job-owner rule.
  registerMeshCtl(pi);
}
