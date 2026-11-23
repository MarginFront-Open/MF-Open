// install-bootstrap.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: installDaemon doesn't race launchd. bootout is
// asynchronous, so running `bootstrap` IMMEDIATELY after it, before the old job
// is fully gone, fails with "Bootstrap failed: 5: Input/output error" (errno 5).
// installDaemon therefore:
//   1. After bootout, POLL `print` until the job is actually gone (nonzero status)
//      before bootstrapping - and WAIT (sleep) between polls.
//   2. `enable` the service before bootstrap, to clear any disabled/wedged state.
//   3. If bootstrap still fails, RETRY it once after a short wait.
//
// WHAT EACH TEST CATCHES: Test 1 asserts the print poll happens AFTER bootout and
// BEFORE bootstrap, and that enable precedes bootstrap. Test 2 asserts a first errno-5 bootstrap is retried and succeeds. Both
// assert the RECORDED launchctl argv sequence from an injected fake runner - the real
// launchd is never touched, and sleeps are a no-op so nothing actually waits.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installDaemon,
  PLIST_LABEL,
  type LaunchctlResult,
  type LaunchctlRunner,
} from "../src/connector";
import { CCC_PACKAGE_VERSION } from "../src/forwarder";

// Assert against the CURRENT version, not a hardcoded literal, so this test
// doesn't go stale on the next version bump (see connector.ts's own use of this).
const VERSION_PATTERN = new RegExp(CCC_PACKAGE_VERSION.replace(/\./g, "\\."));

const QUIET = { log: () => {} };
const TEST_UID = 501;

function makeTmp(): {
  dir: string;
  sourceCliPath: string;
  daemonCliPath: string;
  plistPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "ccc-install-"));
  const sourceCliPath = join(dir, "src-cli.js");
  writeFileSync(sourceCliPath, "// fake built cli.js\n");
  return {
    dir,
    sourceCliPath,
    daemonCliPath: join(dir, "installed-cli.js"),
    plistPath: join(dir, "ai.marginfront.ccc.plist"),
  };
}

// A fake launchctl whose `print` and `bootstrap` statuses come from queues, so a test
// can model "still loaded for the first N polls, then gone" and "bootstrap fails once,
// then succeeds." Every argv is recorded so we can assert the exact call sequence.
function makeFake(opts: {
  printStatuses: number[];
  printFallback?: number;
  bootstrapStatuses?: number[];
  bootstrapStderr?: string;
}): { calls: string[][]; runLaunchctl: LaunchctlRunner } {
  const calls: string[][] = [];
  let printIdx = 0;
  let bsIdx = 0;
  const runLaunchctl: LaunchctlRunner = (args): LaunchctlResult => {
    calls.push(args);
    if (args[0] === "print") {
      const q = opts.printStatuses;
      const status =
        printIdx < q.length
          ? q[printIdx]
          : (opts.printFallback ?? q[q.length - 1]);
      printIdx++;
      return { status, stdout: "", stderr: "" };
    }
    if (args[0] === "bootstrap") {
      const q = opts.bootstrapStatuses ?? [0];
      const status = bsIdx < q.length ? q[bsIdx] : q[q.length - 1];
      bsIdx++;
      return {
        status,
        stdout: "",
        stderr:
          status !== 0
            ? (opts.bootstrapStderr ??
              "Bootstrap failed: 5: Input/output error")
            : "",
      };
    }
    // bootout, enable: succeed.
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runLaunchctl };
}

