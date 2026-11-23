// tsup.config.ts - build the CLI into a single ESM bundle (dist/cli.js).
//
// WHY THE `define` MATTERS: `start` copies the built dist/cli.js to
// ~/.marginfront-ccc/cli.js so launchd can run the meter forever, from a directory
// that has NO package.json one level up. Reading the version with
// require("../package.json") at runtime would throw THERE and crash the daemon on
// every launch (an invisible KeepAlive respawn loop). So we bake the version in AT
// BUILD TIME as the literal __CCC_VERSION__ - the bundle then carries its own
// version and works from any location. forwarder.ts reads __CCC_VERSION__ first
// and only falls back to a runtime package.json read when running FROM SOURCE
// (tests/dev), where this define isn't applied. Keeping the version sourced from
// the one package.json means it can't drift from the version in package.json.
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
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  // Generate dist/cli.d.ts (the published types).
  dts: true,
  // Wipe dist/ before each build so a stale artifact can never ship.
  clean: true,
  // Replace every __CCC_VERSION__ token in the source with the real version string
  // at build time. JSON.stringify makes it a quoted string literal in the output.
  define: {
    __CCC_VERSION__: JSON.stringify(version),
  },
});
