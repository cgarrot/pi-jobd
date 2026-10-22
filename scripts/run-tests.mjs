// scripts/run-tests.mjs — portable test runner (pi-mesh mirror, recursive).
//
// Why: `node --test <dir>` changed behavior in newer Node versions (Node 24
// treats a directory arg as a file → MODULE_NOT_FOUND), and glob args need
// Node ≥ 21. Passing the compiled test files as EXPLICIT arguments works on
// every supported Node version and platform. Discovery is recursive to support
// nested suites (test/core/, test/gates/, ...).
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "test",
);

function collectTestFiles(current) {
  if (!existsSync(current)) return [];
  const out = [];
  for (const entry of readdirSync(current).sort()) {
    const full = path.join(current, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

const files = collectTestFiles(dir);

if (files.length === 0) {
  console.error(`no *.test.js files under ${dir} — compile first with \`npx tsc -p tsconfig.json\``);
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, PI_SUBAGENTS_USER_AGENTS_DIR: "" },
});
process.exit(res.status ?? 1);
