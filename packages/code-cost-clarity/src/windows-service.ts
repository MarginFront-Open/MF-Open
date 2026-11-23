// windows-service.ts - the background meter on Windows, as a per-user Task Scheduler
// logon task: the counterpart of the macOS LaunchAgent, starting at sign-in.
//
// NOT A WINDOWS SERVICE, and not a mistake: a service runs in session 0 under a
// service account and needs admin rights to install. The meter has to be the user -
// their ~/.claude, their session's localhost, no UAC prompt.
//
// schtasks.exe, NOT the PowerShell ScheduledTasks module. schtasks is in System32 on
// every SKU; PowerShell is restricted by policy (AppLocker, Constrained Language Mode)
// on exactly the managed corporate laptops the meter targets. /Create /XML is also the
// only command-line route that can set restart-on-failure at all, and /Query /XML ONE
// reads back what the Task Scheduler service actually stored rather than the string we
// wrote - which is what makes the survives-sign-in assertions worth anything.
//
// WHAT THAT COSTS: schtasks reports run state and last result only as LOCALIZED text,
// so this backend does not parse either. "Is the meter running" comes from the
// forwarder's own pidfile, which is the truth anyway; the crash-loop signal macOS gets
// from launchd's last exit code has no locale-safe equivalent here, so it is not reported.
//
// NO CONSOLE WINDOW. A console program started by an InteractiveToken task gets a
// console window on the user's desktop, and closing that window kills the meter
// (a "Started collector" CMD window would appear after every sign-in). So the
// task's program is conhost.exe --headless, the console host
// itself, which creates no window and starts node as its client. It is in System32 on
// every SKU since Windows 10 1809, it is not a script (AppLocker script rules cover
// .ps1/.bat/.cmd/.vbs/.js, so a .vbs launcher can be blocked where this cannot), and it
// keeps InteractiveToken: the S4U logon type would also hide the window, but Microsoft
// documents it as working only for local accounts and registering it needs admin, and
// managed corporate laptops are usually domain-joined with standard users.
//
// AND NOWHERE TO PRINT. A headless console host has no screen behind it and Task
// Scheduler captures nothing, so the meter's own output would be lost - the two files
// `status` tails are written by launchd on macOS and by nobody here. So the action ends
// in the run flag that makes the meter append to those files itself.
//
// The price: conhost always exits 0 when its client leaves (microsoft/terminal#17178,
// closed as not planned), so Task Scheduler never sees a node crash as a failure and
// RestartOnFailure only fires when the action cannot launch at all. A crashed forwarder
// stays down until the next sign-in or `start`.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  CONFIG_DIR,
  DAEMON_CLI_PATH,
  FORWARDER_PID_PATH,
  LOG_TO_FILES_FLAG,
  assertNotNpx,
  isPidAlive,
  stageDaemonCli,
} from "./connector";
import type { DaemonStatus } from "./connector";

type LogFn = (message: string) => void;

// The task's name, matching the launchd label so the two backends are searchable as
// one thing. Registered at the root of the Task Scheduler library, so its full path -
// the URI Windows echoes back - is "\ai.marginfront.ccc".
export const SCHEDULED_TASK_NAME = "ai.marginfront.ccc";

// Matches the meter's task AND any namespaced child a past run may have left behind, but not
// an unrelated task that merely starts with the same letters. The Windows twin of
// CCC_LABEL_PATTERN. Task Scheduler reports names with a leading path separator.
const CCC_TASK_PATTERN = /^\\?ai\.marginfront\.ccc(\.|$)/i;

// Restart-on-failure. With the headless console host in front of node this only
// covers an action that could not launch at all; see the file header for why a node
// crash does not count.
export const TASK_RESTART_INTERVAL = "PT1M";
export const TASK_RESTART_COUNT = 3;

// One schtasks invocation, normalized to the same shape the launchd backend uses so
// both read identically at the call sites.
export interface SchtasksResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Injected everywhere below so install/uninstall/status logic is unit-testable
// WITHOUT a real Task Scheduler - a fake runner just records the calls.
export type SchtasksRunner = (args: string[]) => SchtasksResult;

