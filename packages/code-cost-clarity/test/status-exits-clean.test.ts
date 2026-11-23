// status-exits-clean.test.ts: `status` exits cleanly on Windows and finds Codex.
//
// On native Windows, a process.exit the moment cmdStatus returns races libuv's
// async-signal teardown (a background thread signals a handle the exit already began
// closing), so `node ~/.marginfront-ccc/cli.js status` can print the whole checklist
// and then die with a libuv assertion (UV_HANDLE_CLOSING, src/win/async.c). Pipe
// close is not the trigger. Short commands set process.exitCode and drain instead.
//
// WHAT THIS FILE PROVES, AND WHERE. The first test runs the BUILT CLI as a child
// process, the way a user runs it, in a throwaway home staged like a real install:
// a saved key, Claude telemetry wired, Codex present, Spend Control armed with a
// trusted hook. Codex is a fake `codex` executable on PATH that answers the app-server
// handshake, so the code path that can crash on Windows runs here, with no real
// Codex and no network.
//
// WHAT IT CAN CATCH, PER PLATFORM. The libuv assertion is Windows-only. On macOS and
// Linux this test proves only that the drained exit prints the checklist, exits 0,
// and does not hang. On the windows-latest lane (.github/workflows/ccc-windows.yml)
// an immediate process.exit fails the stderr assertion. Because the crash is a
// teardown race, it may only trip some of the time, so read this test as a
// guard for exit code, no hang, and the app-server path firing, plus an
// opportunistic crash detector, not as proof of the Windows behavior on its own.
//
// WHY THE FAKE CODEX IS A COPY OF NODE, NOT A .cmd. codexHooksList spawns "codex"
// without a shell. libuv's PATH search on Windows tries .com and .exe only, and Node
// refuses to spawn a .cmd/.bat directly (CVE-2024-27980), so a codex.cmd on PATH is
// not found. What IS found is codex.exe, and node.exe under that name behaves
// like node: `codex app-server` runs the file named app-server in the CLI's cwd.
// That file is the fake app-server below. On POSIX the same trick is a symlink.

import { test, expect, beforeAll, afterAll, describe } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CODEX_CAP_HOOK_WRAPPER_PATH,
  CODEX_CONTROL_HOOK_OWNERSHIP_PATH,
  CODEX_HOOKS_PATH,
  CODEX_HOOK_STATUS_MESSAGE,
  codexControlHookCommand,
  writeCodexCapHookWrapper,
  writeCodexControlHook,
} from "../src/control";
import {
  CCC_TELEMETRY_VALUES,
  CLAUDE_SETTINGS_OWNERSHIP_PATH,
  CLAUDE_SETTINGS_PATH,
  CODEX_CONFIG_PATH,
  ENV_PATH,
  writeApiKeyToEnv,
  writeClaudeTelemetrySettings,
  writeCodexOtelConfig,
} from "../src/connector";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const isWindows = process.platform === "win32";

// Built into a private directory, not the shared dist/. Other test files rebuild
// dist/ in their own beforeAll, and tsup empties it first, so a child launched from
// dist/cli.js can find no file there for a moment. The bundle has no runtime
// imports, so it runs from anywhere.
const privateDist = mkdtempSync(join(tmpdir(), "ccc-status-clean-dist-"));
const builtCliPath = join(privateDist, "cli.js");

// The command must finish well inside this; a leaked handle would hold the loop
// until the safety net fires, and the test pushes that net past the deadline so a
// leak fails as a timeout instead of hiding behind the backstop.
const COMMAND_DEADLINE_MS = 30_000;
const SAFETY_NET_BEYOND_DEADLINE_MS = String(COMMAND_DEADLINE_MS * 2);

beforeAll(() => {
  execFileSync("npm", ["run", "build", "--", "--out-dir", privateDist], {
    cwd: packageRoot,
    stdio: "ignore",
    // npm is npm.cmd on Windows, and execFile refuses to spawn a batch file directly.
    shell: isWindows,
  });
}, 180_000);

afterAll(() => {
  rmSync(privateDist, { recursive: true, force: true });
});

// The suite's own HOME is already a throwaway (test/helpers/no-real-home.ts), but the
// CLI child gets its own so nothing this test stages can collide with another file.
// Every path the CLI derives from homedir() is rebuilt under that home by taking the
// production constant's shape relative to this process's home.
function underHome(home: string, productionPath: string): string {
  return join(home, relative(homedir(), productionPath));
}

function pathEnvKey(): string {
  return (
    Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
    "PATH"
  );
}

interface TestMachine {
  root: string;
  home: string;
  cwd: string;
  binDir: string;
  appServerRanMarker: string;
  env: NodeJS.ProcessEnv;
}

