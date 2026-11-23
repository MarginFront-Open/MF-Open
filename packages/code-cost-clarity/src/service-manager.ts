// service-manager.ts - one seam, one backend per platform.
//
// The five things the CLI wants from a background meter - install, pause, look at,
// remove, and put the telemetry vars where the desktop apps see them - are the same
// everywhere; only the commands differ. macOS has launchd, Windows has Task Scheduler,
// Linux has no backend. Adding one means writing the object and adding it to the
// table below.
//
// The macOS path is a pass-through to the launchd functions in connector.ts, with
// the same arguments in the same order.

import {
  bootoutDaemon,
  installDaemon,
  queryDaemonStatus,
  setDesktopGuiEnv,
  uninstallDaemon,
  unsetDesktopGuiEnv,
  PLIST_PATH,
} from "./connector";
import type {
  DaemonStatus,
  InstallDaemonOptions,
  UninstallDaemonOptions,
} from "./connector";
import {
  SCHEDULED_TASK_NAME,
  describeScheduledTask,
  installScheduledTask,
  queryScheduledTaskStatus,
  suspendScheduledTask,
  uninstallScheduledTask,
} from "./windows-service";
import type {
  ScheduledTaskRegistration,
  SchtasksRunner,
} from "./windows-service";

export type ServiceBackend = "launchd" | "schtasks" | "systemd";

// A union of what each backend can have injected; each reads only the fields it
// understands. Carrying the Windows runners through lets a test drive the whole
// lifecycle on either backend with no real machine underneath.
export interface ServiceOptions
  extends InstallDaemonOptions,
    UninstallDaemonOptions {
  // Windows only; ignored by the launchd backend.
  runSchtasks?: SchtasksRunner;
  taskName?: string;
  xmlPath?: string;
  userId?: string;
  forwarderPidPath?: string;
}

// What a backend says about the registration it made, in terms that mean the same
// thing on every platform. Every field must come from asking the system, never from
// the definition we wrote.
export interface ServiceRegistration {
  backend: ServiceBackend;
  registered: boolean;
  // Will the operating system start it when this user signs in?
  startsAtLogon: boolean;
  // Will the operating system bring it back if it dies?
  restartsOnFailure: boolean;
  // Is it registered for one signed-in user, rather than machine-wide as a system
  // account? This is the difference between a LaunchAgent and a LaunchDaemon, and
  // between a Task Scheduler logon task and a Windows service.
  perUser: boolean;
  // The account it runs as, for a report to quote.
  runAsAccount: string | null;
  // Registered but switched off still means it will not come back.
  enabled: boolean;
  // Whatever the platform gave us, kept so a failing assertion can show its work.
  details: Record<string, unknown>;
}

// A pause that can be undone. macOS leaves the .plist on disk so the next sign-in
// reloads it and there is nothing to restore; Windows must disable the task to stop
// restart-on-failure resurrecting a hard-killed meter, then re-enable it.
export interface SuspendedService {
  wasActive: boolean;
  restore: () => void;
}

export interface ServiceManager {
  backend: ServiceBackend;
  // A path or name a human can look at to confirm the job exists.
  definitionLocation: string;
  install(options?: ServiceOptions): { reloaded: boolean };
  suspend(options?: ServiceOptions): SuspendedService;
  uninstall(options?: ServiceOptions): void;
  status(options?: ServiceOptions): DaemonStatus;
  describe(options?: ServiceOptions): ServiceRegistration;
  // Put the telemetry variables where the GUI coding-agent apps inherit them. Real
  // work on macOS; see the Windows backend for why it is deliberately empty there.
  applyDesktopEnvironment(): void;
  clearDesktopEnvironment(): void;
}

