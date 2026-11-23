// windows-cmd-shims.test.ts: finding codex.cmd and npx.cmd on Windows.
//
// WHY THIS FILE EXISTS. Windows has no execute bit. npm installs its
// programs as batch shims - codex.cmd, npx.cmd - and CreateProcess, which is what
// Node's spawn calls when shell is false, appends only .exe to a bare name. So
// spawn("codex") and spawn("npx") find nothing on a machine where Codex and npx are
// installed and working: the Codex trust row in `status` would print CAN'T
// TELL and `codex doctor` would come back "unknown".
//
// WHAT IS RED WHERE.
//   - The resolver and launch-plan cases below run on EVERY platform, because the
//     platform is a parameter.
//   - The three cases that spawn a REAL fake shim are Windows-only. They run on
//     the windows-latest lane (.github/workflows/ccc-windows.yml), which fires on
//     every PR that touches this package. On macOS and Linux they are skipped,
//     not silently passed.
//   - The source gates run everywhere: cli.ts must not spawn the literal "npx",
//     and must not fall back to shell:true.
//
// Every fake lives in a temp directory. Nothing here reaches a real Codex, a real
// npm registry, or a real home.

import { test, expect, describe } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import * as ts from "typescript";
import {
  resolveBinaryOnPath,
  planBinaryLaunch,
  stopLaunchedProcess,
  type BinaryLaunch,
  type StoppableChild,
} from "../src/binary-path";
import {
  codexHooksList,
  codexDoctorConfigLoad,
  releaseAppServer,
} from "../src/codex-app-server";
import { srcFilePaths, readSrc } from "./helpers/source-strings";

const onWindows = process.platform === "win32";

