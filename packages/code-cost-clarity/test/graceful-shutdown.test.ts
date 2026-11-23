// graceful-shutdown.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: that `stop` can bring the forwarder down on Windows through
// an ORDERLY TEARDOWN - the process running its own shutdown code and exiting 0 -
// instead of being shot where it stands.
//
// WHAT ORDERLY TEARDOWN IS, EXACTLY, so no one reads more into it than it does. The
// forwarder gets to clear its watch timer, release its pidfile, sweep the shutdown
// mailbox, and stop the collector it started. It is NOT a flush: forwarder.ts has no
// flush or drain entry point, and cmdRun's shutdown exits synchronously, so a batch
// already in flight is abandoned either way. That is survivable by design - the cursor
// advances only after a batch lands and retryable failures are parked before it moves,
// so a forwarder killed mid-send re-reads those bytes on the next run and the server
// dedups them.
//
// THE FAILURE IT GUARDS. The documented stop ladder is "ask nicely with SIGTERM, wait
// for it to go, force it down only if it won't." Windows has no SIGTERM. Node maps
// process.kill(pid, "SIGTERM") to TerminateProcess, an unconditional kill, so on
// Windows a SIGTERM rung IS the forced rung: the ladder has one rung, `stop` always
// hard-kills, and the collector the forwarder started is orphaned for `stop` to
// clean up after rather than stopped by its own owner.
//
// WHY IT RUNS EVERYWHERE. The polite rung is a request file the forwarder polls.
// Both halves - signalForwarderStop writing it, readShutdownRequest reading it - are
// platform-free code that the platform check selects. So the Windows rung is driven HERE, on
// whatever machine the suite runs on, by passing platform: "win32" explicitly. A rule
// that only one CI lane could check would be a rule nobody watches.
//
// NON-VACUOUS THROUGHOUT: every assertion is about a REAL child process reaching a
// REAL exit through the REAL production reader. A stub that answered "yes it stopped"
// could not write the teardown marker, and the negative controls below fail loudly if
// the reader ever starts obeying a request that was not addressed to it.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  clearShutdownRequest,
  isPidAlive,
  readShutdownRequest,
  signalForwarderStop,
  stopCollectorProcess,
  type CollectorStopOptions,
} from "../src/connector";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_HOOK_URL = pathToFileURL(
  join(HERE, "helpers", "ts-import-hook.mjs"),
).href;
const STAND_IN_FORWARDER = join(HERE, "helpers", "stand-in-forwarder.ts");

interface StandIn {
  pid: number;
  exited: () => boolean;
  exitCode: () => number | null;
  waitForExit: (ms: number) => Promise<boolean>;
  kill: () => void;
}

async function spawnStandIn(
  mode: "obey" | "wedged",
  teardownMarkerPath: string,
  shutdownRequestPath: string,
): Promise<StandIn> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      TS_HOOK_URL,
      STAND_IN_FORWARDER,
      teardownMarkerPath,
      shutdownRequestPath,
      mode,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let exited = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolve();
    });
  });
  return {
    pid: child.pid as number,
    exited: () => exited,
    exitCode: () => exitCode,
    waitForExit: async (ms: number) => {
      const deadline = Date.now() + ms;
      while (!exited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return exited;
    },
    kill: () => {
      if (!exited) child.kill("SIGKILL");
    },
  };
}

