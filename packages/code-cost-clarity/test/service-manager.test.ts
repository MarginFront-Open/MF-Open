// service-manager.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: the platform seam picks the right background-meter backend,
// refuses honestly where there is none, and - the part that matters most - drives
// launchd on macOS with exactly the expected commands.
//
// WHY THAT LAST POINT GETS THE MOST ASSERTIONS: the macOS meter runs through this
// seam. So the launchd assertions below pin the exact launchctl argument lists, in
// order. If a change moves so much as a domain target, they go red.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SUPPORTED_SERVICE_PLATFORMS,
  findServiceManager,
  launchdServiceManager,
  schtasksServiceManager,
  selectServiceManager,
  toServiceRegistration,
  unsupportedPlatformMessage,
} from "../src/service-manager";
import { PLIST_LABEL, PLIST_PATH } from "../src/connector";
import type { LaunchctlResult } from "../src/connector";
import { parseScheduledTaskXml } from "../src/windows-service";
import type { SchtasksResult } from "../src/windows-service";

const OK: LaunchctlResult = { status: 0, stdout: "", stderr: "" };
const MISSING: LaunchctlResult = { status: 1, stdout: "", stderr: "" };

// A launchctl that records every call and answers from a script of results.
function recordingLaunchctl(answers: (args: string[]) => LaunchctlResult) {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      return answers(args);
    },
  };
}

function recordingSchtasks(answers: (args: string[]) => SchtasksResult) {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      return answers(args);
    },
  };
}

