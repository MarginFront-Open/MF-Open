// Runs every standalone assert script under src/lib and fails
// the run if any of them do.
//
// These files are standalone `tsx` scripts rather than vitest suites, so the
// package's vitest config deliberately excludes them, and this runner is what
// executes them. `npm test` runs both halves.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const roots = ["lib"].map((d) => join(srcDir, d));

const files = roots
  .flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => join(dir, name)),
  )
  .sort();

if (files.length === 0) {
  console.error(
    "No assert scripts found under src/lib. Expected at least one.",
  );
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const label = relative(srcDir, file);
  const result = spawnSync("npx", ["tsx", file], {
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED: src/${label}`);
  }
}

console.log(
  `\nassert scripts: ${files.length - failed}/${files.length} passed`,
);
process.exit(failed === 0 ? 0 : 1);