// Speaks enough of the app-server protocol for the trust check: answers
// initialize, then answers hooks/list with our hook trusted and enabled, then stays
// up until killed, exactly like the real thing. The marker file is written when the
// hooks/list request arrives, so the test can prove this path actually fired.
function fakeAppServerSource(hookCommand: string, marker: string): string {
  return [
    'const { writeFileSync } = require("node:fs");',
    `const HOOK_COMMAND = ${JSON.stringify(hookCommand)};`,
    `const STATUS_MESSAGE = ${JSON.stringify(CODEX_HOOK_STATUS_MESSAGE)};`,
    `const MARKER = ${JSON.stringify(marker)};`,
    "let buffer = '';",
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  buffer += chunk;",
    "  let newline;",
    '  while ((newline = buffer.indexOf("\\n")) !== -1) {',
    "    const line = buffer.slice(0, newline).trim();",
    "    buffer = buffer.slice(newline + 1);",
    "    if (!line) continue;",
    "    const message = JSON.parse(line);",
    "    if (message.id === 1) {",
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");',
    "    } else if (message.id === 2) {",
    '      writeFileSync(MARKER, "hooks/list answered\\n");',
    "      const hook = {",
    '        key: "user:pre_tool_use:0:0",',
    '        eventName: "preToolUse",',
    "        command: HOOK_COMMAND,",
    '        matcher: "*",',
    "        statusMessage: STATUS_MESSAGE,",
    '        source: "user",',
    "        enabled: true,",
    "        isManaged: false,",
    '        currentHash: "fake",',
    '        trustStatus: "trusted",',
    "      };",
    "      process.stdout.write(",
    '        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { data: [{ hooks: [hook], warnings: [], errors: [] }] } }) + "\\n",',
    "      );",
    "    }",
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

function stageTestMachine(): TestMachine {
  const root = mkdtempSync(join(tmpdir(), "ccc-status-clean-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const quiet = () => {};

  // A saved key.
  const envPath = underHome(home, ENV_PATH);
  mkdirSync(join(envPath, ".."), { recursive: true });
  writeApiKeyToEnv("mf_sk_test_status_exits_clean", envPath);

  // Claude telemetry wired.
  const settingsPath = underHome(home, CLAUDE_SETTINGS_PATH);
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeClaudeTelemetrySettings(CCC_TELEMETRY_VALUES, {
    settingsPath,
    ownershipPath: underHome(home, CLAUDE_SETTINGS_OWNERSHIP_PATH),
    log: quiet,
  });

  // Codex present (its config dir exists) and its capture wired.
  writeCodexOtelConfig({
    configPath: underHome(home, CODEX_CONFIG_PATH),
    log: quiet,
  });

  // Spend Control armed on the Codex side, with the receipt that makes
  // isCodexControlArmed() true inside the CLI child.
  const wrapperPath = underHome(home, CODEX_CAP_HOOK_WRAPPER_PATH);
  mkdirSync(join(wrapperPath, ".."), { recursive: true });
  writeCodexCapHookWrapper(wrapperPath);
  const wired = writeCodexControlHook({
    hooksPath: underHome(home, CODEX_HOOKS_PATH),
    ownershipPath: underHome(home, CODEX_CONTROL_HOOK_OWNERSHIP_PATH),
    wrapperPath,
    codexInstalled: true,
    log: quiet,
  });
  if (wired.action !== "added") {
    throw new Error(`staging failed: Codex hook was ${wired.action}`);
  }

  // The fake codex: node under another name, plus the app-server script it will run
  // from the CLI's cwd.
  const appServerRanMarker = join(root, "app-server.ran");
  writeFileSync(
    join(cwd, "app-server"),
    fakeAppServerSource(
      codexControlHookCommand(wrapperPath),
      appServerRanMarker,
    ),
  );
  if (isWindows) {
    // A hard link, not a copy. Copying node.exe writes a whole new multi-megabyte
    // binary for Defender to scan, and CreateProcess on a file still being
    // scanned comes back as a spawn error - which the CLI reports as "Codex isn't on
    // this machine". A link needs no
    // privileges (unlike a symlink) and produces no new bytes to scan. It only works
    // within one volume, so a copy stays as the fallback.
    const fakeCodex = join(binDir, "codex.exe");
    try {
      linkSync(process.execPath, fakeCodex);
    } catch {
      copyFileSync(process.execPath, fakeCodex);
    }
    // On windows-latest the bare name "codex" can come back ENOENT with binDir
    // first on Path while the absolute path starts fine. Windows searches the
    // working directory before Path, and the CLI
    // runs with cwd = this directory, so a second link there resolves the bare name
    // with no dependence on the Path lookup at all.
    const fakeCodexInCwd = join(cwd, "codex.exe");
    try {
      linkSync(process.execPath, fakeCodexInCwd);
    } catch {
      copyFileSync(process.execPath, fakeCodexInCwd);
    }
  } else {
    symlinkSync(process.execPath, join(binDir, "codex"));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    // libuv's os.homedir() reads USERPROFILE on Windows, not HOME.
    USERPROFILE: home,
    CI: "1",
    CCC_DRAIN_TIMEOUT_MS: SAFETY_NET_BEYOND_DEADLINE_MS,
  };
  env[pathEnvKey()] = `${binDir}${delimiter}${process.env[pathEnvKey()] ?? ""}`;

  return { root, home, cwd, binDir, appServerRanMarker, env };
}

// WIN32-ONLY DIAGNOSTICS. When the spawn of the bare name "codex" emits an error
// event, the CLI prints "Codex isn't on this machine" and the vitest JSON carries
// only the assertion text, so the errno that fired is lost. These lines run only on
// win32, run AFTER the CLI has had its turn (so they cannot
// warm a binary the CLI found cold), and land in both the console and the failure
// transcript. Between them they separate the three candidates: PATH never carried
// binDir, the PATH lookup of a bare name failed, or the staged executable itself
// could not be started.
function windowsSpawnDiagnostics(machine: TestMachine): string {
  if (!isWindows) return "";
  const pathKey = pathEnvKey();
  const pathValue = machine.env[pathKey] ?? "";
  const fakeCodex = join(machine.binDir, "codex.exe");
  const options = {
    encoding: "utf8" as const,
    cwd: machine.cwd,
    env: machine.env,
    timeout: 30_000,
  };
  const describeRun = (label: string): string => {
    const run =
      label === "bare"
        ? spawnSync("codex", ["--version"], options)
        : spawnSync(fakeCodex, ["--version"], options);
    const failure = run.error as NodeJS.ErrnoException | undefined;
    return [
      `  ${label}: status=${String(run.status)} signal=${String(run.signal)}`,
      `    error.code=${failure?.code ?? "none"}`,
      `    error.message=${failure?.message ?? "none"}`,
      `    stdout=${JSON.stringify(
        String(run.stdout ?? "")
          .trim()
          .slice(0, 200),
      )}`,
      `    stderr=${JSON.stringify(
        String(run.stderr ?? "")
          .trim()
          .slice(0, 200),
      )}`,
    ].join("\n");
  };
  return [
    "--- win32 spawn diagnostics ---",
    `  PATH variable name: ${pathKey}`,
    `  PATH head: ${pathValue.split(delimiter).slice(0, 3).join(delimiter)}`,
    `  binDir on PATH first: ${pathValue.split(delimiter)[0] === machine.binDir}`,
    `  ${fakeCodex}: exists=${existsSync(fakeCodex)} bytes=${
      existsSync(fakeCodex) ? statSync(fakeCodex).size : 0
    }`,
    describeRun("bare"),
    describeRun("absolute"),
  ].join("\n");
}

describe("status exits clean after the Codex trust check", () => {
  test("the built CLI prints the checklist, answers the app-server, and exits 0 with no libuv assertion", () => {
    const machine = stageTestMachine();
    try {
      const started = Date.now();
      const run = spawnSync(process.execPath, [builtCliPath, "status"], {
        encoding: "utf8",
        cwd: machine.cwd,
        env: machine.env,
        timeout: COMMAND_DEADLINE_MS,
      });
      const elapsedMs = Date.now() - started;
      const diagnostics = windowsSpawnDiagnostics(machine);
      if (diagnostics) console.log(diagnostics);
      const transcript =
        `--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}` +
        (diagnostics ? `\n${diagnostics}` : "");

      expect(run.stderr, transcript).not.toContain("Assertion failed");
      expect(run.stderr, transcript).not.toContain("UV_HANDLE_CLOSING");
      expect(run.signal, transcript).toBeNull();
      expect(run.status, transcript).toBe(0);
      expect(elapsedMs).toBeLessThan(COMMAND_DEADLINE_MS);

      expect(run.stdout, transcript).toContain("  Key:         OK.");
      expect(run.stdout, transcript).toContain(
        "  Codex:       OK. Cap check trusted. Nothing to do.",
      );
      expect(run.stdout, transcript).toContain("CCC version ");
      // The trust check really spawned the fake app-server and got as far as
      // hooks/list; without this, a green run could mean the path never fired.
      expect(existsSync(machine.appServerRanMarker), transcript).toBe(true);
    } finally {
      rmSync(machine.root, { recursive: true, force: true });
    }
  });
});

describe("the drain safety net", () => {
  // A ref'd interval stands in for a leaked handle. Without the net this process
  // would run forever; with it, the exit code is the one the command returned.
  test("exits with the command's code when the loop has not drained in time", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-drain-net-"));
    const script = [
      `import { armDrainSafetyNet } from ${JSON.stringify(pathToFileURL(builtCliPath).href)};`,
      "setInterval(() => {}, 1000);",
      "armDrainSafetyNet(7, 200);",
    ].join("\n");
    try {
      const started = Date.now();
      const run = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: home, USERPROFILE: home, CI: "1" },
          timeout: 10_000,
        },
      );
      expect(run.signal).toBeNull();
      expect(run.status).toBe(7);
      expect(run.stdout + run.stderr).toBe("");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