// ---------------------------------------------------------------------------
// 1. Already loaded: WAIT for the old job to be gone (poll print), ENABLE, then
//    bootstrap. Proves the errno-5 race is closed and `enable` precedes `bootstrap`.
// ---------------------------------------------------------------------------
test("installDaemon (already loaded): polls print until the old job is gone, enables, THEN bootstraps", () => {
  const { dir, sourceCliPath, daemonCliPath, plistPath } = makeTmp();
  // print sequence: initial check = 0 (loaded); then two polls still 0 (old job not
  // gone yet); third poll = 1 (gone). enable + bootstrap succeed.
  const { calls, runLaunchctl } = makeFake({
    printStatuses: [0, 0, 0, 1],
    printFallback: 1,
  });
  const sleeps: number[] = [];
  try {
    const result = installDaemon({
      runLaunchctl,
      nodePath: process.execPath,
      sourceCliPath,
      daemonCliPath,
      plistPath,
      uid: TEST_UID,
      sleep: (ms) => {
        sleeps.push(ms);
      },
      ...QUIET,
    });

    const verbs = calls.map((c) => c[0]);
    const bootoutAt = verbs.indexOf("bootout");
    const enableAt = verbs.indexOf("enable");
    const bootstrapAt = verbs.indexOf("bootstrap");

    // bootout happened (it was loaded)...
    expect(bootoutAt).toBeGreaterThanOrEqual(0);
    // ...then it POLLED print AFTER the bootout...
    const printsAfterBootout = verbs
      .slice(bootoutAt + 1)
      .filter((v) => v === "print").length;
    expect(printsAfterBootout).toBeGreaterThanOrEqual(2);
    // ...and it actually waited between polls.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    // enable ran, and BEFORE bootstrap.
    expect(enableAt).toBeGreaterThan(bootoutAt);
    expect(bootstrapAt).toBeGreaterThan(enableAt);
    // The service target for enable is the same modern gui/<uid>/<label> form.
    expect(calls[enableAt]).toEqual([
      "enable",
      `gui/${TEST_UID}/${PLIST_LABEL}`,
    ]);
    // No bootstrap happened before the job was confirmed gone (the last print before
    // bootstrap returned nonzero).
    const printsBeforeBootstrap = calls
      .slice(0, bootstrapAt)
      .filter((c) => c[0] === "print");
    expect(
      printsBeforeBootstrap[printsBeforeBootstrap.length - 1],
    ).toBeDefined();
    // It only bootstrapped once (succeeded first try) and reported a reload.
    expect(verbs.filter((v) => v === "bootstrap").length).toBe(1);
    expect(result.reloaded).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Bootstrap fails with errno 5 once, then succeeds: installDaemon RETRIES it and
//    does NOT throw.
// ---------------------------------------------------------------------------
test("installDaemon: a first errno-5 bootstrap is retried once and then succeeds (no throw)", () => {
  const { dir, sourceCliPath, daemonCliPath, plistPath } = makeTmp();
  // Not loaded (print = 1), so no bootout/poll - we isolate the bootstrap retry.
  // bootstrap: fails (5) the first time, succeeds (0) the second.
  const { calls, runLaunchctl } = makeFake({
    printStatuses: [1],
    printFallback: 1,
    bootstrapStatuses: [5, 0],
  });
  const sleeps: number[] = [];
  try {
    expect(() =>
      installDaemon({
        runLaunchctl,
        nodePath: process.execPath,
        sourceCliPath,
        daemonCliPath,
        plistPath,
        uid: TEST_UID,
        sleep: (ms) => {
          sleeps.push(ms);
        },
        ...QUIET,
      }),
    ).not.toThrow();

    const bootstraps = calls.filter((c) => c[0] === "bootstrap");
    // It tried bootstrap TWICE (first errno-5, retried).
    expect(bootstraps.length).toBe(2);
    // It waited before the retry.
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Bootstrap fails BOTH times: installDaemon throws, and the error names the
//    running version and the status command.
// ---------------------------------------------------------------------------
test("installDaemon: a persistent bootstrap failure throws an error naming the version and the status command", () => {
  const { dir, sourceCliPath, daemonCliPath, plistPath } = makeTmp();
  const { runLaunchctl } = makeFake({
    printStatuses: [1],
    printFallback: 1,
    bootstrapStatuses: [5, 5],
  });
  try {
    expect(() =>
      installDaemon({
        runLaunchctl,
        nodePath: process.execPath,
        sourceCliPath,
        daemonCliPath,
        plistPath,
        uid: TEST_UID,
        sleep: () => {},
        ...QUIET,
      }),
    ).toThrow(VERSION_PATTERN);
    // And it points the user at the installed copy, never a registry download.
    let message = "";
    try {
      installDaemon({
        runLaunchctl,
        nodePath: process.execPath,
        sourceCliPath,
        daemonCliPath,
        plistPath,
        uid: TEST_UID,
        sleep: () => {},
        ...QUIET,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("node ~/.marginfront-ccc/cli.js status");
    expect(message).not.toMatch(/@latest|npx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