// The presence list control.ts asks about: everything that proves Codex is here,
// launchable or not.
const CODEX_PRESENCE_SUFFIXES = ["", ".cmd", ".exe", ".bat", ".ps1"];

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ccc-${label}-`));
}

function pathEnvKey(): string {
  return (
    Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
    "PATH"
  );
}

// ---------------------------------------------------------------------------
// resolveBinaryOnPath - which file on PATH IS this program
// ---------------------------------------------------------------------------

describe("resolveBinaryOnPath", () => {
  test("finds the npm .cmd shim on a Windows PATH and hands back its full path", () => {
    const root = tempDir("resolve-cmd");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const shim = join(binDir, "codex.cmd");
    writeFileSync(shim, "@echo off\n");

    const resolved = resolveBinaryOnPath(
      "codex",
      CODEX_PRESENCE_SUFFIXES,
      `${join(root, "empty")};${binDir}`,
      "win32",
    );

    expect(resolved).toBe(shim);
    rmSync(root, { recursive: true, force: true });
  });

  test("prefers the .exe sitting next to the .cmd", () => {
    const root = tempDir("resolve-prefer");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex.cmd"), "@echo off\n");
    const real = join(binDir, "codex.exe");
    writeFileSync(real, "binary");

    const resolved = resolveBinaryOnPath(
      "codex",
      [".exe", ".cmd"],
      binDir,
      "win32",
    );

    expect(resolved).toBe(real);
    rmSync(root, { recursive: true, force: true });
  });

  test("an earlier PATH entry still wins over a later one", () => {
    const root = tempDir("resolve-order");
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const winner = join(first, "codex.cmd");
    writeFileSync(winner, "@echo off\n");
    writeFileSync(join(second, "codex.cmd"), "@echo off\n");

    expect(
      resolveBinaryOnPath(
        "codex",
        CODEX_PRESENCE_SUFFIXES,
        `${first};${second}`,
        "win32",
      ),
    ).toBe(winner);
    rmSync(root, { recursive: true, force: true });
  });

  test("nothing on PATH is null, not a guess", () => {
    const root = tempDir("resolve-absent");
    mkdirSync(join(root, "bin"));

    expect(
      resolveBinaryOnPath(
        "codex",
        CODEX_PRESENCE_SUFFIXES,
        join(root, "bin"),
        "win32",
      ),
    ).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  // Skipped on Windows, not weakened: every path there starts with a drive letter
  // and a colon, and a colon is the posix PATH separator, so a posix PATH made of
  // Windows temp directories cannot be spelled. The macOS and Linux lanes carry
  // this claim, which is where a posix claim belongs.
  test.skipIf(onWindows)("posix is unchanged: the exact name or nothing", () => {
    const root = tempDir("resolve-posix");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex.cmd"), "#!/bin/sh\n");

    // A .cmd on a Mac is not a program called codex, and never was.
    expect(
      resolveBinaryOnPath("codex", CODEX_PRESENCE_SUFFIXES, binDir, "linux"),
    ).toBeNull();

    const bare = join(binDir, "codex");
    writeFileSync(bare, "#!/bin/sh\n");
    expect(
      resolveBinaryOnPath("codex", CODEX_PRESENCE_SUFFIXES, binDir, "linux"),
    ).toBe(bare);
    rmSync(root, { recursive: true, force: true });
  });

  test("an empty PATH entry is skipped, not read as the current directory", () => {
    const root = tempDir("resolve-empty-entry");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex.exe"), "binary");

    expect(
      resolveBinaryOnPath("codex", [".exe"], `;;${binDir};`, "win32"),
    ).toBe(join(binDir, "codex.exe"));
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// planBinaryLaunch - how to hand that file to spawn
// ---------------------------------------------------------------------------

describe("planBinaryLaunch", () => {
  test("posix hands the name straight through, exactly as before", () => {
    const plan = planBinaryLaunch("codex", ["app-server"], {
      platform: "darwin",
      env: { PATH: "/usr/bin" },
    });

    expect(plan).toEqual({
      command: "codex",
      args: ["app-server"],
      windowsVerbatimArguments: false,
      viaCmdExe: false,
    });
  });

  test("a Windows .exe is spawned directly, with no shell in the way", () => {
    const root = tempDir("plan-exe");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex.exe"), "binary");

    const plan = planBinaryLaunch("codex", ["app-server"], {
      platform: "win32",
      env: { Path: binDir, ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    });

    expect(plan.command).toBe(join(binDir, "codex.exe"));
    expect(plan.args).toEqual(["app-server"]);
    expect(plan.windowsVerbatimArguments).toBe(false);
    // The child spawn hands back IS Codex, so an ordinary kill reaches it.
    expect(plan.viaCmdExe).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("a Windows .cmd goes through cmd.exe, whole command line quoted", () => {
    const root = tempDir("plan-cmd");
    // A space in the path on purpose: %APPDATA%\npm sits under the account name,
    // and plenty of Windows accounts have two words in them.
    const binDir = join(root, "Program Files");
    mkdirSync(binDir);
    const shim = join(binDir, "codex.cmd");
    writeFileSync(shim, "@echo off\n");

    const plan = planBinaryLaunch("codex", ["app-server"], {
      platform: "win32",
      env: { Path: binDir, ComSpec: "C:\\Windows\\system32\\cmd.exe" },
    });

    expect(plan.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(plan.args).toEqual(["/d", "/s", "/c", `""${shim}" "app-server""`]);
    // Without this, libuv re-quotes the line we just built and cmd.exe receives
    // escaped quotes instead of a command.
    expect(plan.windowsVerbatimArguments).toBe(true);
    // cmd.exe is what spawn hands back. Whoever stops it has to know that.
    expect(plan.viaCmdExe).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a .bat is treated like a .cmd", () => {
    const root = tempDir("plan-bat");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "npx.bat"), "@echo off\n");

    const plan = planBinaryLaunch("npx", ["init"], {
      platform: "win32",
      env: { Path: binDir },
    });

    expect(plan.command.toLowerCase()).toContain("cmd.exe");
    expect(plan.args[0]).toBe("/d");
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.viaCmdExe).toBe(true);
  });

  test("a caller-supplied path is used as given, never looked up on PATH", () => {
    const root = tempDir("plan-explicit");
    const explicit = join(root, "definitely-not-codex");

    const plan = planBinaryLaunch(explicit, ["doctor", "--json"], {
      platform: "win32",
      env: { Path: root },
    });

    expect(plan.command).toBe(explicit);
    expect(plan.args).toEqual(["doctor", "--json"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a PowerShell script is not something we can launch, so it is not chosen", () => {
    const root = tempDir("plan-ps1");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex.ps1"), "# nothing\n");
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\n");

    const plan = planBinaryLaunch("codex", ["app-server"], {
      platform: "win32",
      env: { Path: binDir },
    });

    // Nothing launchable here, so we hand the bare name over and let the spawn fail
    // honestly, the same way it does when Codex really is missing.
    expect(plan.command).toBe("codex");
    expect(plan.windowsVerbatimArguments).toBe(false);
    expect(plan.viaCmdExe).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("no ComSpec set still lands on cmd.exe", () => {
    const root = tempDir("plan-nocomspec");
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex.cmd"), "@echo off\n");

    const plan = planBinaryLaunch("codex", [], {
      platform: "win32",
      env: { Path: binDir },
    });

    expect(plan.command).toBe("cmd.exe");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// stopLaunchedProcess - taking down what planBinaryLaunch started
// ---------------------------------------------------------------------------

function fakeChild(
  pid: number | undefined,
  killed: string[],
): StoppableChild {
  return {
    pid,
    kill: () => {
      killed.push("kill");
      return true;
    },
  };
}

function cmdExeLaunch(): BinaryLaunch {
  return {
    command: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\npm\\codex.cmd" "app-server""'],
    windowsVerbatimArguments: true,
    viaCmdExe: true,
  };
}

function directLaunch(): BinaryLaunch {
  return {
    command: "C:\\codex\\codex.exe",
    args: ["app-server"],
    windowsVerbatimArguments: false,
    viaCmdExe: false,
  };
}

describe("stopLaunchedProcess", () => {
  test("a child behind cmd.exe is taken down as a tree, not one process", () => {
    const killed: string[] = [];
    const taskkillArgs: string[][] = [];

    stopLaunchedProcess(fakeChild(4321, killed), cmdExeLaunch(), {
      platform: "win32",
      runTaskkill: (args) => taskkillArgs.push(args),
    });

    expect(taskkillArgs).toEqual([["/PID", "4321", "/T", "/F"]]);
    // Killing the pid we hold would end cmd.exe and leave Codex running.
    expect(killed).toEqual([]);
  });

  test("a Windows .exe we started directly is killed directly", () => {
    const killed: string[] = [];
    const taskkillArgs: string[][] = [];

    stopLaunchedProcess(fakeChild(4321, killed), directLaunch(), {
      platform: "win32",
      runTaskkill: (args) => taskkillArgs.push(args),
    });

    expect(killed).toEqual(["kill"]);
    expect(taskkillArgs).toEqual([]);
  });

  test("posix is unchanged: an ordinary kill, never taskkill", () => {
    const killed: string[] = [];
    const taskkillArgs: string[][] = [];

    stopLaunchedProcess(
      fakeChild(4321, killed),
      { ...cmdExeLaunch(), viaCmdExe: true },
      {
        platform: "darwin",
        runTaskkill: (args) => taskkillArgs.push(args),
      },
    );

    expect(killed).toEqual(["kill"]);
    expect(taskkillArgs).toEqual([]);
  });

  test("a spawn that never got a pid falls back to the kill it has", () => {
    const killed: string[] = [];
    const taskkillArgs: string[][] = [];

    stopLaunchedProcess(fakeChild(undefined, killed), cmdExeLaunch(), {
      platform: "win32",
      runTaskkill: (args) => taskkillArgs.push(args),
    });

    expect(taskkillArgs).toEqual([]);
    expect(killed).toEqual(["kill"]);
  });

  test("taskkill refusing still leaves the wrapper stopped", () => {
    const killed: string[] = [];

    stopLaunchedProcess(fakeChild(4321, killed), cmdExeLaunch(), {
      platform: "win32",
      runTaskkill: () => {
        throw new Error("taskkill is not on PATH");
      },
    });

    expect(killed).toEqual(["kill"]);
  });

  test("a kill that throws is the expected race, not an error", () => {
    expect(() =>
      stopLaunchedProcess(
        {
          pid: 4321,
          kill: () => {
            throw new Error("ESRCH");
          },
        },
        directLaunch(),
        { platform: "win32", runTaskkill: () => undefined },
      ),
    ).not.toThrow();
  });
});

// releaseAppServer is the one place the trust check stops its child, so the plan has
// to reach it. A stop that quietly forgot the plan would pass every case above.
describe("releaseAppServer", () => {
  function streamsAndChild(killed: string[]): {
    child: Parameters<typeof releaseAppServer>[0];
    closed: string[];
  } {
    const closed: string[] = [];
    const child = {
      pid: 777,
      kill: () => {
        killed.push("kill");
        return true;
      },
      stdin: { end: () => closed.push("stdin") },
      stdout: { destroy: () => closed.push("stdout") },
      stderr: { destroy: () => closed.push("stderr") },
    };
    return {
      child: child as unknown as Parameters<typeof releaseAppServer>[0],
      closed,
    };
  }

  test("a Codex behind cmd.exe is stopped as a tree", () => {
    const killed: string[] = [];
    const taskkillArgs: string[][] = [];
    const { child, closed } = streamsAndChild(killed);

    releaseAppServer(child, cmdExeLaunch(), {
      platform: "win32",
      runTaskkill: (args) => taskkillArgs.push(args),
    });

    expect(closed).toEqual(["stdin", "stdout", "stderr"]);
    expect(taskkillArgs).toEqual([["/PID", "777", "/T", "/F"]]);
    expect(killed).toEqual([]);
  });

  test("on posix it still closes the pipes and kills the child it holds", () => {
    const killed: string[] = [];
    const taskkillArgs: string[][] = [];
    const { child, closed } = streamsAndChild(killed);

    releaseAppServer(child, { ...directLaunch(), viaCmdExe: false }, {
      platform: "darwin",
      runTaskkill: (args) => taskkillArgs.push(args),
    });

    expect(closed).toEqual(["stdin", "stdout", "stderr"]);
    expect(killed).toEqual(["kill"]);
    expect(taskkillArgs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The three call sites, against real fake shims. Windows only.
// ---------------------------------------------------------------------------

// One fake Codex, two commands. `app-server` speaks just enough of the JSON-RPC
// handshake for the trust check; `doctor --json` prints the one field we read.
function fakeCodexSource(): string {
  return [
    "const command = process.argv[2];",
    'if (command === "doctor") {',
    '  process.stdout.write(JSON.stringify({ checks: { "config.load": { status: "ok", summary: "config loaded" } } }));',
    "  process.exit(0);",
    "}",
    'if (command !== "app-server") process.exit(9);',
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
    "      const hook = {",
    '        key: "user:pre_tool_use:0:0",',
    '        eventName: "preToolUse",',
    '        command: "node cap.mjs",',
    '        matcher: "*",',
    '        statusMessage: "MarginFront cap check",',
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
    'process.stdin.on("end", () => process.exit(0));',
    "setTimeout(() => process.exit(0), 20000);",
    "",
  ].join("\n");
}

// Records the argv it was handed, so the test can prove the arguments survived the
// trip through cmd.exe instead of arriving glued together or still wearing quotes.
function fakeNpxSource(marker: string): string {
  return [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
    "process.exit(0);",
    "",
  ].join("\n");
}

// The fake exits a beat after the cmd.exe that started it is killed, and Windows
// refuses to delete a file a live process still has open. Retry briefly rather than
// flake the lane on a race that says nothing about the shim lookup.
async function removeWhenFree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((settle) => setTimeout(settle, 100));
    }
  }
}

function stageShims(): { root: string; binDir: string; npxMarker: string } {
  const root = tempDir("cmd-shims");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });

  const codexScript = join(binDir, "fake-codex.cjs");
  writeFileSync(codexScript, fakeCodexSource());
  writeFileSync(
    join(binDir, "codex.cmd"),
    `@echo off\r\nnode "%~dp0fake-codex.cjs" %*\r\n`,
  );

  const npxMarker = join(root, "npx-argv.json");
  const npxScript = join(binDir, "fake-npx.cjs");
  writeFileSync(npxScript, fakeNpxSource(npxMarker));
  writeFileSync(
    join(binDir, "npx.cmd"),
    `@echo off\r\nnode "%~dp0fake-npx.cjs" %*\r\n`,
  );

  return { root, binDir, npxMarker };
}

describe.runIf(onWindows)("the real shims, spawned for real", () => {
  test("the Codex trust check reads a real state instead of CAN'T TELL", async () => {
    const { root, binDir } = stageShims();
    const key = pathEnvKey();
    const env = {
      ...process.env,
      [key]: `${binDir}${delimiter}${process.env[key] ?? ""}`,
    };

    const result = await codexHooksList({ cwd: root, env, timeoutMs: 20_000 });

    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.hooks.length).toBe(1);
    expect(result.hooks[0].trustStatus).toBe("trusted");
    await removeWhenFree(root);
  }, 60_000);

  test("codex doctor answers instead of coming back unknown", async () => {
    const { root, binDir } = stageShims();
    const key = pathEnvKey();
    const env = {
      ...process.env,
      [key]: `${binDir}${delimiter}${process.env[key] ?? ""}`,
    };

    const result = await codexDoctorConfigLoad({ env, timeoutMs: 20_000 });

    expect(result.status).toBe("ok");
    await removeWhenFree(root);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The orphan the tree kill exists to prevent. Windows only, real processes.
// ---------------------------------------------------------------------------

// A Codex that never answers. It records its own pid and then sits there, touching
// no pipe, so nothing about the test's stdio can end it - only a kill can.
function hungCodexSource(marker: string): string {
  return [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
    "setTimeout(() => process.exit(0), 120000);",
    "",
  ].join("\n");
}

function stageHungCodex(): { root: string; binDir: string; marker: string } {
  const root = tempDir("hung-codex");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(root, "codex-pid.txt");
  writeFileSync(join(binDir, "hung-codex.cjs"), hungCodexSource(marker));
  writeFileSync(
    join(binDir, "codex.cmd"),
    `@echo off\r\nnode "%~dp0hung-codex.cjs" %*\r\n`,
  );
  return { root, binDir, marker };
}

function pathWith(binDir: string): NodeJS.ProcessEnv {
  const key = pathEnvKey();
  return {
    ...process.env,
    [key]: `${binDir}${delimiter}${process.env[key] ?? ""}`,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

async function waitForCodexPid(marker: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(marker)) {
      const pid = parseInt(readFileSync(marker, "utf8").trim(), 10);
      if (Number.isInteger(pid)) return pid;
    }
    await settle(100);
  }
  throw new Error(`the fake Codex never recorded a pid at ${marker}`);
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) return true;
    await settle(100);
  }
  return false;
}

function sweep(pid: number): void {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
  });
}

describe.runIf(onWindows)("a hung Codex behind cmd.exe", () => {
  // Both halves run against the same fake on the same runner, so the second one is
  // only meaningful because the first one shows the orphan is real here.
  test("survives a kill aimed at the wrapper, and does not survive the tree kill", async () => {
    const first = stageHungCodex();
    const launch = planBinaryLaunch("codex", ["app-server"], {
      env: pathWith(first.binDir),
    });
    const wrapper = spawn(launch.command, launch.args, {
      env: pathWith(first.binDir),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    const orphan = await waitForCodexPid(first.marker);
    try {
      wrapper.kill();
      await settle(1500);

      // The orphan, measured: the pid Node handed us was
      // cmd.exe, and Windows killed exactly that one.
      expect(isAlive(orphan)).toBe(true);
    } finally {
      sweep(orphan);
      await removeWhenFree(first.root);
    }

    // Now the real trust check, on its timeout path, against the same fake.
    const second = stageHungCodex();
    const env = pathWith(second.binDir);
    const started = codexHooksList({ cwd: second.root, env, timeoutMs: 3_000 });
    const codexPid = await waitForCodexPid(second.marker);
    try {
      const result = await started;
      expect(result.reason).toBe("timeout");
      expect(await waitUntilGone(codexPid)).toBe(true);
    } finally {
      sweep(codexPid);
      await removeWhenFree(second.root);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Source gates
// ---------------------------------------------------------------------------

const CHILD_PROCESS_CALLS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "spawnImpl",
  "execFileImpl",
]);

interface SpawnCall {
  file: string;
  line: number;
  program: string;
}

// Every child-process call in src/, with whatever it was told to run. The shape of
// that first argument is the whole question, so it comes back as source text.
function spawnCalls(): SpawnCall[] {
  const found: SpawnCall[] = [];
  for (const file of srcFilePaths()) {
    const text = readSrc(file);
    const parsed = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null;
        if (name !== null && CHILD_PROCESS_CALLS.has(name)) {
          found.push({
            file,
            line:
              parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line +
              1,
            program: node.arguments[0].getText(parsed),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return found;
}

describe("source gates", () => {
  test("no child process is started by the bare name codex or npx", () => {
    const bare = spawnCalls().filter((call) =>
      /^["'](codex|npx)["']$/.test(call.program),
    );

    expect(
      bare.map((call) => `${call.file}:${call.line} runs ${call.program}`),
    ).toEqual([]);
  });

  test("the caller's own name for Codex never reaches a spawn unresolved", () => {
    const unresolved = spawnCalls().filter((call) =>
      /^(codexBin|npxBin|bin|binary)$/.test(call.program),
    );

    expect(
      unresolved.map(
        (call) => `${call.file}:${call.line} runs ${call.program}`,
      ),
    ).toEqual([]);
  });

  test("nothing in src/ asks Node for shell:true", () => {
    const offenders: string[] = [];
    for (const file of srcFilePaths()) {
      const text = readSrc(file);
      const parsed = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "shell" &&
          node.initializer.kind === ts.SyntaxKind.TrueKeyword
        ) {
          offenders.push(
            `${file}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1}`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }

    // shell:true would fix the shim problem in one character and cost two things:
    // Node prints the DEP0190 deprecation warning into a customer's terminal during
    // init, and the program name becomes a command string, which is an injection
    // seam for a caller-supplied binary.
    expect(offenders).toEqual([]);
  });
});
