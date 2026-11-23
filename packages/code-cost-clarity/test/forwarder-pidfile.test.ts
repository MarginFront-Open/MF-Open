// forwarder-pidfile.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: the single-instance guard works end-to-end.
//
// WHY IT EXISTS: two forwarders sharing the same cursor + retry-queue files would
// race - one advances the cursor past lines the other hasn't processed yet, so
// turns are silently dropped or double-counted. The guard stops that. Three
// scenarios need to hold for the guard to be trustworthy:
//
//   1. Live pid in the pidfile   → isPidAlive returns true → cmdRun refuses to start.
//   2. Stale/nonexistent pid     → watchAndForward proceeds and overwrites the file.
//   3. Graceful stop             → watchAndForward's stop() removes the pidfile so
//                                  the NEXT `run` doesn't see a false live pid.
//
// These tests cover all three. They work through the exported building blocks that
// cmdRun and watchAndForward use, so the assertions fail if the logic breaks -
// they are not trivially green.
// ---------------------------------------------------------------------------

import { test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  crashToConsoleError,
  isPidAlive,
  DAEMON_STDERR_LOG_PATH,
} from "../src/connector";
import { watchAndForward } from "../src/forwarder";
import { runningForwarderPid, cmdRun } from "../src/cli";

// A PID so large it cannot be a real running process on any POSIX system.
// (Linux caps around 4M, macOS around 99999.) We want a value that is definitely
// dead so isPidAlive returns false and the guard does NOT block startup.
const DEAD_PID = 9_999_999;

// Convenience: make a temporary directory that the test fully owns, with a
// pre-created empty JSONL file for watchAndForward to tail.
function makeTmpDir(): { dir: string; jsonlPath: string; pidPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccc-pidfile-"));
  const jsonlPath = join(dir, "live.jsonl");
  const pidPath = join(dir, "forwarder.pid");
  // Empty file - watchAndForward needs the file to exist, but no new lines means
  // it won't try to POST anything (which would need a real API key + network).
  writeFileSync(jsonlPath, "");
  return { dir, jsonlPath, pidPath };
}

// Save and restore MARGINFRONT_API_KEY around each test that needs watchAndForward
// to actually start (it calls process.exit(1) when the key is absent).
let savedApiKey: string | undefined;
afterEach(() => {
  // Restore whatever was there before. Doing this after EACH test (not inside
  // try/finally per-test) keeps the individual tests readable while still
  // guaranteeing cleanup on an unexpected throw.
  if (savedApiKey === undefined) {
    delete process.env.MARGINFRONT_API_KEY;
  } else {
    process.env.MARGINFRONT_API_KEY = savedApiKey;
  }
  savedApiKey = undefined;
});

