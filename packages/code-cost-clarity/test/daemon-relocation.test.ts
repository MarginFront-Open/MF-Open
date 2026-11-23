// daemon-relocation.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS GUARDS: `start` copies the BUILT dist/cli.js to
// ~/.marginfront-ccc/cli.js and points launchd at it. From that location there is
// NO package.json one level up. A module-load-time require("../package.json")
// would throw MODULE_NOT_FOUND, killing `node cli.js run` on startup - and under
// launchd's KeepAlive that's an invisible respawn loop every ~10 seconds, forever.
//
// WHY THE OTHER TESTS CAN'T CATCH THIS: the dependency-injected unit tests never
// EXECUTE the real built bundle from a relocated path - they import the source and
// stub launchctl. This failure only appears when the actual artifact runs standalone.
// So this test does exactly what `start` does: build the real bundle, copy cli.js
// into a temp dir whose parent has no package.json, and actually SPAWN `node <copy>`
// - then assert it loads and runs WITHOUT a module-resolution crash.
//
// This is a REAL integration test: it shells out to the real `node` against the real
// built artifact. It does NOT touch real launchd, the real ~/.marginfront-ccc, or
// ~/.claude - the `run` case points HOME at a throwaway temp dir so it can only ever
// hit the "Not set up" guard, never spawn a real collector.
// ---------------------------------------------------------------------------

import { test, expect, beforeAll } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLECTOR_BIN_PATH, COLLECTOR_CONFIG_PATH } from "../src/connector";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const builtCliPath = join(packageRoot, "dist", "cli.js");
const realVersion = (
  JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;

// Read right after this file's own build: other test files rebuild dist/ in
// parallel (tsup cleans it first), so reading dist/cli.js later can race them.
let builtBundle = "";

// Build the REAL bundle once before these tests - this is what production ships and
// exactly what `start` copies into ~/.marginfront-ccc. We test the real artifact,
// never a stand-in. (The build also applies tsup's __CCC_VERSION__ define, so this
// doubles as proof the version is inlined and survives relocation.)
beforeAll(() => {
  execFileSync("npm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "ignore",
    // On Windows there is no `npm` - there is `npm.cmd`, a batch file, and
    // execFileSync will not spawn one (Node refuses since CVE-2024-27980). Without
    // shell:true this throws "spawnSync npm ENOENT" on Windows. shell:true lets
    // cmd.exe resolve the .cmd; POSIX keeps the no-shell spawn. Nothing
    // user-supplied is in this command.
    shell: process.platform === "win32",
  });
  builtBundle = readFileSync(builtCliPath, "utf8");
}, 180_000);

// Copy the built cli.js into a temp dir nested one level deep, so the copy has NO
// package.json at `../package.json` - mirroring ~/.marginfront-ccc/cli.js, whose
// parent (~) has no package.json. Node resolves a relative require like
// "../package.json" to exactly that path (no upward node_modules walk), so this
// reproduces the real daemon layout faithfully.
function relocateBuiltCli(): { dir: string; copiedCliPath: string } {
  const base = mkdtempSync(join(tmpdir(), "ccc-relocated-"));
  const dir = join(base, "marginfront-ccc");
  mkdirSync(dir, { recursive: true });
  const copiedCliPath = join(dir, "cli.js");
  copyFileSync(builtCliPath, copiedCliPath);
  return { dir: base, copiedCliPath };
}