// schtasks writes its output in the console's code page, not UTF-8, and writes some
// output as UTF-16. Decode by what the bytes say: a UTF-16LE byte-order mark means
// UTF-16, anything else is read as UTF-8 (identical to the console code page across
// the ASCII range, which is all of our XML except a non-ASCII account name).
export function decodeSchtasksOutput(raw: Buffer | string): string {
  if (typeof raw === "string") return raw;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.subarray(2).toString("utf16le");
  }
  return raw.toString("utf8");
}

// The production runner. windowsHide so a `status` from a GUI-launched terminal
// cannot flash a console window.
export function defaultSchtasksRunner(args: string[]): SchtasksResult {
  const result = spawnSync("schtasks", args, { windowsHide: true });
  return {
    // A spawn error (schtasks missing, i.e. not Windows) leaves status null; treat
    // that as failure so a caller never reads it as "succeeded".
    status: typeof result.status === "number" ? result.status : 1,
    stdout: decodeSchtasksOutput(result.stdout ?? ""),
    stderr: decodeSchtasksOutput(result.stderr ?? ""),
  };
}

// Who the task runs as. USERDOMAIN is the machine name on a workgroup PC and the AD
// domain on a joined one; either way "DOMAIN\user" is the form Task Scheduler wants.
// Falls back through USERNAME to the OS's own answer so this never yields "undefined".
export function currentWindowsUserId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name =
    env.USERNAME ||
    (() => {
      try {
        return userInfo().username;
      } catch {
        return "";
      }
    })();
  const domain = env.USERDOMAIN;
  return domain && name ? `${domain}\\${name}` : name;
}

// Escape the three characters that would break element text. Attribute quoting is not
// escaped because nothing we interpolate lands in an attribute.
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The inverse, for the read-back: Windows re-serializes a path containing "&" as
// "&amp;", and a caller comparing it to the path on disk needs the real character.
function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// The console host that fronts the meter so it gets no window. Absolute, not a bare
// "conhost.exe", so the read-back names one file and PATH plays no part.
export function defaultConsoleHostPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
  return `${systemRoot}\\System32\\conhost.exe`;
}

// The first token of a command line: a double-quoted run (Windows paths cannot contain
// a double quote, so there is nothing to unescape) or a bare word.
function leadingCommandLineToken(commandLine: string): string | null {
  const match = commandLine.match(/^\s*(?:"([^"]*)"|(\S+))/);
  return match ? (match[1] ?? match[2]) : null;
}