describe("picking a backend", () => {
  test("macOS gets launchd, Windows gets Task Scheduler", () => {
    expect(selectServiceManager("darwin").backend).toBe("launchd");
    expect(selectServiceManager("win32").backend).toBe("schtasks");
  });

  test("the macOS backend still points at the same .plist the CLI has always named", () => {
    expect(launchdServiceManager.definitionLocation).toBe(PLIST_PATH);
  });

  test("a platform with no background meter is refused, not stubbed", () => {
    // The failure mode this guards: returning a do-nothing manager, so a Linux user
    // is told their spend is being captured in the background while nothing is.
    expect(() => selectServiceManager("linux")).toThrow(
      /no background meter for linux/,
    );
    // And the refusal hands over the thing that DOES work, plus the cost of using it.
    const message = unsupportedPlatformMessage("linux");
    expect(message).toContain("node ~/.marginfront-ccc/cli.js run");
    expect(message).toContain("lost, not buffered");
  });

  test("the best-effort lookup returns null instead of throwing", () => {
    // stop / uninstall call this: on a platform with no manager there was simply
    // nothing to pause or remove, which is not an error.
    expect(findServiceManager("linux")).toBeNull();
    expect(findServiceManager("freebsd")).toBeNull();
    expect(findServiceManager("darwin")).toBe(launchdServiceManager);
  });

  // DERIVED COVERAGE, not a hard-coded list: walk whatever platforms the routing table
  // actually holds. A backend added without a matching test stops being invisible.
  test("every supported platform resolves to a distinct, fully implemented backend", () => {
    expect(SUPPORTED_SERVICE_PLATFORMS.length).toBeGreaterThan(1);
    const seen = new Set<string>();
    for (const platformName of SUPPORTED_SERVICE_PLATFORMS) {
      const manager = selectServiceManager(platformName);
      expect(seen.has(manager.backend)).toBe(false);
      seen.add(manager.backend);
      expect(manager.definitionLocation.length).toBeGreaterThan(0);
    }
  });

  // THE SEAM'S REAL CONTRACT: a third backend (systemd) has to be able to
  // slot in without reopening cli.ts. That only holds if every backend answers the
  // same set of calls. Derived from the launchd backend's own shape so adding a method
  // to one backend and forgetting the other goes red here.
  test("every backend implements the same call surface", () => {
    const required = Object.keys(launchdServiceManager);
    for (const platformName of SUPPORTED_SERVICE_PLATFORMS) {
      const manager = selectServiceManager(platformName) as unknown as Record<
        string,
        unknown
      >;
      for (const key of required) {
        expect(`${platformName}.${key}: ${typeof manager[key]}`).toBe(
          `${platformName}.${key}: ${typeof (launchdServiceManager as unknown as Record<string, unknown>)[key]}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The macOS backend. Each test below drives the seam and asserts the launchctl
// argv, in order - the same calls launchd.test.ts pins on the underlying functions.
// ---------------------------------------------------------------------------
describe("the macOS backend is a pass-through, argument for argument", () => {
  const UID = 501;

  test("install: enable then bootstrap into gui/<uid>, with no bootout when nothing is loaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-sm-install-"));
    const sourceCliPath = join(dir, "source-cli.js");
    writeFileSync(sourceCliPath, "console.log('meter');\n");
    const plistPath = join(dir, "ai.marginfront.ccc.plist");
    const daemonCliPath = join(dir, "cli.js");
    const launchctl = recordingLaunchctl((args) =>
      args[0] === "print" ? MISSING : OK,
    );
    try {
      const result = launchdServiceManager.install({
        runLaunchctl: launchctl.run,
        log: () => {},
        plistPath,
        daemonCliPath,
        uid: UID,
        nodePath: process.execPath,
        sourceCliPath,
        sleep: () => {},
      });

      expect(result.reloaded).toBe(false);
      expect(launchctl.calls).toEqual([
        ["print", `gui/${UID}/${PLIST_LABEL}`],
        ["enable", `gui/${UID}/${PLIST_LABEL}`],
        ["bootstrap", `gui/${UID}`, plistPath],
      ]);
      // And it really wrote the two files the daemon needs.
      expect(existsSync(plistPath)).toBe(true);
      expect(existsSync(daemonCliPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("install: an already-loaded job is booted out first - the clean reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-sm-reload-"));
    const sourceCliPath = join(dir, "source-cli.js");
    writeFileSync(sourceCliPath, "console.log('meter');\n");
    let printCount = 0;
    const launchctl = recordingLaunchctl((args) => {
      if (args[0] === "print") {
        printCount += 1;
        // Loaded on the first look, gone once we've booted it out.
        return printCount === 1 ? OK : MISSING;
      }
      return OK;
    });
    try {
      const result = launchdServiceManager.install({
        runLaunchctl: launchctl.run,
        log: () => {},
        plistPath: join(dir, "ccc.plist"),
        daemonCliPath: join(dir, "cli.js"),
        uid: UID,
        nodePath: process.execPath,
        sourceCliPath,
        sleep: () => {},
      });
      expect(result.reloaded).toBe(true);
      const verbs = launchctl.calls.map((call) => call[0]);
      expect(verbs.indexOf("bootout")).toBeLessThan(verbs.indexOf("bootstrap"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("suspend: boots the job out of gui/<uid> and has nothing to restore", () => {
    const launchctl = recordingLaunchctl(() => OK);
    const suspended = launchdServiceManager.suspend({
      runLaunchctl: launchctl.run,
      uid: UID,
    });
    expect(suspended.wasActive).toBe(true);
    expect(launchctl.calls).toEqual([["bootout", `gui/${UID}/${PLIST_LABEL}`]]);
    // The .plist never left disk, so the next sign-in reloads it: restore is a no-op,
    // and it must not fire another launchctl call.
    suspended.restore();
    expect(launchctl.calls).toHaveLength(1);
  });

  test("suspend: a job that was never loaded reports so, without an error", () => {
    const launchctl = recordingLaunchctl(() => MISSING);
    expect(
      launchdServiceManager.suspend({ runLaunchctl: launchctl.run, uid: UID })
        .wasActive,
    ).toBe(false);
  });

  test("status: reads launchd's own print dump, running pid and all", () => {
    const launchctl = recordingLaunchctl(() => ({
      status: 0,
      stdout: `${PLIST_LABEL} = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}`,
      stderr: "",
    }));
    const status = launchdServiceManager.status({
      runLaunchctl: launchctl.run,
      uid: UID,
    });
    expect(launchctl.calls).toEqual([["print", `gui/${UID}/${PLIST_LABEL}`]]);
    expect(status).toEqual({
      loaded: true,
      running: true,
      pid: 4242,
      lastExitCode: 0,
    });
  });

  test("uninstall: boots out and removes the .plist and the cli.js copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-sm-uninstall-"));
    const plistPath = join(dir, "ccc.plist");
    const daemonCliPath = join(dir, "cli.js");
    writeFileSync(plistPath, "<plist/>");
    writeFileSync(daemonCliPath, "console.log('meter');");
    const launchctl = recordingLaunchctl(() => OK);
    try {
      launchdServiceManager.uninstall({
        runLaunchctl: launchctl.run,
        log: () => {},
        plistPath,
        daemonCliPath,
        uid: UID,
        labelLister: () => [],
      });
      expect(launchctl.calls).toEqual([
        ["bootout", `gui/${UID}/${PLIST_LABEL}`],
      ]);
      expect(existsSync(plistPath)).toBe(false);
      expect(existsSync(daemonCliPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The Windows backend, seen from the seam. Its own mechanics are pinned in
// windows-service.test.ts; here we only check the seam hands the injected runner
// through, so the Windows lifecycle is as testable as the macOS one.
// ---------------------------------------------------------------------------
describe("the Windows backend is reachable through the seam with everything injected", () => {
  test("suspend disables the task and restore re-enables it", () => {
    const schtasks = recordingSchtasks(() => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const suspended = schtasksServiceManager.suspend({
      runSchtasks: schtasks.run,
      taskName: "ai.marginfront.ccc",
    });
    expect(suspended.wasActive).toBe(true);
    suspended.restore();
    expect(schtasks.calls).toEqual([
      ["/Query", "/TN", "ai.marginfront.ccc"],
      ["/Change", "/TN", "ai.marginfront.ccc", "/DISABLE"],
      ["/Change", "/TN", "ai.marginfront.ccc", "/ENABLE"],
    ]);
  });

  test("describe translates the Windows read-back into the platform-neutral shape", () => {
    const registration = toServiceRegistration(
      parseScheduledTaskXml(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>RUNNER\\dev</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>RUNNER\\dev</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><Enabled>true</Enabled><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>node.exe</Command></Exec></Actions>
</Task>`),
    );
    expect(registration.backend).toBe("schtasks");
    expect(registration.startsAtLogon).toBe(true);
    expect(registration.restartsOnFailure).toBe(true);
    expect(registration.perUser).toBe(true);
    expect(registration.runAsAccount).toBe("RUNNER\\dev");
    expect(registration.enabled).toBe(true);
  });

  // NOT AN OVERSIGHT, and the comment in service-manager.ts says why: a half-wired
  // desktop path that reports itself armed and captures nothing is worse than none.
  // Pinned so wiring it up forces a deliberate decision rather than slipping through.
  test("the desktop-environment hooks are deliberately empty on Windows", () => {
    expect(() =>
      schtasksServiceManager.applyDesktopEnvironment(),
    ).not.toThrow();
    expect(() =>
      schtasksServiceManager.clearDesktopEnvironment(),
    ).not.toThrow();
  });
});