// ---------------------------------------------------------------------------
// 1. The headline assertion: `node <copied cli.js> version` from a relocated path
//    must NOT crash at module load and must exit 0 - and print the REAL version,
//    which is only possible because the build-time define inlined it (a relocated
//    copy cannot read package.json at runtime).
// ---------------------------------------------------------------------------
test("relocated bundle: `node <copied cli.js> version` exits 0 with no module-resolution crash and prints the real version", () => {
  const { dir, copiedCliPath } = relocateBuiltCli();
  try {
    const result = spawnSync(process.execPath, [copiedCliPath, "version"], {
      encoding: "utf8",
      cwd: dir, // a cwd that also has no package.json - belt and suspenders
    });

    // It must NOT have crashed at module load.
    expect(result.stderr).not.toMatch(/MODULE_NOT_FOUND/);
    expect(result.stderr).not.toMatch(/Cannot find module/);
    // It exited cleanly.
    expect(result.status).toBe(0);
    // And printed the EXACT real version - proving the build-time inline worked.
    // (If it fell back to the never-throw placeholder, this would read
    // "0.0.0-unknown" and fail here.)
    expect(result.stdout.trim()).toBe(realVersion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The `run` case - the command launchd actually runs. We point HOME at an empty
//    temp dir so the relocated CLI uses an EMPTY ~/.marginfront-ccc: with no
//    collector binary it hits the friendly "Not set up" guard and exits, WITHOUT
//    spawning a real collector or touching the developer's real config. The point
//    is only to prove the bundle LOADS and `run` dispatches past module-init, which
//    is what a module-load require of ../package.json would break.
// ---------------------------------------------------------------------------
test("relocated bundle: `node <copied cli.js> run` loads and reaches its setup check (no module-init crash)", () => {
  const { dir, copiedCliPath } = relocateBuiltCli();
  const fakeHome = mkdtempSync(join(tmpdir(), "ccc-home-"));
  try {
    const result = spawnSync(process.execPath, [copiedCliPath, "run"], {
      encoding: "utf8",
      cwd: dir,
      // Empty home => empty ~/.marginfront-ccc => "Not set up", no collector spawned.
      // USERPROFILE as well as HOME because os.homedir() reads USERPROFILE on Windows
      // (libuv uv_os_homedir); HOME alone would point the child at the runner's REAL
      // profile there.
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        MARGINFRONT_API_KEY: "",
      },
    });

    // The crash we're guarding against would surface here as a module error...
    expect(result.stderr).not.toMatch(/MODULE_NOT_FOUND/);
    expect(result.stderr).not.toMatch(/Cannot find module/);
    // ...instead it reached main() -> cmdRun and hit the friendly setup guard,
    // which proves the whole bundle loaded (forwarder.ts module-init included).
    expect(result.stderr).toMatch(/Not set up/);
    expect(result.status).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. WHERE THE BUILT BUNDLE SENDS. The bundle is one file, so anything read when
//    a module loads is read before the settings file is copied into the
//    environment. These run the real artifact the way the background meter runs
//    it: from its relocated home, with the server named ONLY in the settings file.
// ---------------------------------------------------------------------------
const SETTINGS_DIR_NAME = ".marginfront-ccc";
const SETTINGS_FILE_NAME = [".", "env"].join("");
const BUNDLE_TEST_KEY = "mf_sk_bundle_test_key_0123456789abcdef";

function homeWithSettings(lines: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "ccc-home-"));
  mkdirSync(join(home, SETTINGS_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, SETTINGS_DIR_NAME, SETTINGS_FILE_NAME),
    [...lines, ""].join("\n"),
  );
  return home;
}

function bundleEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  delete env.MARGINFRONT_API_URL;
  delete env.MARGINFRONT_ALLOW_INSECURE_HTTP;
  delete env.MARGINFRONT_INGEST_URL;
  delete env.MARGINFRONT_API_KEY;
  delete env.CCC_DEVELOPER_EMAIL;
  delete env.CCC_IGNORE_REPOS;
  return env;
}

interface SeenRequest {
  method: string;
  url: string;
  apiKey: string | undefined;
}

async function runBundle(
  cliPath: string,
  args: string[],
  home: string,
  cwd: string,
): Promise<{ status: number | null; output: string }> {
  // spawn, not spawnSync: the loopback server lives in THIS process, and a
  // synchronous spawn blocks the event loop that would answer the child's POST.
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: bundleEnv(home),
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const status = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  return { status, output };
}

test("relocated bundle: a server named only in the settings file is where it sends, path prefix and all", async () => {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      apiKey: request.headers["x-api-key"] as string | undefined,
    });
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: { success: [] } }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const { dir, copiedCliPath } = relocateBuiltCli();
  const home = homeWithSettings([
    `MARGINFRONT_API_URL=http://127.0.0.1:${port}/billing/v1`,
    `MARGINFRONT_API_KEY=${BUNDLE_TEST_KEY}`,
    "CCC_DEVELOPER_EMAIL=sam@example.com",
  ]);
  try {
    const run = await runBundle(
      copiedCliPath,
      ["done", "contract summarized", "--agent", "claude-code"],
      home,
      dir,
    );
    expect(run.output).toContain("contract summarized");
    expect(run.status).toBe(0);
    expect(seen).toEqual([
      {
        method: "POST",
        url: "/billing/v1/sdk/usage/record",
        apiKey: BUNDLE_TEST_KEY,
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("relocated bundle: with no server set, `done` counts nothing and says what to set", async () => {
  const { dir, copiedCliPath } = relocateBuiltCli();
  const home = homeWithSettings([
    `MARGINFRONT_API_KEY=${BUNDLE_TEST_KEY}`,
    "CCC_DEVELOPER_EMAIL=sam@example.com",
  ]);
  try {
    const run = await runBundle(
      copiedCliPath,
      ["done", "contract summarized", "--agent", "claude-code"],
      home,
      dir,
    );
    expect(run.status).toBe(2);
    expect(run.output).toContain("MARGINFRONT_API_URL");
    expect(run.output).toContain("Nothing was counted");
    expect(run.output).not.toMatch(/marginfront\.com/i);
    expect(run.output).not.toContain(BUNDLE_TEST_KEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

// The command the background job runs. The two collector files only have to exist
// for `run` to get as far as its settings checks; it stops before starting either.
test("relocated bundle: `run` with a key but no server stops before starting anything", () => {
  const { dir, copiedCliPath } = relocateBuiltCli();
  const home = homeWithSettings([`MARGINFRONT_API_KEY=${BUNDLE_TEST_KEY}`]);
  writeFileSync(
    join(home, SETTINGS_DIR_NAME, basename(COLLECTOR_BIN_PATH)),
    "",
  );
  writeFileSync(
    join(home, SETTINGS_DIR_NAME, basename(COLLECTOR_CONFIG_PATH)),
    "",
  );
  try {
    for (const lines of [
      [],
      ["MARGINFRONT_API_URL=http://billing.internal:4000/v1"],
      ["MARGINFRONT_INGEST_URL=http://localhost:4000/v1/sdk/usage/record"],
    ]) {
      writeFileSync(
        join(home, SETTINGS_DIR_NAME, SETTINGS_FILE_NAME),
        [`MARGINFRONT_API_KEY=${BUNDLE_TEST_KEY}`, ...lines, ""].join("\n"),
      );
      const result = spawnSync(process.execPath, [copiedCliPath, "run"], {
        encoding: "utf8",
        cwd: dir,
        env: bundleEnv(home),
        timeout: 30_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("The meter did not start");
      expect(result.stderr).toContain("MARGINFRONT_API_URL");
      expect(result.stderr).not.toMatch(/marginfront\.com/i);
      expect(result.stdout).not.toContain("Collector");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

test("built bundle: no marginfront.com host, no registry address, no @latest, and no update check", () => {
  const built = builtBundle;
  expect(built).not.toMatch(/marginfront\.com/i);
  expect(built).not.toMatch(/registry\.npmjs\.org|npmjs\.com/i);
  expect(built).not.toMatch(/@latest/);
  expect(built).not.toMatch(/checkForUpdate|fetchLatestPublishedVersion/);
  // The two that remain are block markers an earlier install may have written;
  // `uninstall` matches them to find and remove those blocks.
  const npxCommands = built.match(/npx @marginfront\/[^`"']*/g) ?? [];
  expect(npxCommands).toEqual([
    "npx @marginfront/code-cost-clarity uninstall",
    "npx @marginfront/code-cost-clarity uninstall",
  ]);
});