// THE THREE SETTINGS BELOW OVERRIDE A DEFAULT THAT WOULD SILENTLY BREAK THE METER:
// ExecutionTimeLimit defaults to 3 days (PT0S means none), and both battery settings
// default to true, which would stop the meter the moment a laptop was unplugged.
//
// The element order inside <Settings> is not ours to choose: the schema is a sequence,
// and a valid-looking file in the wrong order is rejected at register time. This is
// the order Windows itself emits when it exports a task.
export function renderScheduledTaskXml({
  nodePath,
  cliPath,
  userId,
  workingDirectory = CONFIG_DIR,
  consoleHostPath = defaultConsoleHostPath(),
}: {
  nodePath: string;
  cliPath: string;
  userId: string;
  workingDirectory?: string;
  consoleHostPath?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${escapeXmlText(userId)}</Author>
    <Description>MarginFront Code Cost Clarity - keeps your coding-agent spend metered in the background.</Description>
    <URI>\\${escapeXmlText(SCHEDULED_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXmlText(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXmlText(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>${TASK_RESTART_INTERVAL}</Interval>
      <Count>${TASK_RESTART_COUNT}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXmlText(consoleHostPath)}</Command>
      <Arguments>--headless "${escapeXmlText(nodePath)}" "${escapeXmlText(cliPath)}" run ${LOG_TO_FILES_FLAG}</Arguments>
      <WorkingDirectory>${escapeXmlText(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// READING THE REGISTRATION BACK. Nothing here may be answered from the definition we
// wrote: a definition Windows silently downgraded would still match its own source
// text, and that read-back is the only proof we have that the meter is configured to
// come back at sign-in.

export interface ScheduledTaskRegistration {
  registered: boolean;
  // Is the only trigger a logon trigger, and is it enabled?
  startsAtLogon: boolean;
  // Every trigger element Windows reports, so "a logon trigger AND a daily one" is
  // distinguishable from "a logon trigger".
  triggerTypes: string[];
  // Whose logon fires it. Null when the trigger applies to every user.
  logonTriggerUserId: string | null;
  restartsOnFailure: boolean;
  restartIntervalIso: string | null;
  restartCount: number | null;
  // The account the task runs as, and how it gets its token.
  runAsUserId: string | null;
  logonType: string | null;
  // As Windows reports it, which is NULL when it stored the default. Windows drops
  // every element whose value is the default when it re-serializes a task, so absent
  // here means LeastPrivilege - read `elevated` rather than comparing this to a string.
  runLevel: string | null;
  // Would it run with an administrator token? A background meter has no business with
  // UAC, and this is the claim we actually care about.
  elevated: boolean;
  // Registered against a real interactive user rather than as a machine-wide task
  // running under a system account.
  perUser: boolean;
  // Task Scheduler's own enable switch. A registered-but-disabled task will not start
  // at logon, so this belongs in any honest "will it survive" answer.
  enabled: boolean;
  executionTimeLimit: string | null;
  // The program Task Scheduler starts and its arguments, exactly as stored.
  command: string | null;
  argumentsText: string | null;
  // Is that program the headless console host, so the meter gets no window?
  hidesConsoleWindow: boolean;
  // The program that actually meters: node, whether it is the command itself or the
  // console host's client.
  meterProgram: string | null;
  // The XML we parsed, so a failing assertion can show what Windows actually said.
  source: string;
}

const NOT_REGISTERED: ScheduledTaskRegistration = {
  registered: false,
  startsAtLogon: false,
  triggerTypes: [],
  logonTriggerUserId: null,
  restartsOnFailure: false,
  restartIntervalIso: null,
  restartCount: null,
  runAsUserId: null,
  logonType: null,
  runLevel: null,
  elevated: false,
  perUser: false,
  enabled: false,
  executionTimeLimit: null,
  command: null,
  argumentsText: null,
  hidesConsoleWindow: false,
  meterProgram: null,
  source: "",
};

// The three well-known system accounts. A task registered against any of these is a
// machine task, not a per-user one - the exact thing we promised not to create.
const SYSTEM_ACCOUNT_PATTERN =
  /^(S-1-5-1[89]|S-1-5-20|NT AUTHORITY\\|SYSTEM$|LOCALSYSTEM$|LOCAL SERVICE$|NETWORK SERVICE$)/i;

function sectionOf(xml: string, tag: string): string {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return match ? match[1] : "";
}

function valueOf(scope: string, tag: string): string | null {
  const match = scope.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return match ? unescapeXmlText(match[1].trim()) : null;
}

// Behind the console host the meter is the first client argument, not the command.
function readMeterAction(
  command: string | null,
  argumentsText: string | null,
): { hidesConsoleWindow: boolean; meterProgram: string | null } {
  const viaConsoleHost =
    command !== null &&
    /(^|[\\/])conhost\.exe$/i.test(command) &&
    argumentsText !== null &&
    /^--headless(\s|$)/i.test(argumentsText);
  if (!viaConsoleHost) {
    return { hidesConsoleWindow: false, meterProgram: command };
  }
  const client = leadingCommandLineToken(
    argumentsText.replace(/^--headless\s*/i, ""),
  );
  return { hidesConsoleWindow: true, meterProgram: client };
}

// Parse a `schtasks /Query /XML ONE` dump. Pure and exported so the parser is tested
// against real captured Windows output rather than an idealized string.
export function parseScheduledTaskXml(
  rawXml: string,
): ScheduledTaskRegistration {
  // schtasks prefixes the dump with a blank line and may leave a BOM on the front.
  const xml = rawXml.replace(/^\uFEFF/, "").trim();
  if (!/<Task\b/i.test(xml)) return { ...NOT_REGISTERED, source: rawXml };

  const triggers = sectionOf(xml, "Triggers");
  const triggerTypes = [...triggers.matchAll(/<(\w*Trigger)\b/g)].map(
    (m) => m[1],
  );
  const logonTrigger = sectionOf(triggers, "LogonTrigger");
  // A trigger with no <Enabled> element is enabled; only an explicit false disables it.
  const logonTriggerEnabled =
    logonTrigger.length > 0 && valueOf(logonTrigger, "Enabled") !== "false";

  const principal = sectionOf(sectionOf(xml, "Principals"), "Principal");
  const runAsUserId = valueOf(principal, "UserId");
  const logonType = valueOf(principal, "LogonType");
  const runLevel = valueOf(principal, "RunLevel");
  const groupId = valueOf(principal, "GroupId");

  const settings = sectionOf(xml, "Settings");
  const restart = sectionOf(settings, "RestartOnFailure");
  const restartCountRaw = valueOf(restart, "Count");
  // <Enabled> also appears inside the trigger; read it from the Settings scope only.
  const settingsEnabled = valueOf(
    settings.replace(/<IdleSettings>[\s\S]*?<\/IdleSettings>/i, ""),
    "Enabled",
  );

  const exec = sectionOf(sectionOf(xml, "Actions"), "Exec");
  const command = valueOf(exec, "Command");
  const argumentsText = valueOf(exec, "Arguments");

  return {
    registered: true,
    startsAtLogon:
      logonTriggerEnabled &&
      triggerTypes.length === 1 &&
      triggerTypes[0] === "LogonTrigger",
    triggerTypes,
    logonTriggerUserId: valueOf(logonTrigger, "UserId"),
    restartsOnFailure: restart.length > 0 && restartCountRaw !== null,
    restartIntervalIso: valueOf(restart, "Interval"),
    restartCount: restartCountRaw ? parseInt(restartCountRaw, 10) : null,
    runAsUserId,
    logonType,
    runLevel,
    elevated: runLevel === "HighestAvailable",
    // Per-user means all three: a named account, that account is not a system one,
    // and the token is the interactive user's. GroupId instead of UserId means the
    // task was registered for a whole group, which is not per-user either.
    perUser:
      runAsUserId !== null &&
      groupId === null &&
      !SYSTEM_ACCOUNT_PATTERN.test(runAsUserId) &&
      logonType === "InteractiveToken",
    enabled: settingsEnabled !== "false",
    executionTimeLimit: valueOf(settings, "ExecutionTimeLimit"),
    command,
    argumentsText,
    ...readMeterAction(command, argumentsText),
    source: xml,
  };
}

// Pull every task name out of `schtasks /Query /FO CSV /NH`. The first CSV column is
// the task's full path; the other columns are localized and are ignored on purpose.
export function parseScheduledTaskNames(csv: string): string[] {
  const names: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const match = line.match(/^\s*"([^"]*)"/);
    if (match && match[1]) names.push(match[1]);
  }
  return names;
}

// ===========================================================================
// LIFECYCLE
// ===========================================================================

export interface ScheduledTaskOptions {
  runSchtasks?: SchtasksRunner;
  log?: LogFn;
  taskName?: string;
  daemonCliPath?: string;
  forwarderPidPath?: string;
}

export interface InstallScheduledTaskOptions extends ScheduledTaskOptions {
  nodePath?: string;
  sourceCliPath?: string;
  userId?: string;
  // Where the definition is staged for schtasks to read. Tests point this at a temp
  // file; production uses the OS temp dir and deletes it either way.
  xmlPath?: string;
  workingDirectory?: string;
  consoleHostPath?: string;
}

export interface InstallScheduledTaskResult {
  reloaded: boolean;
  taskName: string;
  daemonCliPath: string;
  xml: string;
}

// Ask Windows for the stored definition. Nonzero exit means no such task.
export function describeScheduledTask(
  options: ScheduledTaskOptions = {},
): ScheduledTaskRegistration {
  const run = options.runSchtasks ?? defaultSchtasksRunner;
  const taskName = options.taskName ?? SCHEDULED_TASK_NAME;
  const result = run(["/Query", "/TN", taskName, "/XML", "ONE"]);
  if (result.status !== 0) return { ...NOT_REGISTERED, source: result.stderr };
  return parseScheduledTaskXml(result.stdout);
}

// /Create with /F is the whole reload: unlike launchd there is no teardown race to
// poll around. The /Run at the end is not optional - a logon trigger fires at logon,
// so without it `start` would report success on a meter that does not begin metering
// until the user next signs in.
export function installScheduledTask(
  options: InstallScheduledTaskOptions = {},
): InstallScheduledTaskResult {
  const run = options.runSchtasks ?? defaultSchtasksRunner;
  const log = options.log ?? console.log;
  const taskName = options.taskName ?? SCHEDULED_TASK_NAME;
  const nodePath = options.nodePath ?? process.execPath;
  const daemonCliPath = options.daemonCliPath ?? DAEMON_CLI_PATH;
  const sourceCliPath = options.sourceCliPath ?? process.argv[1];
  const userId = options.userId ?? currentWindowsUserId();
  const xmlPath =
    options.xmlPath ?? join(tmpdir(), `ccc-scheduled-task-${process.pid}.xml`);

  assertNotNpx(nodePath);
  stageDaemonCli({ sourceCliPath, daemonCliPath, nodePath, log });

  const xml = renderScheduledTaskXml({
    nodePath,
    cliPath: daemonCliPath,
    userId,
    workingDirectory: options.workingDirectory ?? CONFIG_DIR,
    consoleHostPath: options.consoleHostPath ?? defaultConsoleHostPath(),
  });

  const existing = run(["/Query", "/TN", taskName]);
  const reloaded = existing.status === 0;
  if (reloaded) {
    log("A background meter is already registered - replacing its definition.");
  }

  // schtasks reads the definition as Unicode. Writing UTF-8 gets it rejected with a
  // formatting error that names nothing useful, so write UTF-16LE with a BOM to match
  // the encoding the declaration claims.
  mkdirSync(dirname(xmlPath), { recursive: true });
  writeFileSync(xmlPath, Buffer.from("\uFEFF" + xml, "utf16le"));
  try {
    const create = run(["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
    if (create.status !== 0) {
      throw new Error(
        "Could not set up the background meter (Windows Task Scheduler refused the job).\n" +
          `What happened: registering the scheduled task "${taskName}" failed.\n` +
          (create.stderr.trim()
            ? `Windows said: ${create.stderr.trim()}\n`
            : "") +
          "Fix: run `node ~/.marginfront-ccc/cli.js status` to see the " +
          "current state, or `stop` then `start` again. If it keeps failing, open " +
          "Task Scheduler and check whether a task named above already exists and " +
          "is owned by another account.",
      );
    }
  } finally {
    try {
      rmSync(xmlPath, { force: true });
    } catch {
      /* a leftover temp definition is inert; never mask the error above */
    }
  }
  log(`Registered the background meter as the scheduled task "${taskName}".`);

  const started = run(["/Run", "/TN", taskName]);
  if (started.status !== 0) {
    log(
      "Registered the meter, but Windows would not start it right now. It will " +
        "start at your next sign-in.",
    );
  }

  log(
    "The background meter is registered and will start at sign-in from now on.",
  );
  return { reloaded, taskName, daemonCliPath, xml };
}

export interface SuspendedTask {
  wasActive: boolean;
  restore: () => void;
}

// If `stop` has to escalate to a hard kill the task exits nonzero, and
// restart-on-failure would bring the meter back a minute later - `stop` would appear
// to have done nothing. Disabling first cancels that. restore() re-enables, so `stop`
// keeps the macOS meaning: paused now, back at the next `start` or sign-in.
export function suspendScheduledTask(
  options: ScheduledTaskOptions = {},
): SuspendedTask {
  const run = options.runSchtasks ?? defaultSchtasksRunner;
  const taskName = options.taskName ?? SCHEDULED_TASK_NAME;
  if (run(["/Query", "/TN", taskName]).status !== 0) {
    return { wasActive: false, restore: () => {} };
  }
  run(["/Change", "/TN", taskName, "/DISABLE"]);
  return {
    wasActive: true,
    restore: () => {
      run(["/Change", "/TN", taskName, "/ENABLE"]);
    },
  };
}

// /End before /Delete so a running instance is not orphaned. Every result is ignored
// on purpose: "no such task" is the normal outcome on a machine that never installed
// one, and uninstall must succeed cleanly either way.
export function uninstallScheduledTask(
  options: ScheduledTaskOptions & {
    taskLister?: (run: SchtasksRunner) => string[];
  } = {},
): void {
  const run = options.runSchtasks ?? defaultSchtasksRunner;
  const log = options.log ?? console.log;
  const taskName = options.taskName ?? SCHEDULED_TASK_NAME;
  const daemonCliPath = options.daemonCliPath ?? DAEMON_CLI_PATH;
  const listTasks = options.taskLister ?? defaultScheduledTaskLister;

  // Deduped by the task's IDENTITY, not its spelling: Task Scheduler lists root-level
  // tasks with a leading separator ("\ai.marginfront.ccc") and accepts them with or
  // without one, so a plain Set would delete our own task twice - once under each
  // spelling - and log the removal twice with it.
  const toRemove = new Map<string, string>();
  const identityOf = (name: string) => name.replace(/^\\/, "").toLowerCase();
  toRemove.set(identityOf(taskName), taskName);
  for (const name of listTasks(run)) {
    if (CCC_TASK_PATTERN.test(name) && !toRemove.has(identityOf(name))) {
      toRemove.set(identityOf(name), name);
    }
  }
  for (const name of toRemove.values()) {
    run(["/End", "/TN", name]);
    const deleted = run(["/Delete", "/TN", name, "/F"]);
    if (deleted.status === 0) {
      log(`Removed the scheduled task "${name}".`);
    }
  }

  if (existsSync(daemonCliPath)) {
    rmSync(daemonCliPath, { force: true });
    log(`Removed the meter program copy at ${daemonCliPath}.`);
  }
}

// Every registered task name, so uninstall can sweep orphans. A nonzero status is
// treated as "nothing to add" - never a throw.
export function defaultScheduledTaskLister(run: SchtasksRunner): string[] {
  const listed = run(["/Query", "/FO", "CSV", "/NH"]);
  if (listed.status !== 0) return [];
  return parseScheduledTaskNames(listed.stdout);
}

// `loaded` folds in enabled: a registered-but-disabled task will not come back at
// sign-in, so reporting it as loaded would be a lie. `running` comes from the
// forwarder's pidfile rather than schtasks' own run state, which is localized text.
// `lastExitCode` is always null here - see the file header.
export function queryScheduledTaskStatus(
  options: ScheduledTaskOptions = {},
): DaemonStatus {
  const registration = describeScheduledTask(options);
  const pidPath = options.forwarderPidPath ?? FORWARDER_PID_PATH;

  let pid: number | null = null;
  if (existsSync(pidPath)) {
    try {
      const parsed = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (Number.isInteger(parsed)) pid = parsed;
    } catch {
      pid = null;
    }
  }
  const running = pid !== null && isPidAlive(pid);

  return {
    loaded: registration.registered && registration.enabled,
    running,
    pid: running ? pid : null,
    lastExitCode: null,
  };
}
