// error-hardening.test.ts
// ---------------------------------------------------------------------------
// Proofs for four daemon hardening rules that stop a silent crash loop
// (for example, TS source copied into the daemon's cli.js):
//   1. installDaemon refuses to install a cli.js node cannot parse, and the
//      previous working copy + plist are left untouched.
//   2. parseDaemonPrint captures launchd's "last exit code"; `status` says
//      plainly when the meter keeps crashing instead of staying silent.
//   3. rotateLogIfHuge caps the daemon logs, so a crash loop can't fill the
//      disk with a giant err log.
//   4. a keyless machine's `status` says it is waiting for a key, not an error,
//      instead of pointing at `start` (which refuses keyless: a runaround).
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installDaemon,
  parseDaemonPrint,
  rotateLogIfHuge,
  type LaunchctlResult,
  type LaunchctlRunner,
} from "../src/connector";
import { cmdStatus } from "../src/cli";

const QUIET = { log: () => {} };
const TEST_UID = 501;

// Fresh-install launchctl fake: `print` says not-loaded, everything else succeeds.
function freshInstallRunner(): { calls: string[][]; run: LaunchctlRunner } {
  const calls: string[][] = [];
  const run: LaunchctlRunner = (args): LaunchctlResult => {
    calls.push(args);
    if (args[0] === "print") return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

function makeTmp(previousCli?: string): {
  sourceCliPath: string;
  daemonCliPath: string;
  plistPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "ccc-hardening-"));
  const daemonCliPath = join(dir, "installed-cli.js");
  if (previousCli !== undefined) writeFileSync(daemonCliPath, previousCli);
  return {
    sourceCliPath: join(dir, "src-cli"),
    daemonCliPath,
    plistPath: join(dir, "ai.marginfront.ccc.plist"),
  };
}

// --- 1. the installer validates what it installs ----------------------------

