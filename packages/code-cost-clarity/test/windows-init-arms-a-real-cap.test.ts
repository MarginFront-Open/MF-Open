// windows-init-arms-a-real-cap.test.ts.
//
// WHY THIS FILE EXISTS. On a stock Windows box python3 is the Microsoft Store stub and
// /bin/sh is absent, so a cap hook that shells to either would install, report itself
// armed, and stop nothing. This file pins the claims that matter:
//
//   1. init runs to completion on this platform and writes its files.
//   2. The shipped build contains no win32 refusal text, so a refusal cannot creep
//      in without someone noticing.
//   3. A cap installed the way init installs it BLOCKS - proved by reading the hook
//      command back out of the settings file a coding agent reads, running that
//      exact string, and checking the exit code.
//
// (3) is the main claim, and it runs on every platform: the Unix arm
// keeps being proved on macOS and Linux, the Windows arm on the Windows runner.

import { test, expect, beforeAll, describe } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeControlScript, writeControlHook } from "../src/control";
import { collectorBinaryName } from "../src/connector";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const builtCliPath = join(packageRoot, "dist", "cli.js");

// Refusal text that must not appear in the build. launchd.test.ts pins that `start`
// has no Windows refusal either.
const RETIRED_REFUSAL_CLAUSE = "so setup stops here";

// Never trust the dist that happens to be there - it can report on stale source.
beforeAll(() => {
  execFileSync("npm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "ignore",
    // npm is npm.cmd on Windows, and execFile resolves no PATHEXT and refuses to
    // spawn a batch file directly. Without this the hook dies on spawnSync ENOENT.
    shell: process.platform === "win32",
  });
}, 180_000);

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

function sandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1 + 2. init runs, and the build carries no refusal
// ---------------------------------------------------------------------------

describe("init on the real platform", () => {
  test("runs to completion and writes its config files", () => {
    const dir = sandbox("ccc-real-init-");
    const home = join(dir, "home");
    const configDir = join(home, ".marginfront-ccc");
    mkdirSync(configDir, { recursive: true });
    // Short-circuits ensureCollectorBinary, which would otherwise start a 360 MB
    // download. The name is platform-specific - otelcol-contrib.exe on Windows -
    // and seeding the wrong one would quietly turn this into a download test.
    writeFileSync(join(configDir, collectorBinaryName()), "stub");

    const run = spawnSync(process.execPath, [builtCliPath, "init"], {
      encoding: "utf8",
      cwd: dir,
      env: {
        ...process.env,
        HOME: home,
        // libuv's os.homedir() reads USERPROFILE on Windows, not HOME.
        USERPROFILE: home,
        // Piped stdio already makes this non-interactive; CI shuts the other door
        // into the update prompt, the one branch that would reach the network.
        CI: "1",
        MARGINFRONT_API_KEY: "",
      },
    });

    const output = `${run.stdout}${run.stderr}`;
    expect(output).not.toContain(RETIRED_REFUSAL_CLAUSE);
    // Files the run had to create prove init ran to completion, without pinning a
    // line of copy that a wording change would break.
    expect(existsSync(join(configDir, "otel-collector.yaml"))).toBe(true);
    expect(existsSync(join(configDir, ".env"))).toBe(true);
    expect(run.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the shipped build contains no win32 refusal text", () => {
    // A string search of the artifact, not of the source: a refusal could arrive
    // through any of the files that bundle into it.
    expect(readFileSync(builtCliPath, "utf8")).not.toContain(
      RETIRED_REFUSAL_CLAUSE,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. the installed cap actually blocks
// ---------------------------------------------------------------------------

interface ArmedSeat {
  dir: string;
  controlDir: string;
  settingsPath: string;
}

// Arm a cap the way init arms one: materialize the platform's cap script, then wire
// the PreToolUse hook into a settings file. The real writers, not stand-ins.
function armControl(): ArmedSeat {
  const dir = sandbox("ccc-armed-cap-");
  const controlDir = join(dir, ".marginfront-ccc", "control");
  const settingsPath = join(dir, ".claude", "settings.json");
  mkdirSync(controlDir, { recursive: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });

  writeControlScript(join(controlDir, scriptFilename()));
  writeControlHook({
    settingsPath,
    ownershipPath: join(dir, "control-hook-owned.json"),
    scriptPath: join(controlDir, scriptFilename()),
    log: () => {},
  });
  return { dir, controlDir, settingsPath };
}

function scriptFilename(): string {
  return process.platform === "win32" ? "check-cap.mjs" : "check-cap.py";
}

// The command a coding agent would run, read back out of the file it reads.
function installedHookCommand(settingsPath: string): string {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const group = settings.hooks.PreToolUse[0];
  return group.hooks[0].command as string;
}

function writeSpendState(
  controlDir: string,
  spentUsd: number,
  amountUsd: number,
): void {
  writeFileSync(
    join(controlDir, "policy.json"),
    JSON.stringify({
      caps: [
        {
          id: "cap-1",
          scope: "org",
          providerScope: "all",
          mode: "enforce",
          amountUsd,
          period: "week",
          coolOffHours: null,
        },
      ],
    }),
  );
  writeFileSync(
    join(controlDir, "spent.json"),
    JSON.stringify({
      asOf: new Date().toISOString(),
      byPeriod: {
        week: { windowEndEpoch: FAR_FUTURE, org: { spentUsd } },
      },
    }),
  );
}

// Run the command string through a shell, which is how both agents run it.
function runInstalledHook(command: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(command, {
    shell: true,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    encoding: "utf8",
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe("a cap installed the way init installs it", () => {
  test("over the limit -> the tool call is stopped (exit 2) with a reason", () => {
    const seat = armControl();
    writeSpendState(seat.controlDir, 250, 200);

    const command = installedHookCommand(seat.settingsPath);
    const { code, stderr } = runInstalledHook(command);

    expect(code).toBe(2);
    expect(stderr).toContain(
      "Code Cost Control: your team's week spend cap of $200 is reached",
    );
    rmSync(seat.dir, { recursive: true, force: true });
  });

  test("under the limit -> the tool call goes through (exit 0)", () => {
    const seat = armControl();
    writeSpendState(seat.controlDir, 10, 200);

    const { code, stderr } = runInstalledHook(
      installedHookCommand(seat.settingsPath),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    rmSync(seat.dir, { recursive: true, force: true });
  });

  test("the command names this platform's cap script, and it exists on disk", () => {
    const seat = armControl();
    const command = installedHookCommand(seat.settingsPath);

    expect(command).toContain(scriptFilename());
    expect(existsSync(join(seat.controlDir, scriptFilename()))).toBe(true);
    // A hook pointing at a file that was never written is the exact shape of a cap
    // that reports itself armed and stops nothing.
    rmSync(seat.dir, { recursive: true, force: true });
  });
});
