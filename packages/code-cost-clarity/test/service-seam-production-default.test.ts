// service-seam-production-default.test.ts
// ---------------------------------------------------------------------------
// THE HOLE THIS FILLS: cli.ts routes every "start / pause / look at / remove the
// background meter" call through selectServiceManager(platform()) or
// findServiceManager(platform()), at several call sites. EVERY other test injects past
// them. Replacing the platform() argument with the literal "win32" at all of them would
// route every macOS install into the Task Scheduler backend and leave every other
// test green.
//
// So this drives the REAL built bundle through its REAL entry point, once per command,
// with the OS spoofed at the one place the un-injected default reads it -
// process.platform, which node:os platform() returns. The assertion is which backend
// the bundle then actually reached for: launchctl or schtasks.
//
// WHY IT INTERCEPTS child_process INSTEAD OF LETTING IT RUN, and this half is not
// optional: HOME ISOLATION IS NOT ISOLATION ON macOS. bootoutDaemon and uninstallDaemon
// build their launchctl target from gui/<uid>/ plus a module-constant label and never
// read HOME, so a sandboxed `uninstall` still reaches the developer's real launchd
// service. A throwaway HOME cannot stop that; not letting the command run can. So the
// preload records every child process the bundle asks for and answers as a machine with
// nothing installed would. Everything above that boundary is the real thing.
// ---------------------------------------------------------------------------

import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// BUILT FRESH, INTO ITS OWN DIRECTORY. Fresh because a prebuilt artifact can report
// on stale source; its own directory because vitest runs test
// files in parallel workers and tsup's `clean` wipes its out dir before writing - two
// files both building into dist/ means one can be reading a CLI the other just deleted.
// Otherwise it is the real build: same tsup.config.ts, same entry, same defines.
const buildDir = mkdtempSync(join(tmpdir(), "ccc-seam-dist-"));
const builtCliPath = join(buildDir, "cli.js");

beforeAll(() => {
  const onWindows = process.platform === "win32";
  execFileSync(
    "npx",
    ["tsup", "--out-dir", onWindows ? `"${buildDir}"` : buildDir],
    {
      cwd: packageRoot,
      stdio: "ignore",
      // npx is npx.cmd on Windows, and execFile resolves no PATHEXT and refuses to
      // spawn a batch file directly. Without this the hook dies on spawnSync ENOENT.
      shell: onWindows,
    },
  );
}, 180_000);

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

// A child process the bundle asked the OS for.
type ExternalCall = [command: string, args: string[]];

interface RealRun {
  status: number | null;
  output: string;
  calls: ExternalCall[];
  configDir: string;
}

// Everything the spoof does, in one file the CLI is started with. Monkeypatching
// child_process from a --require preload reaches the bundle's `import { spawnSync }
// from "child_process"` because node builds a builtin's ESM facade from the CJS
// exports object, and the preload has already replaced them by then.
//
// It answers as a machine with NOTHING installed: every "does it exist?" query fails,
// every request succeeds. That is the state a first install starts from, and it keeps
// install() off the retry paths that exist for a job already loaded.
function writeSpoof(
  path: string,
  spoofedPlatform: string,
  logPath: string,
  meterAlreadyInstalled: boolean,
): void {
  writeFileSync(
    path,
    `const cp = require("child_process");
const fs = require("fs");
Object.defineProperty(process, "platform", {
  value: ${JSON.stringify(spoofedPlatform)},
  configurable: true,
});
const LOG = ${JSON.stringify(logPath)};
function record(command, args) {
  fs.appendFileSync(LOG, JSON.stringify([String(command), (args || []).map(String)]) + "\\n");
}
// "Is a meter already registered?" -> whatever this run is standing in for. Anything
// else -> yes, done. Both backends spell the question differently and both branch on
// it, so a stop against a machine with nothing installed never reaches its pause.
const ALREADY_INSTALLED = ${meterAlreadyInstalled ? "true" : "false"};
function statusFor(args) {
  const list = (args || []).map(String);
  const isLookup =
    list.includes("print") || list.includes("/Query") || list.includes("list");
  return isLookup && !ALREADY_INSTALLED ? 1 : 0;
}
cp.spawnSync = function (command, args) {
  record(command, args);
  return { status: statusFor(args), stdout: "", stderr: "", pid: 0, output: [], signal: null, error: undefined };
};
cp.execFileSync = function (command, args) {
  record(command, args);
  return "";
};
cp.spawn = function (command, args) {
  record(command, args);
  // Enough of a ChildProcess for startCollector: a pid to write down and an unref.
  return { pid: 424242, unref() {}, on() {}, kill() {}, stdout: null, stderr: null };
};
// No test may reach the network. The update nudge fires on every run.
globalThis.fetch = () => Promise.reject(new Error("network disabled in test"));
`,
  );
}