test("installDaemon refuses a cli.js node cannot parse; previous copy and plist untouched", () => {
  const PREVIOUS = "// previous working cli.js\n";
  const { sourceCliPath, daemonCliPath, plistPath } = makeTmp(PREVIOUS);
  // The failure shape: TypeScript source where compiled JS belongs.
  writeFileSync(
    sourceCliPath,
    'import type { CacheWriteTtl } from "./types";\n',
  );
  const { calls, run } = freshInstallRunner();

  expect(() =>
    installDaemon({
      runLaunchctl: run,
      nodePath: process.execPath,
      sourceCliPath,
      daemonCliPath,
      plistPath,
      uid: TEST_UID,
      sleep: () => {},
      ...QUIET,
    }),
  ).toThrow(/cannot run|can't run|not runnable/i);

  expect(readFileSync(daemonCliPath, "utf8")).toBe(PREVIOUS);
  expect(existsSync(plistPath)).toBe(false);
  expect(calls.filter((c) => c[0] === "bootstrap")).toHaveLength(0);
});

test("installDaemon installs a valid cli.js", () => {
  const { sourceCliPath, daemonCliPath, plistPath } = makeTmp();
  writeFileSync(sourceCliPath, "// a perfectly valid built cli.js\n");
  const { run } = freshInstallRunner();

  expect(() =>
    installDaemon({
      runLaunchctl: run,
      nodePath: process.execPath,
      sourceCliPath,
      daemonCliPath,
      plistPath,
      uid: TEST_UID,
      sleep: () => {},
      ...QUIET,
    }),
  ).not.toThrow();

  expect(readFileSync(daemonCliPath, "utf8")).toContain("perfectly valid");
  expect(existsSync(plistPath)).toBe(true);
});

// --- 2. launchd's last exit code is captured and status speaks up -----------

test("parseDaemonPrint captures a numeric last exit code (and null when never exited)", () => {
  const crashed = parseDaemonPrint({
    status: 0,
    stdout: "state = running\npid = 123\nlast exit code = 1\n",
    stderr: "",
  });
  expect(crashed).toMatchObject({
    loaded: true,
    running: true,
    pid: 123,
    lastExitCode: 1,
  });

  const clean = parseDaemonPrint({
    status: 0,
    stdout: "state = running\npid = 9\nlast exit code = (never exited)\n",
    stderr: "",
  });
  expect(clean.lastExitCode).toBeNull();
});

async function statusLines(
  deps: Parameters<typeof cmdStatus>[0],
): Promise<string[]> {
  const lines: string[] = [];
  await cmdStatus({
    log: (m: string) => lines.push(m),
    readOutputLog: () => [],
    readErrorLog: () => ["SyntaxError: Unexpected token '{'"],
    ...deps,
  });
  return lines;
}

test("status says the meter keeps crashing when launchd reports a nonzero last exit and the err log is fresh", async () => {
  const now = 1_750_000_000_000;
  const lines = await statusLines({
    queryStatus: () => ({
      loaded: true,
      running: true,
      pid: 42,
      lastExitCode: 1,
    }),
    errorLogMtimeMs: () => now - 60_000, // err log written a minute ago
    now: () => now,
  });
  const text = lines.join("\n");
  // The checklist row flags it, and the PROBLEM block below carries the detail.
  expect(text).toContain(
    "  Meter:       PROBLEM. The meter keeps stopping right after it starts.",
  );
  expect(text).toMatch(/PROBLEM: the meter keeps stopping/);
  expect(text).toMatch(/exit code 1/);
  expect(text).toMatch(/init/); // the fix path is named
});

test("status stays quiet about crashes for a healthy daemon and for a long-recovered one", async () => {
  const now = 1_750_000_000_000;
  const healthy = await statusLines({
    queryStatus: () => ({
      loaded: true,
      running: true,
      pid: 7,
      lastExitCode: null,
    }),
    errorLogMtimeMs: () => now - 60_000,
    now: () => now,
  });
  expect(healthy.join("\n")).not.toMatch(/keeps stopping/i);

  const recovered = await statusLines({
    queryStatus: () => ({
      loaded: true,
      running: true,
      pid: 7,
      lastExitCode: 1,
    }),
    // err log last touched two days ago: an old crash, not a loop.
    errorLogMtimeMs: () => now - 2 * 24 * 60 * 60 * 1000,
    now: () => now,
  });
  expect(recovered.join("\n")).not.toMatch(/keeps stopping/i);
});

// --- 3. daemon logs get capped --------------------------------------------

test("rotateLogIfHuge rotates an oversized log (tail preserved in .1) and leaves small logs alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccc-rotate-"));
  const big = join(dir, "forwarder.err.log");
  const line = "SyntaxError: Unexpected token '{' at line 27\n";
  writeFileSync(big, line.repeat(Math.ceil((6 * 1024 * 1024) / line.length)));

  rotateLogIfHuge(big, 5 * 1024 * 1024);

  expect(statSync(big).size).toBe(0);
  const rotated = readFileSync(`${big}.1`, "utf8");
  expect(rotated.length).toBeGreaterThan(0);
  expect(rotated).toContain("SyntaxError");

  const small = join(dir, "forwarder.out.log");
  writeFileSync(small, "all fine\n");
  rotateLogIfHuge(small, 5 * 1024 * 1024);
  expect(readFileSync(small, "utf8")).toBe("all fine\n");
  expect(existsSync(`${small}.1`)).toBe(false);
});

// --- 4. keyless status is honest, not a runaround ---------------------------

test("keyless status says waiting-for-a-key (not an error) instead of pointing at start", async () => {
  const lines = await statusLines({
    queryStatus: () => ({
      loaded: false,
      running: false,
      pid: null,
      lastExitCode: null,
    }),
    hasApiKey: () => false,
  });
  const text = lines.join("\n");
  // The Key row names the missing thing, the Meter row says it is waiting rather
  // than broken - neither reads as "something failed", which is the honesty point.
  expect(text).toContain(
    "  Key:         ACTION NEEDED. No MarginFront key saved.",
  );
  expect(text).toMatch(/ {2}Meter: {7}Waiting for your key\./);
  expect(text).not.toMatch(/Turn it on with:\s+node .* start/);
  expect(text).not.toMatch(/ACTION NEEDED\. Not running/);
});

test("with a key saved, the not-loaded wording still points at start", async () => {
  const lines = await statusLines({
    queryStatus: () => ({
      loaded: false,
      running: false,
      pid: null,
      lastExitCode: null,
    }),
    hasApiKey: () => true,
  });
  expect(lines.join("\n")).toMatch(/node .* start/);
});