// ---------------------------------------------------------------------------
// Scenario 1 - live pid → runningForwarderPid returns the pid (guard detects it).
//
// This test calls the EXPORTED runningForwarderPid() that cmdRun delegates to,
// rather than copying the guard logic inline (readFile → parseInt → isPidAlive). A
// copy stays green when cmdRun's guard changes; the real function does not.
// ---------------------------------------------------------------------------
test("runningForwarderPid: returns the live pid when the process is alive, null when dead or absent", () => {
  const { dir, pidPath } = makeTmpDir();
  try {
    // Live pid: our own process, guaranteed alive.
    writeFileSync(pidPath, String(process.pid));
    expect(runningForwarderPid(pidPath)).toBe(process.pid); // guard refuses

    // Dead pid: stale leftover from a crashed forwarder.
    writeFileSync(pidPath, String(DEAD_PID));
    expect(runningForwarderPid(pidPath)).toBeNull(); // guard lets through

    // Absent file: fresh first run.
    rmSync(pidPath);
    expect(runningForwarderPid(pidPath)).toBeNull(); // guard lets through
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 1b - cmdRun itself returns 1 when the guard fires.
//
// The second run refuses with exit 1. We export cmdRun with an optional _overridePidPath so the test can
// point it at a temp file instead of the real ~/.marginfront-ccc/forwarder.pid.
// If the guard logic inside cmdRun is ever removed or bypassed, this test fails.
// ---------------------------------------------------------------------------
test("cmdRun refusal path: returns 1 immediately when a live pid is in the pidfile", () => {
  const { dir, pidPath } = makeTmpDir();
  try {
    // Write our own (live) pid - exactly what a running forwarder would have left.
    writeFileSync(pidPath, String(process.pid));

    // THE ASSERTION: cmdRun must refuse with exit code 1 and NOT start the
    // forwarder, load env, or touch the collector.
    const result = cmdRun(false, false, pidPath); // no --fold-cache, no --log-to-files
    expect(result).toBe(1);

    // Confirm the guard didn't overwrite the pidfile on its way out.
    const stillthere = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    expect(stillthere).toBe(process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 1c - the refusal is written to the error log, so the log cap has to be
// applied before it, not after. With the rotation below the guard, a machine stuck in
// a start-refuse loop grows that log without limit - on Windows, where `run
// --log-to-files` sends the refusal straight into it, that can fill the disk.
// ---------------------------------------------------------------------------
test("cmdRun caps a huge error log even on the run it refuses", () => {
  const { dir, pidPath } = makeTmpDir();
  // The real log paths live under the home directory. This test must never create
  // that directory: on CI the suite runs in the runner's real home, and the suite's
  // real-home guard refuses every later test file once ~/.marginfront-ccc exists.
  const realConfigDir = dirname(DAEMON_STDERR_LOG_PATH);
  const configDirExistedBefore = existsSync(realConfigDir);
  const outLogPath = join(dir, "forwarder.out.log");
  const errLogPath = join(dir, "forwarder.err.log");
  const realLog = console.log;
  const realError = console.error;
  try {
    writeFileSync(pidPath, String(process.pid));
    writeFileSync(errLogPath, "x".repeat(6 * 1024 * 1024));

    // --log-to-files, the way the Windows task runs it: the refusal lands in the file.
    const result = cmdRun(false, true, pidPath, {
      out: outLogPath,
      err: errLogPath,
    });
    console.log = realLog;
    console.error = realError;

    expect(result).toBe(1);
    const written = readFileSync(errLogPath, "utf8");
    expect(written).toContain("already running");
    expect(statSync(errLogPath).size).toBeLessThan(5 * 1024 * 1024);
    // Rotated, not simply emptied: the tail of the old log is still readable.
    expect(existsSync(`${errLogPath}.1`)).toBe(true);
    // Nothing reached the real home: the injected paths were honored end to end.
    expect(existsSync(realConfigDir)).toBe(configDirExistedBefore);
  } finally {
    console.log = realLog;
    console.error = realError;
    process.off("uncaughtException", crashToConsoleError);
    process.off("unhandledRejection", crashToConsoleError);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 2 - stale/nonexistent pid → watchAndForward proceeds and overwrites.
//
// A stale pidfile (process crashed, never cleaned up) should NOT block a fresh
// start. watchAndForward sees a dead pid → isPidAlive returns false → cmdRun
// falls through → watchAndForward overwrites the file with the new process.pid.
// We test both the dead-pid and the absent-file sub-cases.
// ---------------------------------------------------------------------------
test("stale pid in pidfile: watchAndForward overwrites it with the current process.pid", () => {
  const { dir, jsonlPath, pidPath } = makeTmpDir();
  savedApiKey = process.env.MARGINFRONT_API_KEY;
  // A fake key lets watchAndForward pass the guard - we won't actually POST anything
  // because the empty JSONL file has no new lines for it to process.
  process.env.MARGINFRONT_API_KEY = "mf_sk_test_fake_for_pidfile_test";

  let stop: (() => void) | undefined;
  try {
    // Pre-seed with a definitely-dead pid - this is what a crashed forwarder leaves
    // behind. isPidAlive(DEAD_PID) is false, so the cmdRun guard lets us through.
    writeFileSync(pidPath, String(DEAD_PID));
    expect(isPidAlive(DEAD_PID)).toBe(false); // confirm our premise

    // Start the forwarder with the dead-pid file in place.
    stop = watchAndForward(jsonlPath, { pidFilePath: pidPath });

    // THE ASSERTION: watchAndForward must have overwritten the stale pid with the
    // current process's pid. The old dead-pid value (DEAD_PID) is gone.
    expect(existsSync(pidPath)).toBe(true);
    const written = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    expect(written).toBe(process.pid);
    expect(written).not.toBe(DEAD_PID);
  } finally {
    stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no pidfile at all: watchAndForward creates one with the current process.pid", () => {
  const { dir, jsonlPath, pidPath } = makeTmpDir();
  savedApiKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "mf_sk_test_fake_for_pidfile_test";

  let stop: (() => void) | undefined;
  try {
    // Confirm the file doesn't exist yet - this is a brand-new first run.
    expect(existsSync(pidPath)).toBe(false);

    stop = watchAndForward(jsonlPath, { pidFilePath: pidPath });

    // THE ASSERTION: a fresh pidfile must have been created with our pid.
    expect(existsSync(pidPath)).toBe(true);
    const written = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    expect(written).toBe(process.pid);
  } finally {
    stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scenario 3 - graceful stop removes the pidfile.
//
// After `run` finishes cleanly (Ctrl-C → shutdown → stopWatch() → stop()), the
// pidfile must be gone. If it's left behind, the NEXT `run` sees a live-looking
// pid (because process.pid only becomes dead after the OS recycles it - which
// takes time and may never happen if the PID wraps). A stale live-looking pid
// permanently blocks `run`.
// ---------------------------------------------------------------------------
test("graceful stop (stop()): pidfile is removed so the next run can start cleanly", () => {
  const { dir, jsonlPath, pidPath } = makeTmpDir();
  savedApiKey = process.env.MARGINFRONT_API_KEY;
  process.env.MARGINFRONT_API_KEY = "mf_sk_test_fake_for_pidfile_test";

  try {
    const stop = watchAndForward(jsonlPath, { pidFilePath: pidPath });

    // Pidfile must exist while the forwarder is running - this is what blocks a
    // concurrent second start.
    expect(existsSync(pidPath)).toBe(true);

    // Simulate Ctrl-C / SIGTERM graceful shutdown:  cmdRun calls stop() here.
    stop();

    // THE ASSERTION: pidfile is gone - the next `run` won't see a stale alive pid.
    expect(existsSync(pidPath)).toBe(false);
  } finally {
    // If the test throws after watchAndForward but before stop(), the interval
    // would keep the process alive. rmSync cleans the dir; no stop to call if the
    // test threw before assigning it. The forwarder's interval will GC when the
    // test process exits; Vitest isolates per-file anyway.
    rmSync(dir, { recursive: true, force: true });
  }
});