// ---------------------------------------------------------------------------
// macOS.
// ---------------------------------------------------------------------------
export const launchdServiceManager: ServiceManager = {
  backend: "launchd",
  definitionLocation: PLIST_PATH,
  install: (options = {}) => installDaemon(options),
  suspend: (options = {}) => ({
    wasActive: bootoutDaemon(options),
    // Nothing to undo: the .plist is still on disk, so the next sign-in loads it.
    restore: () => {},
  }),
  uninstall: (options = {}) => uninstallDaemon(options),
  status: (options = {}) => queryDaemonStatus(options),
  describe: (options = {}) => {
    const status = queryDaemonStatus(options);
    return {
      backend: "launchd",
      registered: status.loaded,
      // A LaunchAgent's RunAtLoad+KeepAlive live in the .plist, which
      // renderDaemonPlist writes and launchd.test.ts pins. launchd's `print` dump
      // does not restate them in a form worth parsing, so this reports what is
      // knowable from the system: the job is loaded in the per-user GUI domain.
      startsAtLogon: status.loaded,
      restartsOnFailure: status.loaded,
      perUser: true,
      runAsAccount: null,
      enabled: status.loaded,
      details: { ...status, plistPath: PLIST_PATH },
    };
  },
  applyDesktopEnvironment: () => setDesktopGuiEnv(),
  clearDesktopEnvironment: () => unsetDesktopGuiEnv(),
};

// ---------------------------------------------------------------------------
// Windows.
// ---------------------------------------------------------------------------
export const schtasksServiceManager: ServiceManager = {
  backend: "schtasks",
  definitionLocation: `Task Scheduler \\${SCHEDULED_TASK_NAME}`,
  install: (options = {}) => installScheduledTask(options),
  suspend: (options = {}) => suspendScheduledTask(options),
  uninstall: (options = {}) => uninstallScheduledTask(options),
  status: (options = {}) => queryScheduledTaskStatus(options),
  describe: (options = {}) =>
    toServiceRegistration(describeScheduledTask(options)),
  // DELIBERATELY EMPTY, and it is not an oversight. On macOS this puts the telemetry
  // variables into the launchd GUI session so the Claude and Codex DESKTOP apps
  // inherit them. The Windows counterpart would be a write to the user's environment in
  // the registry, and no Windows desktop app is known to pick that up. A half-wired desktop path would report itself armed and capture
  // nothing.
  applyDesktopEnvironment: () => {},
  clearDesktopEnvironment: () => {},
};

// Translate the Windows-shaped read-back into the platform-neutral shape.
export function toServiceRegistration(
  registration: ScheduledTaskRegistration,
): ServiceRegistration {
  return {
    backend: "schtasks",
    registered: registration.registered,
    startsAtLogon: registration.startsAtLogon,
    restartsOnFailure: registration.restartsOnFailure,
    perUser: registration.perUser,
    runAsAccount: registration.runAsUserId,
    enabled: registration.enabled,
    details: { ...registration },
  };
}

// A refusal, not a stub that pretends. Telling someone their spend is being captured
// in the background when nothing is capturing it is the worst outcome available.
export function unsupportedPlatformMessage(platformName: string): string {
  return [
    `There's no background meter for ${platformName} yet.`,
    "What this means: on macOS and Windows the meter starts itself when you sign in.",
    "  Here, nothing starts it, so there's nothing to install.",
    "Fix: run the meter in a terminal and leave it open while you code:",
    "       node ~/.marginfront-ccc/cli.js run",
    "     Usage that happens while that terminal is closed is lost, not buffered.",
  ].join("\n");
}

// THE WHOLE ROUTING TABLE, in one place.
const BACKENDS_BY_PLATFORM: Record<string, ServiceManager> = {
  darwin: launchdServiceManager,
  win32: schtasksServiceManager,
};

// Every platform this build can meter in the background. Derived from the table so a
// test cannot assert against a list that has drifted from the code.
export const SUPPORTED_SERVICE_PLATFORMS = Object.keys(BACKENDS_BY_PLATFORM);

// For the best-effort call sites, where an unsupported platform means there was
// nothing to pause or remove rather than something going wrong.
export function findServiceManager(
  platformName: string,
): ServiceManager | null {
  return BACKENDS_BY_PLATFORM[platformName] ?? null;
}

// For the call sites where the user ASKED for a background meter: they must be told
// plainly when they are not getting one.
export function selectServiceManager(platformName: string): ServiceManager {
  const manager = findServiceManager(platformName);
  if (!manager) throw new Error(unsupportedPlatformMessage(platformName));
  return manager;
}
