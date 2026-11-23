// binary-path.ts - finding a program on PATH, and handing it to spawn in a way
// Windows will actually run.
//
// WHY THIS EXISTS. Windows has no execute bit, so a bare `codex` on PATH is really
// codex.exe, codex.cmd or codex.bat. CreateProcess - what Node's spawn calls when
// shell is false - appends only .exe. npm installs its programs as .cmd shims, so
// spawn("codex") and spawn("npx") find nothing on a machine where both are
// installed and working. Posix is untouched: there the name on PATH is the file.
//
// WHY IT IS ITS OWN FILE. codex-app-server.ts imports this and control.ts imports
// codex-app-server.ts, so this cannot live in control.ts without making a cycle out
// of a graph that has none.

import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The Windows extensions we know how to LAUNCH, best first. Deliberately NOT read
// from %PATHEXT%: a developer who trimmed that variable would lose a shim we can run
// perfectly well, and this list is fixed by our own launch logic, not by their
// environment. A .ps1 and npm's extensionless shim are findable but not launchable,
// so they stay on the presence lists in control.ts and off this one.
const WINDOWS_LAUNCHABLE_SUFFIXES = [".exe", ".com", ".cmd", ".bat"];

// cmd.exe runs these; CreateProcess refuses them outright (CVE-2024-27980).
const NEEDS_CMD_EXE = /\.(cmd|bat)$/i;

// Which file on PATH is this program? Returns the full path, or null when the
// program is not there. Pure: everything it reads is an argument.
export function resolveBinaryOnPath(
  name: string,
  windowsSuffixes: string[],
  pathEnv: string,
  platform: NodeJS.Platform,
): string | null {
  const isWindows = platform === "win32";
  const separator = isWindows ? ";" : ":";
  const suffixes = isWindows ? windowsSuffixes : [""];
  for (const entry of pathEnv.split(separator)) {
    if (entry.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = join(entry, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface BinaryLaunch {
  command: string;
  args: string[];
  // Pass this straight into the spawn options. See the cmd.exe note below.
  windowsVerbatimArguments: boolean;
  // cmd.exe is the child, not the program: stop it with stopLaunchedProcess.
  viaCmdExe: boolean;
}

export interface PlanBinaryLaunchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

// Windows spells PATH several ways and a plain object, unlike process.env, is not
// case-insensitive about it.
function pathFromEnv(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") {
      const value = env[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

function looksLikeAPath(binary: string): boolean {
  return binary.includes("/") || binary.includes("\\");
}

function quoteForCmd(value: string): string {
  return `"${value}"`;
}

// How should spawn be called to run `binary` with `args`? On posix, and for a
// Windows .exe, the answer is "as given" - a no-op everywhere but the case below.
export function planBinaryLaunch(
  binary: string,
  args: string[],
  {
    env = process.env,
    platform = process.platform,
  }: PlanBinaryLaunchOptions = {},
): BinaryLaunch {
  const asGiven: BinaryLaunch = {
    command: binary,
    args,
    windowsVerbatimArguments: false,
    viaCmdExe: false,
  };
  if (platform !== "win32") return asGiven;

  // A caller who named a file meant that file. Only a bare name is a PATH question.
  const target = looksLikeAPath(binary)
    ? binary
    : resolveBinaryOnPath(
        binary,
        WINDOWS_LAUNCHABLE_SUFFIXES,
        pathFromEnv(env),
        platform,
      );

  // Nothing launchable on PATH: hand the bare name over so the spawn fails the way
  // it does when the program really is missing.
  if (target === null) return asGiven;
  if (!NEEDS_CMD_EXE.test(target)) {
    return {
      command: target,
      args,
      windowsVerbatimArguments: false,
      viaCmdExe: false,
    };
  }

  // THE cmd.exe RECIPE, copied from Node's own shell branch (lib/child_process.js).
  // Both halves are load-bearing and neither is guessable:
  //   The WHOLE line is quoted, not only the program path, because `cmd /S /C`
  //   strips the first and last quote on the line - and %APPDATA%\npm sits under an
  //   account name, which is often two words.
  //   windowsVerbatimArguments stops libuv re-quoting what we just quoted; without
  //   it cmd.exe gets escaped quote characters instead of a command.
  const commandLine = [target, ...args].map(quoteForCmd).join(" ");
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
    viaCmdExe: true,
  };
}

export type StoppableChild = Pick<ChildProcess, "pid" | "kill">;

export interface StopLaunchedOptions {
  platform?: NodeJS.Platform;
  // win32 only. Defaults to a real `taskkill`.
  runTaskkill?: (args: string[]) => void;
}

function taskkill(args: string[]): void {
  spawnSync("taskkill", args, { windowsHide: true });
}

// A Windows kill reaches exactly the process named, so killing the cmd.exe that
// spawn handed back leaves the program it started running. `taskkill /T` walks the
// tree from that pid and is the only way to reach it.
export function stopLaunchedProcess(
  child: StoppableChild,
  launch: BinaryLaunch,
  {
    platform = process.platform,
    runTaskkill = taskkill,
  }: StopLaunchedOptions = {},
): void {
  if (
    platform === "win32" &&
    launch.viaCmdExe &&
    typeof child.pid === "number"
  ) {
    try {
      runTaskkill(["/PID", String(child.pid), "/T", "/F"]);
      return;
    } catch {
      // taskkill.exe missing or refused. The plain kill below is all that's left.
    }
  }
  try {
    child.kill();
  } catch {
    // Died between the caller's last check and here. The expected race.
  }
}
