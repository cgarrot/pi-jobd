// test/guidelines.test.ts — tool metadata shape guard.
//
// Regression for pi-mesh#19, which this package had too: pi's codemode calls
// `guidelines.flatMap(...)` directly (`dist/extensions/codemode/tool.js`), so
// a bare string throws "guidelines.flatMap is not a function" — EVERY codemode
// script fails — and the system prompt iterates the string, rendering one
// bullet per CHARACTER.
//
// The local ToolDefinition mirror is now typed `string[]` (tsc blocks a plain
// string), but this runtime check also catches an `as any` cast and applies to
// any tool, not just the ones that had it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerJobTools } from "../src/extension/tools.js";
import type { ExtensionAPI, ToolDefinition } from "../src/extension/pi-types.js";

function collectTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => void tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerJobTools(pi);
  return tools;
}

describe("tool metadata: promptGuidelines", () => {
  it("every registered tool declares promptGuidelines as a string[]", () => {
    const tools = collectTools();
    assert.equal(tools.size, 7, "expected the seven job_* tools");

    const offenders: string[] = [];
    for (const [name, def] of tools) {
      const guidelines = (def as { promptGuidelines?: unknown }).promptGuidelines;
      if (guidelines === undefined) continue;
      if (!Array.isArray(guidelines)) {
        offenders.push(`${name}: ${typeof guidelines} (pi calls guidelines.flatMap — this breaks codemode)`);
        continue;
      }
      for (const [i, entry] of guidelines.entries()) {
        if (typeof entry !== "string") offenders.push(`${name}[${i}]: ${typeof entry}, expected string`);
      }
    }
    assert.deepEqual(offenders, [], "promptGuidelines must be string[]");
  });

  it("no guideline is multi-line or padded", () => {
    for (const [name, def] of collectTools()) {
      const guidelines = def.promptGuidelines;
      if (guidelines === undefined) continue;
      for (const [i, entry] of guidelines.entries()) {
        assert.equal(entry.includes("\n"), false, `${name}[${i}] must not contain a newline`);
        assert.equal(entry, entry.trim(), `${name}[${i}] must be trimmed`);
        assert.ok(entry.length > 0, `${name}[${i}] must not be empty`);
      }
    }
  });

  it("the when-to-use rule survives in job_run", () => {
    // The whole point of the skill+guidelines layer: the model must be able to
    // find the threshold rule without loading the skill file.
    const run = collectTools().get("job_run");
    assert.ok(run?.promptGuidelines !== undefined);
    const text = run.promptGuidelines.join(" ");
    assert.match(text, /60-90 s/, "the duration threshold must be stated");
    assert.match(text, /Use bash instead/, "the counter-rule (when NOT to use it) must be stated");
    assert.match(text, /never poll in a loop/, "the no-polling rule must be stated");
  });
});