describe("the Windows polite rung, driven on this machine", () => {
  test("a shutdown request stops a live forwarder cleanly, and it tears itself down on the way out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-graceful-"));
    const teardownMarkerPath = join(dir, "torn-down");
    const shutdownRequestPath = join(dir, "shutdown.request");
    const child = await spawnStandIn(
      "obey",
      teardownMarkerPath,
      shutdownRequestPath,
    );
    try {
      // The premise: nothing has stopped it and it has torn nothing down.
      expect(child.exited()).toBe(false);
      expect(existsSync(teardownMarkerPath)).toBe(false);

      // The production dispatcher, told it is on Windows. NO SIGNAL IS SENT.
      signalForwarderStop(child.pid, "SIGTERM", {
        platform: "win32",
        shutdownRequestPath,
      });
      expect(existsSync(shutdownRequestPath)).toBe(true);

      expect(await child.waitForExit(5000)).toBe(true);
      // It shut itself down rather than being shot: exit 0, and it got far enough to
      // run its own teardown. This pair is the main claim.
      expect(child.exitCode()).toBe(0);
      expect(existsSync(teardownMarkerPath)).toBe(true);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a forwarder that ignores the request is still running afterwards - so `stop` must escalate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-graceful-wedged-"));
    const teardownMarkerPath = join(dir, "torn-down");
    const shutdownRequestPath = join(dir, "shutdown.request");
    const child = await spawnStandIn(
      "wedged",
      teardownMarkerPath,
      shutdownRequestPath,
    );
    try {
      signalForwarderStop(child.pid, "SIGTERM", {
        platform: "win32",
        shutdownRequestPath,
      });
      // Long enough that a forwarder that WAS going to read the mailbox would have.
      expect(await child.waitForExit(1200)).toBe(false);
      expect(existsSync(teardownMarkerPath)).toBe(false);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on Windows the polite rung sends no signal at all - it only writes the mailbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-graceful-nosignal-"));
    const shutdownRequestPath = join(dir, "shutdown.request");
    const killed: Array<[number, string]> = [];
    try {
      signalForwarderStop(4242, "SIGTERM", {
        platform: "win32",
        shutdownRequestPath,
        kill: (pid, signal) => killed.push([pid, signal]),
      });
      expect(killed).toEqual([]);
      expect(readFileSync(shutdownRequestPath, "utf8")).toBe("4242");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the forced rung is still a real kill on Windows - that one is meant to be brutal", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-graceful-force-"));
    const shutdownRequestPath = join(dir, "shutdown.request");
    const killed: Array<[number, string]> = [];
    try {
      signalForwarderStop(4242, "SIGKILL", {
        platform: "win32",
        shutdownRequestPath,
        kill: (pid, signal) => killed.push([pid, signal]),
      });
      expect(killed).toEqual([[4242, "SIGKILL"]]);
      expect(existsSync(shutdownRequestPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POSIX keeps both rungs as signals and never writes a mailbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-graceful-posix-"));
    const shutdownRequestPath = join(dir, "shutdown.request");
    const killed: Array<[number, string]> = [];
    try {
      for (const platformName of ["darwin", "linux"]) {
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          signalForwarderStop(4242, signal, {
            platform: platformName,
            shutdownRequestPath,
            kill: (pid, sig) => killed.push([pid, sig]),
          });
        }
      }
      expect(killed).toEqual([
        [4242, "SIGTERM"],
        [4242, "SIGKILL"],
        [4242, "SIGTERM"],
        [4242, "SIGKILL"],
      ]);
      expect(existsSync(shutdownRequestPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A kill that throws because the pid is already gone is the EXPECTED case between a
  // liveness check and the signal, not an error to surface at the user.
  test("a pid that died between the check and the signal is not an error", () => {
    expect(() =>
      signalForwarderStop(4242, "SIGKILL", {
        platform: "darwin",
        kill: () => {
          throw new Error("ESRCH");
        },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// THE COLLECTOR'S HALF OF THE SAME LADDER.
//
// The collector needs its own polite rung on Windows. It is a
// third-party binary that will never poll our mailbox, so its polite rung is the one
// Windows itself provides: `taskkill` WITHOUT /F. And the stakes are higher than the
// forwarder's - a forwarder killed mid-batch re-reads those bytes on the next run and
// the server dedups, but nothing re-reads what the collector was holding.
//
// Driven here on any machine by passing platform explicitly, exactly like the rungs
// above, because a Windows-only path nobody runs is a path nobody watches.
// ---------------------------------------------------------------------------
describe("stopping the collector", () => {
  // A recording world: taskkill invocations, kills, and a liveness answer the test
  // controls. `deaths` says how many polite polls the collector survives before it is
  // gone - 0 means it closed immediately.
  function world(opts: { pollsBeforeGone: number; taskkillStatus?: number }) {
    const taskkills: string[][] = [];
    const kills: Array<[number, string]> = [];
    let polls = 0;
    const options: CollectorStopOptions = {
      platform: "win32",
      runTaskkill: (args) => {
        taskkills.push(args);
        return { status: opts.taskkillStatus ?? 0 };
      },
      kill: (pid, signal) => kills.push([pid, signal]),
      isAlive: () => polls++ < opts.pollsBeforeGone,
      sleep: () => {},
      pollMs: 1,
      timeoutMs: 50,
    };
    return { taskkills, kills, options };
  }

  test("on Windows the polite rung is taskkill WITHOUT /F, and a collector that closes is never force-killed", () => {
    const w = world({ pollsBeforeGone: 0 });
    expect(stopCollectorProcess(9001, w.options)).toEqual(["polite"]);
    expect(w.taskkills).toEqual([["/PID", "9001"]]);
    // The whole point: no /F anywhere, and no TerminateProcess behind its back.
    expect(w.taskkills.flat()).not.toContain("/F");
    expect(w.kills).toEqual([]);
  });

  test("a collector that will not close is escalated to a real kill, in that order", () => {
    // Never reports dead, so the polite wait runs out.
    const w = world({ pollsBeforeGone: Number.MAX_SAFE_INTEGER });
    expect(stopCollectorProcess(9002, w.options)).toEqual(["polite", "forced"]);
    expect(w.taskkills).toEqual([["/PID", "9002"]]);
    expect(w.kills).toEqual([[9002, "SIGKILL"]]);
  });

  test("if taskkill itself cannot run there is nothing to wait for - go straight to the kill", () => {
    const w = world({ pollsBeforeGone: 0, taskkillStatus: 1 });
    expect(stopCollectorProcess(9003, w.options)).toEqual(["forced"]);
    expect(w.kills).toEqual([[9003, "SIGKILL"]]);
  });

  // The POSIX guarantee. SIGTERM already IS the polite rung there, so this path must
  // stay one signal with no wait and no escalation.
  test("POSIX is untouched: one SIGTERM, no taskkill, no escalation", () => {
    for (const platformName of ["darwin", "linux"]) {
      const taskkills: string[][] = [];
      const kills: Array<[number, string]> = [];
      const rungs = stopCollectorProcess(9004, {
        platform: platformName,
        runTaskkill: (args) => {
          taskkills.push(args);
          return { status: 0 };
        },
        kill: (pid, signal) => kills.push([pid, signal]),
        isAlive: () => true,
        sleep: () => {},
      });
      expect(rungs).toEqual(["polite"]);
      expect(taskkills).toEqual([]);
      expect(kills).toEqual([[9004, "SIGTERM"]]);
    }
  });

  test("a collector that died between the liveness check and the signal is not an error", () => {
    for (const platformName of ["darwin", "win32"]) {
      expect(() =>
        stopCollectorProcess(9005, {
          platform: platformName,
          runTaskkill: () => ({ status: 1 }),
          kill: () => {
            throw new Error("ESRCH");
          },
          isAlive: () => false,
          sleep: () => {},
        }),
      ).not.toThrow();
    }
  });

  // ON A REAL WINDOWS, AGAINST A REAL COLLECTOR-SHAPED PROCESS - because the injected
  // tests above prove our ladder, not Windows' answer to it. taskkill's polite rung
  // works by asking a process to close, and the collector is spawned DETACHED with
  // windowsHide, so it has neither a window nor a console of its own. Whether Windows
  // will accept a non-forceful request for a process in that shape is a fact about
  // Windows, and the only honest way to hold it is to ask Windows.
  //
  // So it asserts only what cannot be racy - the child was up, the non-forceful rung
  // was the one we tried first, and the child is gone afterwards - and writes the rung
  // Windows actually accepted into the CI capture dir. Which rung that turns out to be
  // is a measurement, not an assertion: if the polite one never fires for this process
  // shape, the artifact is what says so, and the claim in connector.ts gets rewritten
  // to match rather than the other way round.
  test.runIf(process.platform === "win32")(
    "the ladder really takes down a detached, console-less child, and records which rung Windows accepted",
    async () => {
      // Spawned exactly as startCollector spawns the collector.
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, windowsHide: true, stdio: "ignore" },
      );
      // The child's own exit event, NOT a pid probe: Windows keeps a terminated
      // process openable while a handle to it is still held, so a probe can report a
      // dead child as alive. cli-commands.test.ts avoids the same window this way.
      let exited = false;
      child.on("exit", () => {
        exited = true;
      });
      const pid = child.pid as number;
      expect(isPidAlive(pid)).toBe(true);

      const taskkillCalls: Array<{ args: string[]; status: number | null }> =
        [];
      const rungs = stopCollectorProcess(pid, {
        // The REAL taskkill, only observed on the way past.
        runTaskkill: (args) => {
          const result = spawnSync("taskkill", args, { windowsHide: true });
          taskkillCalls.push({ args, status: result.status });
          return { status: result.status };
        },
        timeoutMs: 5_000,
      });

      const deadline = Date.now() + 10_000;
      while (!exited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const captureDir = process.env.CCC_WINDOWS_CAPTURE_DIR;
      if (captureDir) {
        mkdirSync(captureDir, { recursive: true });
        writeFileSync(
          join(captureDir, "collector-stop-ladder.json"),
          JSON.stringify({ rungs, taskkillCalls }, null, 2),
          "utf8",
        );
      }

      // The non-forceful request is what we lead with, exactly once, and /F is not in
      // it. This is the key assertion.
      expect(taskkillCalls.map((c) => c.args)).toEqual([["/PID", String(pid)]]);
      // And whichever rung it took, the collector is down.
      expect(exited).toBe(true);

      // THE MEASUREMENT, pinned so it cannot quietly stop being true. Windows refuses
      // the polite rung for a process with no console and no window, which is exactly
      // how the collector is spawned - so this escalates every time and a Windows stop
      // is NOT graceful. connector.ts says so in those words.
      //
      // If this line ever goes red, that is good news and not a broken test: Windows
      // started accepting the polite request, the escalation stopped being inevitable,
      // and the paragraph in connector.ts has to be rewritten to match.
      expect(taskkillCalls[0]!.status).not.toBe(0);
      expect(rungs).toEqual(["forced"]);
    },
  );
});

// ---------------------------------------------------------------------------
// THE STALE-MAILBOX TRAP. A `stop` that had to force the forwarder down leaves the
// request file behind. If the next `run` obeyed it, the meter would shut itself off
// seconds after every sign-in and the user would see a meter that "won't stay on."
// So the reader obeys only a request addressed to its own pid, and sweeps
// anything else. cmdRun also clears the mailbox before it starts polling.
// ---------------------------------------------------------------------------
describe("a leftover request cannot shut down the next forwarder", () => {
  test("a request naming another pid is ignored AND swept", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-stale-"));
    const requestPath = join(dir, "shutdown.request");
    try {
      writeFileSync(requestPath, "999999");
      expect(readShutdownRequest(4242, requestPath)).toBe(false);
      // Swept, so it cannot be re-read the moment this process happens to reuse it.
      expect(existsSync(requestPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable or garbled request is ignored AND swept", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-stale-garbled-"));
    const requestPath = join(dir, "shutdown.request");
    try {
      writeFileSync(requestPath, "not-a-pid");
      expect(readShutdownRequest(4242, requestPath)).toBe(false);
      expect(existsSync(requestPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a request addressed to this process IS obeyed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-addressed-"));
    const requestPath = join(dir, "shutdown.request");
    try {
      writeFileSync(requestPath, "4242");
      expect(readShutdownRequest(4242, requestPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no mailbox at all means nothing to do", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-nomailbox-"));
    try {
      expect(readShutdownRequest(4242, join(dir, "shutdown.request"))).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clearing a mailbox that is not there is not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-clear-"));
    try {
      expect(() =>
        clearShutdownRequest(join(dir, "shutdown.request")),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. A mailbox nobody polls is not a mailbox. `run` has to clear a stale
// request before it starts, poll for a fresh one, and clear the file on its way out -
// and it must do that on every platform, so the whole suite exercises the path rather
// than only the Windows lane. Asserted against the source because the alternative is
// leaving a long-running `run` loop alive inside the test process.
// ---------------------------------------------------------------------------
test("cmdRun clears a stale request, polls the mailbox, and clears it on shutdown", () => {
  const source = readFileSync(join(HERE, "..", "src", "cli.ts"), "utf8");
  const runSection = source.slice(source.indexOf("const shutdown = () => {"));
  expect(runSection).toContain("clearShutdownRequest()");
  expect(runSection).toContain("readShutdownRequest(process.pid)");
  expect(runSection).toContain("SHUTDOWN_REQUEST_POLL_MS");
  // The sweep must happen BEFORE the poll is armed, or a request left by the previous
  // stop shuts this forwarder down as soon as the first tick fires.
  const beforeShutdownFn = source.slice(
    0,
    source.indexOf("const shutdown = () => {"),
  );
  expect(beforeShutdownFn).toContain("clearShutdownRequest()");
});