interface Sandbox {
  home: string;
  configDir: string;
  spoofPath: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  root: string;
}

interface SandboxOptions {
  seedSetup?: boolean;
  meterAlreadyInstalled?: boolean;
}

// A stand-in key, so nothing here can pick up the developer's real one out of the
// environment it inherits. It is never sent anywhere: the meter has no records to post.
const STAND_IN_KEY = "mf_sk_not_a_real_key";

function makeSandbox(
  spoofedPlatform: string,
  { seedSetup = false, meterAlreadyInstalled = false }: SandboxOptions = {},
): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ccc-seam-"));
  const home = join(root, "home");
  const configDir = join(home, ".marginfront-ccc");
  mkdirSync(home, { recursive: true });

  if (seedSetup) {
    // The state `init` leaves behind: a collector, its config, and a saved key. It is
    // what makes `start` and `run` reach the seam at all, and it short-circuits the
    // 360 MB collector download. BOTH binary names, because which one counts is itself
    // a production read of platform() (connector.ts collectorBinaryName).
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "otelcol-contrib"), "stub");
    writeFileSync(join(configDir, "otelcol-contrib.exe"), "stub");
    writeFileSync(join(configDir, "otel-collector.yaml"), "stub");
    writeFileSync(
      join(configDir, ".env"),
      `MARGINFRONT_API_KEY=${STAND_IN_KEY}\n`,
    );
  }

  const logPath = join(root, "external-calls.jsonl");
  writeFileSync(logPath, "");
  const spoofPath = join(root, "spoof-platform.cjs");
  writeSpoof(spoofPath, spoofedPlatform, logPath, meterAlreadyInstalled);

  return {
    root,
    home,
    configDir,
    spoofPath,
    logPath,
    env: {
      ...process.env,
      HOME: home,
      // libuv's os.homedir() reads USERPROFILE on Windows, not HOME.
      USERPROFILE: home,
      // Piped stdio already makes this non-interactive; CI shuts the other door into
      // the update prompt, the one branch that would reach the network.
      CI: "1",
      // Always written, never inherited. loadEnvFile does not override what is already
      // in the environment, so an empty string here would refuse every keyed command.
      MARGINFRONT_API_KEY: seedSetup ? STAND_IN_KEY : "",
    },
  };
}

// Windows will not delete a directory that is a live process's cwd, and it holds the
// lock for a moment after the process goes. A temp directory the OS clears anyway is
// not worth failing an assertion that already passed.
function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function readCalls(logPath: string): ExternalCall[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ExternalCall);
}

// Run a one-shot command to completion.
function runRealCli(
  args: string[],
  spoofedPlatform: string,
  options: SandboxOptions = {},
): RealRun & { cleanup: () => void } {
  const sandbox = makeSandbox(spoofedPlatform, options);
  const result = spawnSync(
    process.execPath,
    ["--require", sandbox.spoofPath, builtCliPath, ...args],
    { encoding: "utf8", cwd: sandbox.root, env: sandbox.env, timeout: 60_000 },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: readCalls(sandbox.logPath),
    configDir: sandbox.configDir,
    cleanup: () => removeQuietly(sandbox.root),
  };
}

