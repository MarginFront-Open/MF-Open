import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODE_COST_CLARITY = "@marginfront/code-cost-clarity";
const extraTurboArgs = process.argv.slice(2);

function run(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, CI: "true", ...env },
  });
  return result.status ?? 1;
}

const everyoneElse = run("npx", [
  "turbo",
  "run",
  "test",
  `--filter=!${CODE_COST_CLARITY}`,
  "--continue",
  ...extraTurboArgs,
]);

// code-cost-clarity tests install and remove hooks under HOME, and they refuse
// to run when HOME holds a real install. A throwaway HOME keeps your real
// ~/.claude and ~/.codex untouched.
const scratchHome = mkdtempSync(join(tmpdir(), "marginfront-ccc-home-"));
let codeCostClarity;
try {
  codeCostClarity = run(
    "npx",
    [
      "turbo",
      "run",
      "test",
      `--filter=${CODE_COST_CLARITY}`,
      ...extraTurboArgs,
    ],
    { HOME: scratchHome, USERPROFILE: scratchHome },
  );
} finally {
  rmSync(scratchHome, { recursive: true, force: true });
}

process.exit(everyoneElse !== 0 || codeCostClarity !== 0 ? 1 : 0);
