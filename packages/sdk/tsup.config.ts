// Entry points, formats, dts, and clean stay as CLI flags on the `build`
// script; this file only injects the version. tsup replaces every
// __SDK_VERSION__ token with the real package.json version at build time
// (same pattern as packages/code-cost-clarity/tsup.config.ts), so the
// reported User-Agent cannot drift from the published version.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const packageJsonPath = fileURLToPath(
  new URL("./package.json", import.meta.url),
);
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(version),
  },
});