// Read a file the CLI may not have created yet.
function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// `run` never returns - it is the long-running meter. Start it, wait until it has
// asked the OS for something (or given up), then take it down. `readReadyText` says
// where the "it got that far" line will show up: the child's own output by default,
// and the daemon log for a run that redirects its output into files.
async function runRealCliUntilQuiet(
  args: string[],
  spoofedPlatform: string,
  readReadyText: (sandbox: Sandbox, childOutput: string) => string = (
    _sandbox,
    childOutput,
  ) => childOutput,
): Promise<RealRun & { cleanup: () => void }> {
  const sandbox = makeSandbox(spoofedPlatform, { seedSetup: true });
  const child = spawn(
    process.execPath,
    ["--require", sandbox.spoofPath, builtCliPath, ...args],
    { cwd: sandbox.root, env: sandbox.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString()));

  let exited = false;
  child.on("exit", () => (exited = true));

  // The line `run` prints once it is past the collector start and the desktop-env step.
  const deadline = Date.now() + 20_000;
  while (
    !exited &&
    Date.now() < deadline &&
    !readReadyText(sandbox, output).includes("Ctrl-C to stop")
  ) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // Wait for it to actually be gone before the caller tries to delete the sandbox:
  // the meter is cwd'd into it, and Windows will not remove a live process's cwd.
  if (!exited) {
    child.kill("SIGKILL");
    const killDeadline = Date.now() + 5_000;
    while (!exited && Date.now() < killDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return {
    status: child.exitCode,
    output,
    calls: readCalls(sandbox.logPath),
    configDir: sandbox.configDir,
    cleanup: () => removeQuietly(sandbox.root),
  };
}

const launchctlCalls = (calls: ExternalCall[]) =>
  calls.filter(([command]) => command === "launchctl");
const schtasksCalls = (calls: ExternalCall[]) =>
  calls.filter(([command]) => command === "schtasks");
// The verbs, flattened, so an assertion can name what was asked for without pinning
// the exact argv order.
const verbs = (calls: ExternalCall[]) => calls.flatMap(([, args]) => args);

// ---------------------------------------------------------------------------
// The seams that ANSWER a question: `status`. Both directions run on any host.
// ---------------------------------------------------------------------------
describe("status asks the platform's own service manager", () => {
  test("real default platform, darwin: it asks launchd, and never schtasks", () => {
    const run = runRealCli(["status"], "darwin");
    try {
      expect(verbs(launchctlCalls(run.calls))).toContain("print");
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test("real default platform, win32: it asks Task Scheduler, and never launchd", () => {
    const run = runRealCli(["status"], "win32");
    try {
      expect(verbs(schtasksCalls(run.calls))).toContain("/Query");
      expect(launchctlCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// LINUX: there is no service manager to ask, so these two commands must not run the
// un-injected default into selectServiceManager's throw and out into main()'s catch,
// which prints "Something went wrong" for a documented state. The README tells Linux
// users to run `status`. Spoofed the same way as darwin and win32 above, so a macOS
// developer sees a Linux failure without a Linux machine.
// ---------------------------------------------------------------------------
describe("linux has no background meter, and the commands say so instead of crashing", () => {
  test("status answers with the no-meter row, exit 0, without asking any service manager", () => {
    const run = runRealCli(["status"], "linux");
    try {
      expect(run.status).toBe(0);
      expect(run.output).toContain("There's no background meter on linux yet");
      // The crash handler's own words are what a crash would print here.
      expect(run.output).not.toContain("Something went wrong");
      // Neither backend was reached for, so it did not merely swallow a throw from
      // one of them.
      expect(launchctlCalls(run.calls)).toEqual([]);
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test("start refuses in plain English and never reaches the install or health-check seams", () => {
    const run = runRealCli(["start"], "linux", { seedSetup: true });
    try {
      // A refusal, so exit 1 is right. It is the command's own refusal, not an
      // unhandled throw.
      expect(run.status).toBe(1);
      expect(run.output).toContain(
        "There's no background meter for linux yet.",
      );
      expect(run.output).toContain("node ~/.marginfront-ccc/cli.js run");
      expect(run.output).not.toContain("Something went wrong");
      // Site 1 (install) and site 2 (the health-check poll) both stop short: nothing
      // was registered, and nothing was polled about.
      expect(launchctlCalls(run.calls)).toEqual([]);
      expect(schtasksCalls(run.calls)).toEqual([]);
      expect(run.output).not.toContain(
        "The background meter was installed, but it isn't running yet.",
      );
    } finally {
      run.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The seams that CHANGE something: install, suspend, uninstall, desktop env.
// ---------------------------------------------------------------------------
describe("the meter is installed into the platform's own service manager", () => {
  test("real default platform, darwin: init with a saved key bootstraps a LaunchAgent", () => {
    const run = runRealCli(["init", "--no-prompt"], "darwin", {
      seedSetup: true,
    });
    try {
      // bootstrap is the launchd verb that loads the job - the install actually
      // landing, not merely a status probe on the way past.
      expect(verbs(launchctlCalls(run.calls))).toContain("bootstrap");
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test("real default platform, darwin: start installs and then polls launchd", () => {
    const run = runRealCli(["start"], "darwin", { seedSetup: true });
    try {
      const asked = verbs(launchctlCalls(run.calls));
      expect(asked).toContain("bootstrap"); // the install seam
      expect(asked).toContain("print"); // the health-check status seam
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  // The Windows half of the install and health-check seams. Without a meter to feed
  // it, an armed cap reads a stale figure and fails open.
  test("real default platform, win32: start registers a logon task and then polls it", () => {
    const run = runRealCli(["start"], "win32", { seedSetup: true });
    try {
      const asked = verbs(schtasksCalls(run.calls));
      expect(asked).toContain("/Create"); // the install seam
      expect(asked).toContain("/Query"); // the health-check status seam
      expect(launchctlCalls(run.calls)).toEqual([]);
      // No win32 refusal text appears.
      expect(run.output).not.toContain(
        "Native Windows support isn't ready yet",
      );
    } finally {
      run.cleanup();
    }
  });
});

describe("stop pauses the meter through the platform's own service manager", () => {
  test("real default platform, darwin: it boots the LaunchAgent out", () => {
    const run = runRealCli(["stop"], "darwin", {
      seedSetup: true,
      // `stop` PAUSES a meter, so there has to be one to pause. Both backends ask
      // first and do nothing when the answer is "not registered".
      meterAlreadyInstalled: true,
    });
    try {
      expect(verbs(launchctlCalls(run.calls))).toContain("bootout");
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test("real default platform, win32: it disables the scheduled task", () => {
    const run = runRealCli(["stop"], "win32", {
      seedSetup: true,
      meterAlreadyInstalled: true,
    });
    try {
      expect(verbs(schtasksCalls(run.calls))).toContain("/Change");
      expect(launchctlCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });
});

describe("uninstall removes the meter and clears the desktop env", () => {
  test("real default platform, darwin: it boots the job out AND unsets the GUI-session vars", () => {
    const run = runRealCli(["uninstall"], "darwin", { seedSetup: true });
    try {
      const asked = verbs(launchctlCalls(run.calls));
      expect(asked).toContain("bootout"); // the uninstall seam
      expect(asked).toContain("unsetenv"); // the clearDesktopEnvironment seam
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test("real default platform, win32: it deletes the scheduled task, and clears no GUI env because there is none", () => {
    const run = runRealCli(["uninstall"], "win32", { seedSetup: true });
    try {
      expect(verbs(schtasksCalls(run.calls))).toContain("/Delete");
      // The Windows backend's applyDesktop/clearDesktop pair is deliberately empty:
      // no Windows desktop app is known to read it. Reaching for launchctl here
      // would mean the macOS backend answered on Windows.
      expect(launchctlCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });
});

describe("run applies the desktop telemetry env through the platform's seam", () => {
  test("real default platform, darwin: it sets the launchd GUI-session vars", async () => {
    const run = await runRealCliUntilQuiet(["run"], "darwin");
    try {
      // The premise: it really got as far as the meter loop, so an empty launchctl
      // list below would mean the seam was skipped, not that `run` bailed early.
      expect(run.output).toContain("Ctrl-C to stop");
      expect(verbs(launchctlCalls(run.calls))).toContain("setenv");
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test("real default platform, win32: it reaches the meter loop without touching launchd", async () => {
    const run = await runRealCliUntilQuiet(["run"], "win32");
    try {
      expect(run.output).toContain("Ctrl-C to stop");
      expect(launchctlCalls(run.calls)).toEqual([]);
      expect(schtasksCalls(run.calls)).toEqual([]);
    } finally {
      run.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// THE UPGRADE PATH FOR THE COLLECTOR CONFIG. A change to the
// collector template only reaches the people who already installed the tool if `init`
// rewrites the file it wrote last time. Every other test of `init` injects past
// ensureConfigFiles, so this is the only place the real one runs: the sandbox seeds a
// stale config exactly as an older release left it, and the assertion reads the file
// off disk afterwards.
// ---------------------------------------------------------------------------
describe("init rewrites the collector config an earlier version left behind", () => {
  test("real default platform, darwin: the seeded stale config is replaced with the current template", () => {
    const run = runRealCli(["init", "--no-prompt"], "darwin", {
      seedSetup: true,
    });
    try {
      const written = readIfPresent(join(run.configDir, "otel-collector.yaml"));
      // The sandbox seeds the literal "stub", standing in for an install from an
      // earlier version.
      expect(written).not.toBe("stub");
      // And what replaced it is the current template, drop processor included, so
      // an upgraded install stops writing prompts to disk without anyone editing YAML.
      expect(written).toContain("attributes/drop-content:");
      expect(written).toMatch(
        /logs:[\s\S]*processors:\s*\[[^\]]*attributes\/drop-content[^\]]*\]/,
      );
    } finally {
      run.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// WHERE THE METER'S OWN OUTPUT GOES. launchd redirects the
// macOS job's stdout and stderr into the two files `status` tails. Task Scheduler
// captures nothing and the Windows task's node runs behind a headless console host,
// so without `--log-to-files` everything the background meter prints there is lost:
// status's "Recent output" and "Recent errors" stay empty forever, and a crash leaves
// no stack behind. This drives the REAL built CLI in a sandbox HOME and reads the
// file off disk, because the claim is about a file, not about a code path.
// ---------------------------------------------------------------------------
describe("run --log-to-files writes the meter's own output where status looks for it", () => {
  const outLogOf = (configDir: string) =>
    readIfPresent(join(configDir, "forwarder.out.log"));

  test("the startup lines land in the output log instead of on the screen", async () => {
    const run = await runRealCliUntilQuiet(
      ["run", "--log-to-files"],
      "win32",
      (sandbox) => outLogOf(sandbox.configDir),
    );
    try {
      // The same line the plain `run` test waits for on stdout, in the file this time.
      expect(outLogOf(run.configDir)).toContain("Ctrl-C to stop");
      // And NOT on the screen too. A copy would leave both assertions green while the
      // Windows task still printed into a console nobody can see.
      expect(run.output).not.toContain("Ctrl-C to stop");
    } finally {
      run.cleanup();
    }
    // Longer than the harness's own 20s wait: a build that ignores the flag prints to
    // the screen instead, and this has to reach the assertion to say so rather than
    // dying as a bare timeout.
  }, 30_000);

  test("without the flag the same run prints to the screen and writes no log file", async () => {
    const run = await runRealCliUntilQuiet(["run"], "win32");
    try {
      expect(run.output).toContain("Ctrl-C to stop");
      expect(outLogOf(run.configDir)).toBe("");
    } finally {
      run.cleanup();
    }
  });
});
