#!/usr/bin/env node
// cli.ts - the one CLI: init, preview, run, stop, uninstall.
//
// WHY: wraps the manual steps (download a binary, source a file, run a node
// script by hand) behind five commands so onboarding is one line.
//
// connector.ts = config dir, templates, collector fetch/launch, env loader.
// forwarder.ts = the translator (preview + live watch).

import {
  existsSync,
  rmSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import process from "node:process";
import { platform } from "node:os";
import {
  CONFIG_DIR,
  ENV_PATH,
  COLLECTOR_CONFIG_PATH,
  COLLECTOR_BIN_PATH,
  LIVE_JSONL_PATH,
  COLLECTOR_PID_PATH,
  COLLECTOR_LOG_PATH,
  FORWARDER_CURSOR_PATH,
  FORWARDER_QUEUE_PATH,
  FORWARDER_PID_PATH,
  FORWARDER_AUTH_HOLD_PATH,
  LAST_AGENT_PATH,
  CCC_COMMAND_INVOCATION,
  writeWorkIdToEnv,
  clearWorkIdsInEnv,
  writeFinishedWorkNamesToEnv,
  writeFinishedWorkMemoryBlocks,
  removeFinishedWorkMemoryBlocks,
  type MemoryBlockResult,
  ensureConfigFiles,
  ensureCollectorBinary,
  loadEnvFile,
  writeApiKeyToEnv,
  writeDeveloperEmailToEnv,
  writeCacheWriteTtlToEnv,
  writeServerUrlToEnv,
  stageDaemonCli,
  DAEMON_CLI_PATH,
  CCC_SOURCE_INIT_COMMAND,
  detectCacheWriteTtl,
  gitGlobalUserEmail,
  startCollector,
  stopCollector,
  isPidAlive,
  CODEX_OTEL_TOML_BLOCK,
  writeCodexOtelConfig,
  claudeTelemetryIsWired,
  removeCodexOtelConfig,
  codexConfigHasCccBlock,
  signalForwarderStop,
  readShutdownRequest,
  clearShutdownRequest,
  SHUTDOWN_REQUEST_POLL_MS,
  readLastLines,
  DAEMON_STDOUT_LOG_PATH,
  DAEMON_STDERR_LOG_PATH,
  LOG_TO_FILES_FLAG,
  routeConsoleOutputToFiles,
  PLIST_PATH,
  rotateLogIfHuge,
  type DaemonStatus,
  // Global-config wiring + reverters.
  CLAUDE_SETTINGS_PATH,
  CODEX_CONFIG_PATH,
  CCC_TELEMETRY_VALUES,
  writeClaudeTelemetrySettings,
  removeClaudeTelemetrySettings,
  findCccZshrcSourceLines,
  removeCccZshrcSourceLine,
  type WriteClaudeSettingsResult,
  type RemoveClaudeSettingsResult,
  type WriteCodexConfigResult,
  type RemoveCodexConfigResult,
  type ZshrcSourceLineResult,
} from "./connector";
// THE PLATFORM SEAM. Every "start / pause / look at / remove the background meter"
// call goes through here so this file never names launchctl or schtasks. See
// service-manager.ts for why the macOS path is a pass-through.
import {
  selectServiceManager,
  findServiceManager,
  unsupportedPlatformMessage,
} from "./service-manager";
import {
  readAndParseOtlpFile,
  buildRequestBodyForLine,
  watchAndForward,
  resolveDeveloperOverride,
  createWorkIdReader,
  createIgnoredReposReader,
  recordSessionId,
  IGNORE_REPOS_ENV_KEY,
  resolveWorkId,
  normalizeWorkId,
  MATTER_NUMBER_ENV_KEY,
  WORK_ID_ENV_KEY,
  WORK_ITEM_NOUN,
  WORK_ITEM_NOUN_PLAIN,
  resolveCacheWriteTtl,
  checkKeyWithServer,
  clearAuthHold,
  readAuthHold,
  countQueueRecords,
  appendToQueue,
  postToMarginFront,
  isRetryablePostResult,
  isAuthFailurePostResult,
  readLastAgentSeen,
  NO_IDENTITY_CUSTOMER,
  CODEX_NO_IDENTITY_CUSTOMER,
  CCC_PACKAGE_VERSION,
} from "./forwarder";
import type { IgnoredRepos, WorkId } from "./forwarder";
import {
  FINISHED_WORK_MAX_COUNT,
  FINISHED_WORK_NAMES_ENV_KEY,
  buildFinishedWorkRecord,
  normalizeFinishedName,
  parseFinishedCount,
  parseFinishedWorkNames,
  renderFinishedWorkNames,
  roiFinishedWorkPointer,
} from "./finished-work";
import {
  createGitCoordinatesResolver,
  readGitCoordinates,
} from "./git-coordinates";
import type {
  CacheWriteTtl,
  GitCoordinates,
  KeyCheckResult,
  AuthHoldState,
  PostResult,
  RequestBody,
  UsageRecord,
} from "./types";
// Spend Control: the opt-in `init --control` capability. Script + hook
// install, first spend-state pull, and the uninstall reverter for both.
import {
  writeControlScript,
  writeControlHook,
  removeControlHook,
  syncControlState,
  CONTROL_DIR,
  // Codex arm: the same cap check, wired into Codex's own hook file.
  writeCodexCapHookWrapper,
  writeCodexControlHook,
  removeCodexControlHook,
  isCodexInstalled,
  isClaudeCodeInstalled,
  isControlArmed,
  isCodexControlArmed,
  resolveCodexControlStatus,
  renderCodexControlStatusDetail,
  type CodexControlStatus,
  CODEX_HOOKS_PATH,
  CONTROL_SPENT_PATH,
} from "./control";
import { resolveConfiguredServer } from "./server-url";
import {
  INSECURE_HTTP_SETTING,
  SERVER_URL_SETTING,
  type ServerUrlResult,
} from "./transport-policy";

const PKG_NAME = "@marginfront/code-cost-clarity";

// Our version. Reuses the SAME resolver the forwarder uses (forwarder.ts
// resolveCccPackageVersion): it prefers the build-time-inlined literal, so
// `version` prints the real version even when run from the relocated daemon copy
// at ~/.marginfront-ccc/cli.js - where reading package.json at runtime is
// impossible. One source of truth means the CLI banner and the User-Agent header
// can never disagree.
function readVersion(): string {
  return CCC_PACKAGE_VERSION;
}

// Windows meters the CLI agents only: schtasksServiceManager's desktop-env step is
// deliberately a no-op there. A parameter, not a read, so the copy gate can drive it.
export function renderHelp(hostPlatform: () => string = platform): string {
  const desktopApps =
    hostPlatform() === "win32" ? "" : " (or open the desktop apps)";
  return [
    `${PKG_NAME} - see your Claude Code + Codex spend in MarginFront`,
    "",
    "Usage:",
    `  First run, from the root of your MarginFront source checkout:  ${CCC_SOURCE_INIT_COMMAND}`,
    `  Every run after that:  ${CCC_COMMAND_INVOCATION} <command> [options]`,
    "",
    "Commands:",
    "  init                 Set up everything: save your MarginFront secret key (mf_sk_...), not",
    "                       your Anthropic or OpenAI key. Ask which developer THIS machine's AI",
    "                       cost belongs to (for teams on a shared Claude/Codex login). Wire",
    "                       telemetry into your Claude/Codex config (with your OK), and start",
    "                       the background meter.",
    "  start                (Re)start the background meter - starts at login, no terminal to keep open.",
    "  status               Is the background meter running? Shows recent activity + errors.",
    `  work ["<name>"]      Put this machine's spend on a ${WORK_ITEM_NOUN_PLAIN}. No name prints the current one;`,
    "                       --clear removes it. Nothing to restart.",
    `  done "<name>" [n]    Count something you finished, so ROI in your dashboard's left menu can show what one cost on its Finished work tab.`,
    "                       It costs nothing on its own. --setup turns finished-work counting on or off.",
    "  preview <file.json>  Show the exact record it would send for a capture. No key needed.",
    "  run                  Stream your live spend in THIS terminal instead of the background. Ctrl-C to stop.",
    "  stop                 Pause the meter - the background daemon AND any foreground run.",
    "  uninstall            Shut it off, undo every config change, and reclaim disk. --purge also deletes settings.",
    "  help                 Show this message.",
    "  version              Print the version.",
    "",
    "Options:",
    "  --api-url <address>  (init only) Your MarginFront server's API address, including /v1,",
    "                       for example https://billing.example.com/v1. Saved as",
    `                       ${SERVER_URL_SETTING} in the settings file. There is no built-in server.`,
    "  --no-prompt          (init only) Skip ALL questions (key paste, developer email, cache-TTL,",
    "                       consent) and proceed - it WILL wire your global config. For CI / scripts.",
    "  --control            (init only) Also turn ON Spend Control: install your team's admin-set",
    "                       spend cap as a check that can STOP a Claude Code or Codex tool call",
    "                       when the cap is reached. Opt-in, fails open, removed cleanly by",
    "                       uninstall. (Codex arms after you trust it once via /hooks.)",
    "  --fold-cache         Round-up mode: roll cache tokens into billed input. Only use",
    "                       for a model MarginFront can't price yet - the default is accurate.",
    "  --log-to-files       (run only) Write this command's own output to the two log files `status`",
    "                       shows instead of to the screen. The Windows background task passes it;",
    "                       you do not need it yourself.",
    "  --purge              (uninstall only) Also delete your settings, including your MarginFront secret key (mf_sk_...).",
    "",
    "Setup is one step:",
    `  ${CCC_SOURCE_INIT_COMMAND}`,
    "    → it asks for your server address and a few numbered questions (your key first), then ends with a",
    "      SETUP COMPLETE checklist and the one thing left to do, if anything.",
    `  Then run \`claude\` or \`codex\`${desktopApps} - telemetry flows`,
    "  automatically. No `source`, no second terminal. Check on it with `status` anytime.",
    "",
    "Prefer a live terminal view instead of the background meter? After init, run:",
    "  node ~/.marginfront-ccc/cli.js run",
    "",
    "Sharing one Claude/Codex login across a team? (per-developer cost attribution)",
    "  During `init` we ask which developer THIS machine's AI cost belongs to and save it",
    "  as CCC_DEVELOPER_EMAIL in ~/.marginfront-ccc/.env. At send time the order is:",
    "    1. CCC_DEVELOPER_EMAIL (this machine's developer) - if set, it always wins;",
    "    2. otherwise the email the coding-agent login reports;",
    "    3. otherwise a no-identity placeholder.",
    "  Leave it BLANK to auto-detect from the coding-agent login. Edit the .env to change it,",
    "  then `stop` and `start` (or re-run `init`). Internal cost visibility only -",
    "  it does NOT change anyone's bill.",
  ].join("\n");
}

// Shown when usage fell back to the placeholder customer, or up-front in `run`.
function printNoIdentityHint(): void {
  console.log(
    [
      "Note: usage with no developer email is attributed to a no-identity placeholder",
      `  ("${NO_IDENTITY_CUSTOMER}" for Claude Code, "${CODEX_NO_IDENTITY_CUSTOMER}" for Codex).`,
      "  Fix: sign in with an org-managed seat, or attach your own MarginFront customer",
      "  mapping. Until then the spend still lands, under the placeholder instead of the",
      "  developer's name.",
      "  Why this happens:",
      '  packages/code-cost-clarity/README.md, "Per-developer attribution is automatic"',
    ].join("\n"),
  );
}

function printHelp(): void {
  console.log(renderHelp());
}

// In terminal mode readline REDRAWS its prompt before it reads a key (ESC[1G, ESC[0J,
// then the prompt), so a question written to the stream by hand is erased and the
// user sees a blank line. The question therefore has to be readline's own prompt.
// Its cursor math assumes that prompt is one line, so leading newlines are split off
// and written separately.
function splitLeadingNewlines(promptText: string): {
  lead: string;
  prompt: string;
} {
  const lead = /^\n*/.exec(promptText)?.[0] ?? "";
  return { lead, prompt: promptText.slice(lead.length) };
}

// Read the API key without echoing it (never shows on screen or in scrollback).
// Returns "" on empty / Ctrl-C, which the caller treats as "skipped".
export function promptSecret(
  promptText: string,
  io: PromptIO = {},
): Promise<string> {
  return new Promise((resolve) => {
    const input = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    const rl = readline.createInterface({
      input,
      output,
      terminal: io.terminal ?? true,
    });
    const { lead, prompt } = splitLeadingNewlines(promptText);
    // Every redraw of the prompt and every echoed keystroke goes through this private
    // writer. Let the prompt through and drop the rest: the question stays readable
    // and the key never lands on screen (even '*' would leak its length). Private
    // API, but the standard way to mask input with readline.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
      (text: string) => {
        if (text.startsWith(prompt)) output.write(prompt);
      };

    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      // Echo is muted, so re-print the Enter newline or the next line glues to the prompt.
      output.write("\n");
      resolve(answer.trim());
    };

    if (lead) output.write(lead);
    rl.question(prompt, (answer) => finish(answer));
    // Ctrl-C at the prompt = "skipped", not a crash; init falls through to the manual checklist.
    rl.on("SIGINT", () => finish(""));
  });
}

// Where promptYesNo reads the answer from and prints the question to. In production
// these are left empty so it talks to the real terminal (process.stdin/stdout).
// Tests pass a fake in-memory stream here - the SAME dependency-injection idea the
// settings writers use for file paths - so the consent decision can be checked
// without a human at the keyboard. You should never set these in real code.
export interface PromptIO {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  // Terminal mode = line-editing + Ctrl-C handling. Defaults to "is the input an
  // actual terminal?", which is exactly what process.stdin is in production (so the
  // behavior is unchanged). A fed-in test stream isn't a terminal, so this lands on
  // false there, which is what lets that stream's EOF fire the 'close' handler below.
  // Tests that want to exercise the Ctrl-C path set this to true on purpose.
  terminal?: boolean;
}

// Ask a plain yes/no question and return true ONLY on an explicit yes. The default
// is NO, on purpose: this gates a change to the user's GLOBAL config, so anything
// that isn't a clear "yes" (a bare Enter, Ctrl-C, or a closed/EOF stdin) must mean
// "don't do it." Visible echo here (unlike promptSecret) - there's no secret to hide.
//
// EXPORTED and IO-injectable on purpose: this single line is what authorizes a
// persistent, machine-wide change to ~/.claude/settings.json and ~/.codex/config.toml,
// so its "only y/yes means yes" logic is unit-tested (see test/prompt-yesno.test.ts)
// and must not be allowed to drift silently.
export function promptYesNo(
  promptText: string,
  io: PromptIO = {},
  defaultYes = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    const input = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    // Real terminal in production (process.stdin.isTTY === true); a fed test stream
    // is not a TTY, so this is false there and its EOF fires 'close' below.
    const interactive =
      io.terminal ?? Boolean((input as { isTTY?: boolean }).isTTY);
    const rl = readline.createInterface({
      input,
      output,
      terminal: interactive,
    });

    let settled = false;
    // `fromKeypress` is true only for an answer typed at the prompt (a bare Enter included).
    // EOF/SIGINT pass false so a piped or non-interactive run can never read as an accidental yes.
    const finish = (answer: string, fromKeypress: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === "") {
        // Bare Enter: an interactive prompt takes the stated default (so [Y/n] -> yes).
        // EOF/SIGINT/non-interactive stays NO so nothing wires up without a real keypress.
        resolve(fromKeypress && interactive ? defaultYes : false);
        return;
      }
      // Any typed answer: only "y" / "yes" is yes; everything else is no.
      resolve(normalized === "y" || normalized === "yes");
    };

    const { lead, prompt } = splitLeadingNewlines(promptText);
    if (lead) output.write(lead);
    rl.question(prompt, (answer) => finish(answer, true));
    // Ctrl-C and closed/EOF stdin both = "no" (the safe default), never an accidental yes.
    rl.on("SIGINT", () => finish("", false));
    rl.on("close", () => finish("", false));
  });
}

// Ask a plain, VISIBLE free-text question and return the typed answer, trimmed.
// Unlike promptSecret this does NOT mask keystrokes - there's no secret here, only an
// email - and unlike promptYesNo it returns the raw text, not a yes/no.
//
// THE THREE-WAY UX the per-developer prompt needs (Enter = default, type = override,
// blank = auto-detect) is achieved by PRE-FILLING the editable line with `defaultValue`
// via rl.write: the user sees it already typed in, so pressing Enter submits the
// default, editing it submits a new value, and clearing it (Ctrl-U / backspace) then
// Enter submits "" - which the caller treats as "leave blank / auto-detect." An EOF or
// Ctrl-C also resolves to "" (the safe "don't override" outcome). Exported + IO-
// injectable for the same reason promptYesNo is: so the behavior is unit-testable.
export function promptVisible(
  promptText: string,
  defaultValue = "",
  io: PromptIO = {},
): Promise<string> {
  return new Promise((resolve) => {
    const input = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    const interactive =
      io.terminal ?? Boolean((input as { isTTY?: boolean }).isTTY);
    const rl = readline.createInterface({
      input,
      output,
      terminal: interactive,
    });

    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer.trim());
    };

    const { lead, prompt } = splitLeadingNewlines(promptText);
    if (lead) output.write(lead);
    rl.question(prompt, (answer) => finish(answer));
    // Pre-fill the line with the default so a bare Enter accepts it; only meaningful on
    // a real terminal (a fed test stream supplies its own answer, so skip it there).
    if (interactive && defaultValue) rl.write(defaultValue);
    // Ctrl-C / EOF both = "" = "don't set an override," never an accidental value.
    rl.on("SIGINT", () => finish(""));
    rl.on("close", () => finish(""));
  });
}

// --- init's screens ----------------------------------------------
//
// THE SHAPE: every question `init` will ask is a numbered step, and the total is
// known BEFORE step 1 prints. Each step is a one-line header, at most four indented
// context lines, the prompt, then one indented line saying what happened. Every run
// ends with a SETUP COMPLETE checklist and then exactly ONE final block - the /hooks
// instruction when Codex still needs a human, otherwise "nothing left to do."
// Nothing prints after that block, so the one action that matters is the last thing
// on screen.
//
// Each step carries a one-line link to the README section that explains it.
type InitStep = "key" | "email" | "cache" | "wiring" | "control" | "finished";

function stepHeader(
  plan: InitStep[],
  step: InitStep,
  question: string,
): string {
  return `Step ${plan.indexOf(step) + 1} of ${plan.length}: ${question}`;
}

// Which coding agents are on this machine decides which global files init may touch.
// A tool that isn't installed gets no file and no mention.
interface AgentsPresent {
  claude: boolean;
  codex: boolean;
}

function wiredFiles(agents: AgentsPresent): string[] {
  return [
    ...(agents.claude ? [CLAUDE_SETTINGS_PATH] : []),
    ...(agents.codex ? [CODEX_CONFIG_PATH] : []),
  ];
}

function agentNames(agents: AgentsPresent): string[] {
  return [
    ...(agents.claude ? ["Claude Code"] : []),
    ...(agents.codex ? ["Codex"] : []),
  ];
}

const NO_AGENTS_FOUND_LINE = `  Neither Claude Code nor Codex was found on this machine, so nothing was wired. Install one, then run ${CCC_COMMAND_INVOCATION} init to meter it.`;
// One line, shared by the init checklist and the status read-back, so both say the
// same thing and both carry the next action.
const CLAUDE_NOT_DETECTED_ROW = `not detected on this machine. Install it, then run ${CCC_COMMAND_INVOCATION} init to meter it.`;

// Step 4's body: the wiring consent. Names every global file it will edit, keeps the
// uninstall promise on screen, and points at the README for the full key-by-key list.
function renderWiringConsent(
  agents: AgentsPresent,
  isRerun: boolean,
): string[] {
  const files = wiredFiles(agents);
  if (files.length === 0) {
    return [
      "  Neither Claude Code nor Codex was found on this machine, so there's nothing to wire yet.",
      isRerun
        ? "  I'll re-check the background helper and change nothing that's already right."
        : "  I'll add a background helper so the meter runs on its own once you install one.",
      `  Undo it all anytime: ${CCC_COMMAND_INVOCATION} uninstall`,
    ];
  }
  const those = files.length > 1 ? "those files" : "that file";
  return [
    isRerun
      ? `  You've run this before. I'll re-check ${files.join(" and ")}`
      : `  I'll edit ${files.join(" and ")}`,
    isRerun
      ? "  and change nothing that's already right."
      : "  to turn on usage reporting, and add a background helper so the meter runs on its own.",
    `  Your secret key never goes in ${those}. Full list: README, "What init changes".`,
    `  Undo it all anytime: ${CCC_COMMAND_INVOCATION} uninstall`,
  ];
}

// Step 5's body: the Spend Control consent. Separate question, never pre-answered,
// because this is the one that turns a meter into something that can stop you.
// test/both-tools-copy-gates.test.ts greps cli.ts for "before Claude Code and Codex tool calls."
function renderControlConsent(): string[] {
  return [
    "  It adds a check that runs before Claude Code and Codex tool calls. When your",
    "  team's cap is hit, it CAN STOP a Claude Code or Codex tool call.",
    "  It fails OPEN: a broken or missing cap file never blocks you.",
    "  Its limits, in plain English:",
    '  packages/code-cost-clarity/README.md, "Spend Control"',
  ];
}

// The --no-prompt line's second sentence: the global files this run edits, named from
// the same presence pair as the change record, so a bare machine's CI log never says
// a Claude or Codex file changed when none did.
function renderNoPromptScope(agents: AgentsPresent): string {
  const files = wiredFiles(agents);
  if (files.length === 0) {
    return `Nothing outside ${CONFIG_DIR} changes on this machine.`;
  }
  return `This WILL change ${files.join(" and ")} as listed above.`;
}

// The record printed when nobody is at the keyboard (--no-prompt, or a non-TTY that
// will auto-decline). No questions fire, so the two consent screens collapse into a
// short list of everything that will change - a CI log still says what happened.
function renderChangeRecord(agents: AgentsPresent, control: boolean): string[] {
  const files = wiredFiles(agents);
  const wiring =
    files.length === 0
      ? [
          "Changes I'll make: a background meter that starts at login. Neither Claude Code",
          "nor Codex was found on this machine, so no coding-agent file is touched. Install",
          `one, then run ${CCC_COMMAND_INVOCATION} init to meter it.`,
        ]
      : [
          `Changes I'll make: usage reporting on in ${files.join(" and ")},`,
          `a background meter that starts at login, and cap-check hooks for ${agentNames(agents).join(" and ")}.`,
          'Full list: README, "What init changes".',
        ];
  return [
    ...wiring,
    ...(control
      ? [
          "Spend Control: the check runs before Claude Code and Codex tool calls, and when",
          "your team's cap is hit it CAN STOP a Claude Code or Codex tool call. It fails OPEN:",
          "a broken or missing cap file never blocks you.",
          "Its limits, in plain English:",
          'packages/code-cost-clarity/README.md, "Spend Control"',
        ]
      : []),
  ];
}

// The four-line read-back every init and every status ends with (uninstall has its
// own). One label per surface, and a not-OK line always carries its own next action.
interface SetupChecklist {
  key: string;
  meter: string;
  claude: string;
  codex: string;
}

function printChecklist(
  log: (message: string) => void,
  headline: string,
  rows: SetupChecklist,
): void {
  log(
    [
      "",
      headline,
      `  Key:         ${rows.key}`,
      `  Meter:       ${rows.meter}`,
      `  Claude Code: ${rows.claude}`,
      `  Codex:       ${rows.codex}`,
    ].join("\n"),
  );
}

// The LAST thing init prints, ever. Either the three clicks Codex still needs, or a
// plain "nothing left". Making this the final statement of cmdInit is what stops the
// one required action from being followed by more text nobody reads.
function printFinalBlock(
  log: (message: string) => void,
  codexNeedsTrust: boolean,
): void {
  log(
    codexNeedsTrust
      ? [
          "",
          "LAST STEP: turn on the Codex cap check.",
          "  1. Open codex (type codex in your terminal and press Enter).",
          "  2. Type /hooks and press Enter.",
          "  3. Pick trust for the MarginFront cap check.",
          `Then check it worked: ${CCC_COMMAND_INVOCATION} status`,
        ].join("\n")
      : [
          "",
          "NOTHING LEFT TO DO.",
          `Check it anytime: ${CCC_COMMAND_INVOCATION} status`,
        ].join("\n"),
  );
}

// --- init -------------------------------------------------------------------
//
// THE INIT FLOW: one command sets everything up, with no `source` and no second
// terminal. The shape is:
//   1. Make the config dir + fetch the collector binary.
//   2. (interactive) Paste your MarginFront SECRET key; we save it to .env (0600).
//   3. BLOCKING CONSENT: we print EXACTLY what we'll change in your GLOBAL config
//      (~/.claude/settings.json + ~/.codex/config.toml) and that Claude telemetry
//      becomes always-on for every session, then require an explicit y/N (default N).
//      `--no-prompt` skips the question and proceeds (the CI / scripted path).
//   4. On yes: write our telemetry vars into settings.json, wire Codex, and
//      install + start the background daemon (only if a key is saved - a keyless
//      daemon would crash-loop, so we hold off and tell the user how to finish).
//   5. Offer to remove a redundant `source ~/.marginfront-ccc/.env` line from
//      ~/.zshrc (never silently - it's the user's file).
//
// Everything the orchestration touches is INJECTABLE (InitDeps) so the consent
// gate, the wiring, and the migration can be unit-tested with spies + temp paths,
// never the real ~/.claude / launchd / a 360 MB download. Real callers (main) omit
// deps and the production defaults run.
// What happened to the Codex half of `init --control`.
//   "wired"         - the hook is in ~/.codex/hooks.json and needs one /hooks approval.
//   "already-wired" - the hook was already there from a previous run.
//   "no-codex"      - Codex isn't on this machine. A normal state, not an error.
//   "skipped"       - Codex is here, but its hooks file wasn't safe to edit.
export type CodexInitOutcome =
  | "wired"
  | "already-wired"
  | "no-codex"
  | "skipped";

// How many pastes the key step accepts before giving up. Three is
// enough to recover from a typo without trapping someone whose key is genuinely
// dead in an endless prompt loop.
const KEY_PASTE_ATTEMPTS = 3;

export interface InitDeps extends FinishedWorkSetupDeps {
  // WHICH SERVER. `apiUrl` is the --api-url flag. The prompt and the write are
  // injectable so the question is testable without a keyboard or the real settings
  // file; stageMeterProgram copies the built program to its stable home.
  apiUrl?: string;
  promptServerUrl?: () => Promise<string>;
  writeServerUrl?: (value: string) => void;
  stageMeterProgram?: () => void;
  // Decides which service manager installs the meter, and which claims the closing
  // copy is allowed to make. (Default: os.platform().)
  platform?: () => string;
  // Setup steps (real ones do disk I/O + a large download - always stubbed in tests).
  ensureConfigFiles?: () => void;
  ensureCollectorBinary?: () => void;
  loadEnv?: () => Record<string, string>;
  // Is stdin an interactive terminal? (Default: process.stdin.isTTY.)
  isTTY?: () => boolean;
  // Key capture.
  promptSecret?: (promptText: string) => Promise<string>;
  writeApiKey?: (value: string) => void;
  // KEY VALIDATION. checkKey asks the server whether a key actually
  // works (default: checkKeyWithServer, two GETs against the live API); injectable
  // so init tests never touch the network. clearAuthHold removes the daemon's
  // auth-hold marker after a validated save (default: the real file).
  checkKey?: (apiKey: string) => Promise<KeyCheckResult>;
  clearAuthHold?: () => void;
  // PER-DEVELOPER ATTRIBUTION (shared coding-agent login). All injectable so the
  // prompt, its git-sourced default, and the .env write are unit-testable without a
  // real keyboard, a real git, or the real ~/.marginfront-ccc/.env.
  //   - gitDefaultEmail(): the value to pre-fill the prompt with (default: global
  //                        git user.email; "" if git is missing or unset).
  //   - promptDeveloperEmail(defaultValue): ask which developer this machine's cost
  //                        belongs to; returns the chosen email, or "" for "leave
  //                        blank / auto-detect from the login."
  //   - writeDeveloperEmail(value): persist it as CCC_DEVELOPER_EMAIL in the .env.
  gitDefaultEmail?: () => string;
  promptDeveloperEmail?: (defaultValue: string) => Promise<string>;
  writeDeveloperEmail?: (value: string) => void;
  // CACHE-WRITE TTL: detect-or-ask which prompt-cache write rate
  // this machine gets billed at. Injectable so the detection (env vars +
  // settings.json), the one-question fallback, and the .env write are
  // unit-testable without a real ~/.claude or keyboard.
  detectCacheTtl?: () => CacheWriteTtl | null;
  promptCacheTtl?: () => Promise<string>;
  writeCacheTtl?: (value: CacheWriteTtl) => void;
  // "Is a usable key saved?" - gates the daemon install so we never create a
  // keyless crash-loop. Default: whether we saw / just saved one.
  hasApiKey?: () => boolean;
  // BLOCKING CONSENT - returns true only on an explicit yes. (Default: ask y/N.)
  // TWO consents: wiring first, then Spend Control on a --control
  // run. Neither is pre-answered, and --no-prompt auto-consents both.
  promptConsent?: () => Promise<boolean>;
  promptControlConsent?: () => Promise<boolean>;
  // Is Codex on this machine? Gates every Codex line AND the ~/.codex/config.toml
  // write - a machine with no Codex gets no Codex file and no Codex narration.
  codexInstalled?: () => boolean;
  // Is Claude Code on this machine? The symmetric gate: no ~/.claude/settings.json
  // write, no cache-pricing question, and no Claude cap hook on a Codex-only machine.
  claudeInstalled?: () => boolean;
  // Global-config writers (the things consent gates).
  writeClaudeTelemetry?: () => WriteClaudeSettingsResult;
  writeCodexConfig?: () => WriteCodexConfigResult;
  codexHasCccBlock?: () => boolean;
  // Returns InstallDaemonResult in production; typed loose so a test spy can be a
  // bare `() => {}`. Only `reloaded` is read, to say "installed" vs "reloaded".
  installDaemon?: () => unknown;
  // Spend Control - only used on the --control path, all injectable so the
  // script write, the settings-hook write, and the first spend pull are unit-testable
  // without a real ~/.claude, a real script on disk, or a real network fetch.
  installControlScript?: () => void;
  // Returns WriteControlHookResult in production; typed loose so a test spy can be a
  // bare arrow. Only `action` is read, to say "installed" vs "already in place".
  installControlHook?: () => unknown;
  // Codex arm. Separate seam from the Claude hook so a test can prove
  // the Codex write is skipped honestly when Codex isn't on the machine. Returns
  // which of the three outcomes happened, because each gets a different closing line.
  installCodexControlHook?: () => CodexInitOutcome;
  syncControl?: () => Promise<void>;
  // Read Codex's trust state ONCE at the end of init, so the final block asks for the
  // /hooks click only when it is genuinely still needed. Injectable so a test never
  // spawns the real Codex app-server.
  resolveCodexTrust?: () => Promise<CodexControlStatus>;
  // Redundant ~/.zshrc source-line cleanup.
  findZshrcLines?: () => ZshrcSourceLineResult;
  promptRemoveZshrc?: () => Promise<boolean>;
  removeZshrcLines?: () => void;
  // Output sinks.
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

// `init` never rewrites a settings file that already exists, so a file can carry
// CCC_MATTER_ID and no CCC_WORK_ID line anywhere. Naming CCC_WORK_ID to that user
// would send them after a line they have not got.
export function workIdInitStep(workId: WorkId): string {
  const key = workId.key ?? WORK_ID_ENV_KEY;
  return [
    "",
    `OPTIONAL: put this machine's spend on a ${WORK_ITEM_NOUN}.`,
    ...(key === MATTER_NUMBER_ENV_KEY
      ? [
          `${MATTER_NUMBER_ENV_KEY} is the key in effect on this machine, and it keeps working.`,
          `${WORK_ID_ENV_KEY} is the newer name for the same line, and it works too.`,
        ]
      : []),
    `  1. Pick a short name for the ${WORK_ITEM_NOUN_PLAIN}: a ticket number, or plain words.`,
    `  2. Put that name after ${key}= in ${ENV_PATH} and save, or run ${CCC_COMMAND_INVOCATION} work "<name>" in your terminal.`,
    "Everything this machine sends from then on carries that name, so its AI spend adds up under it.",
    "Nothing to restart.",
  ].join("\n");
}

// How many typed addresses the server question accepts before giving up.
const SERVER_URL_ATTEMPTS = 3;

// Copies the built program to ~/.marginfront-ccc/cli.js on every platform, so the
// one command spelling this package prints works the same everywhere. The
// background-meter install repeats the copy on macOS and Windows and is the loud
// failure there; here a failure only costs the short command.
function stageMeterProgram(log: (message: string) => void): void {
  try {
    stageDaemonCli({
      sourceCliPath: fileURLToPath(import.meta.url),
      daemonCliPath: DAEMON_CLI_PATH,
      nodePath: process.execPath,
      log: () => {},
    });
  } catch (err) {
    log(
      [
        `HEADS UP: the meter program was not copied to ${DAEMON_CLI_PATH}.`,
        `What happened: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        `What it means: the commands printed below start with ${CCC_COMMAND_INVOCATION}, which is that copy.`,
        "Fix: build this package, then run the built program from the root of your",
        `  MarginFront source checkout: ${CCC_SOURCE_INIT_COMMAND}`,
      ].join("\n"),
    );
  }
}

// Settle which server this machine sends to before init makes its first request.
// Order: the --api-url flag, then what is already saved or exported, then one
// question. A valid answer is saved to the settings file and put in this process's
// environment, which is where every send reads it from. Returns false when init
// has to stop: there is no built-in address to fall back to.
async function settleServerUrl({
  flag,
  savedEnv,
  interactive,
  ask,
  save,
  log,
  errorLog,
}: {
  flag: string | undefined;
  savedEnv: Record<string, string>;
  interactive: boolean;
  ask: () => Promise<string>;
  save: (value: string) => void;
  log: (message: string) => void;
  errorLog: (message: string) => void;
}): Promise<boolean> {
  const env: Record<string, string | undefined> = {
    [SERVER_URL_SETTING]:
      process.env[SERVER_URL_SETTING] ?? savedEnv[SERVER_URL_SETTING],
    [INSECURE_HTTP_SETTING]:
      process.env[INSECURE_HTTP_SETTING] ?? savedEnv[INSECURE_HTTP_SETTING],
    MARGINFRONT_INGEST_URL:
      process.env.MARGINFRONT_INGEST_URL ?? savedEnv["MARGINFRONT_INGEST_URL"],
  };
  // The background meter never sees this shell: it reads the settings file only.
  // An address that passes here on a shell-only opt-in would be refused there.
  const usableByBackgroundMeter = (baseUrl: string): boolean =>
    resolveConfiguredServer(
      { [INSECURE_HTTP_SETTING]: savedEnv[INSECURE_HTTP_SETTING] },
      baseUrl,
    ).ok;
  const adopt = (baseUrl: string, persist: boolean): boolean => {
    if (!usableByBackgroundMeter(baseUrl)) {
      errorLog(
        [
          `Setup stopped: ${baseUrl} is plain http to another machine, and the switch that allows it (${INSECURE_HTTP_SETTING}) is set only in this terminal.`,
          "Why: the background meter does not read your terminal's settings, so it would refuse this address and count nothing.",
          `Fix: open ${ENV_PATH}, set ${INSECURE_HTTP_SETTING}=1 there, then run init again. Your key then travels unencrypted to that machine; use an https address if you can.`,
        ].join("\n"),
      );
      return false;
    }
    if (persist) save(baseUrl);
    process.env[SERVER_URL_SETTING] = baseUrl;
    return true;
  };

  if (flag !== undefined) {
    const fromFlag = resolveConfiguredServer(env, flag);
    if (!fromFlag.ok) {
      errorLog(
        `Setup stopped: the address given to --api-url can't be used. ${fromFlag.problem.replace(/\bSet MARGINFRONT_API_URL\b/, "Pass --api-url")}`,
      );
      return false;
    }
    if (!adopt(fromFlag.baseUrl, true)) return false;
    log(`MarginFront server: ${fromFlag.baseUrl} (saved to ${ENV_PATH}).`);
    return true;
  }

  const existing = resolveConfiguredServer(env);
  if (existing.ok) {
    const alreadySaved =
      (savedEnv[SERVER_URL_SETTING] ?? "").trim() === existing.baseUrl;
    if (!adopt(existing.baseUrl, !alreadySaved)) return false;
    if (!alreadySaved) {
      log(`MarginFront server: ${existing.baseUrl} (saved to ${ENV_PATH}).`);
    }
    return true;
  }

  if (!interactive) {
    errorLog(
      [
        "Setup stopped before downloading or changing anything else.",
        existing.problem,
        `Fix: run init again with your server's address:  ${CCC_SOURCE_INIT_COMMAND} --api-url https://billing.example.com/v1`,
      ].join("\n"),
    );
    return false;
  }

  log(
    [
      "",
      "First: which MarginFront server should this machine send to?",
      "  This meter has no built-in server. It sends your usage and your key only",
      "  to the address you give here.",
      "  It is your MarginFront API address, ending in /v1.",
      "  Example: https://billing.example.com/v1  (or http://localhost:4000/v1)",
      ...(env[SERVER_URL_SETTING]
        ? [`  The saved address can't be used: ${existing.problem}`]
        : []),
    ].join("\n"),
  );
  for (let attempt = 1; attempt <= SERVER_URL_ATTEMPTS; attempt++) {
    const typed = (await ask()).trim();
    if (!typed) {
      errorLog(
        `Setup stopped: no server address, so there is nowhere to send to. Run init again when you have it.`,
      );
      return false;
    }
    const answer = resolveConfiguredServer(env, typed);
    if (answer.ok) {
      if (!adopt(answer.baseUrl, true)) return false;
      log(`  Saved. This machine sends to ${answer.baseUrl}.`);
      return true;
    }
    log(`  That address can't be used. ${answer.problem}`);
  }
  errorLog(
    `Setup stopped after ${SERVER_URL_ATTEMPTS} tries with no usable server address. Nothing else was changed.`,
  );
  return false;
}

export async function cmdInit(
  noPrompt: boolean,
  control: boolean,
  deps: InitDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const hostPlatform = deps.platform ?? platform;

  const isTTY = deps.isTTY ?? (() => Boolean(process.stdin.isTTY));
  const ensureConfig = deps.ensureConfigFiles ?? (() => ensureConfigFiles());
  const ensureBinary =
    deps.ensureCollectorBinary ?? (() => ensureCollectorBinary());
  const loadEnv = deps.loadEnv ?? (() => loadEnvFile());
  const askSecret = deps.promptSecret ?? promptSecret;
  const saveKey =
    deps.writeApiKey ?? ((value: string) => writeApiKeyToEnv(value));
  const checkKey =
    deps.checkKey ?? ((key: string) => checkKeyWithServer({ apiKey: key }));
  const clearHold =
    deps.clearAuthHold ?? (() => clearAuthHold(FORWARDER_AUTH_HOLD_PATH));
  const codexPresent = (deps.codexInstalled ?? (() => isCodexInstalled()))();
  const claudePresent = (
    deps.claudeInstalled ?? (() => isClaudeCodeInstalled())
  )();
  const agents: AgentsPresent = { claude: claudePresent, codex: codexPresent };

  ensureConfig();

  const env = loadEnv();
  const savedKey = env["MARGINFRONT_API_KEY"];
  const savedCacheTtl = env["CCC_CACHE_WRITE_TTL"];
  const interactive = !noPrompt && isTTY();

  const saveServerUrl =
    deps.writeServerUrl ?? ((value: string) => writeServerUrlToEnv(value));
  const serverUrlBeforeThisRun = env[SERVER_URL_SETTING] ?? "";
  let serverUrlSavedThisRun = false;

  // WHICH SERVER comes before everything else: the saved-key check just below is
  // already a request, and there is no built-in address to send it to.
  const serverReady = await settleServerUrl({
    flag: deps.apiUrl,
    savedEnv: env,
    interactive,
    ask:
      deps.promptServerUrl ??
      (() =>
        promptVisible(
          "Your MarginFront server's API address (Enter to stop): ",
          "",
        )),
    save: (value: string) => {
      serverUrlSavedThisRun = true;
      saveServerUrl(value);
    },
    log,
    errorLog,
  });
  if (!serverReady) return 1;

  // A 404 from the key check means the address answered but is not a MarginFront
  // API. Keeping it would leave the background meter posting to a dead path, so
  // put back whatever was saved before this run and stop.
  const stopForWrongAddress = (wrongUrl: string): number => {
    if (serverUrlSavedThisRun) saveServerUrl(serverUrlBeforeThisRun);
    errorLog(
      [
        `Setup stopped: ${wrongUrl} answered, but it is not a MarginFront API address (its /verify path returned HTTP 404).`,
        "Why: the address is usually missing the /v1 at the end, or points at the dashboard instead of the API.",
        serverUrlSavedThisRun
          ? "That address was not kept, and no key was saved or changed."
          : `That address is the one saved in ${ENV_PATH}. No key was saved or changed.`,
        `Fix: run init again with your API address, ending in /v1:  ${CCC_SOURCE_INIT_COMMAND} --api-url https://billing.example.com/v1`,
      ].join("\n"),
    );
    return 1;
  };

  ensureBinary();
  (deps.stageMeterProgram ?? (() => stageMeterProgram(log)))();

  // Cache-write detection has to run BEFORE the step plan: it decides whether the
  // pricing question fires at all, and the plan's total has to be right before
  // Step 1 prints. A saved answer is never re-detected and never re-asked.
  const detectTtl = deps.detectCacheTtl ?? (() => detectCacheWriteTtl());
  const writeTtl =
    deps.writeCacheTtl ??
    ((value: CacheWriteTtl) => writeCacheWriteTtlToEnv(value));
  const detectedTtl = savedCacheTtl ? null : detectTtl();

  // Validate the SAVED key up front. The key step below is skipped
  // entirely when a key is on disk, so without this pre-plan check a re-init over
  // a dead key would breeze past the one thing that needs fixing. Only an
  // authoritative server "no" re-opens the step; an unreachable server changes
  // nothing, so setup stays usable offline.
  let savedKeyRejected = false;
  let savedKeyProblem = "";
  if (savedKey) {
    // One line before a call that can take several seconds on a bad network, so
    // init never looks hung at its very first step.
    log("Checking your saved key with MarginFront...");
    const savedKeyCheck = await checkKey(savedKey);
    if (!savedKeyCheck.ok && savedKeyCheck.reason === "wrong-address") {
      return stopForWrongAddress(savedKeyCheck.serverUrl);
    }
    if (!savedKeyCheck.ok && savedKeyCheck.reason === "rejected") {
      savedKeyRejected = true;
      savedKeyProblem = `MarginFront rejected it (HTTP ${savedKeyCheck.status}), so nothing can be sent with it`;
    } else if (!savedKeyCheck.ok && savedKeyCheck.reason === "publishable") {
      savedKeyRejected = true;
      savedKeyProblem =
        "it's a PUBLISHABLE key (mf_pk_*), which can never send usage";
    }
  }

  const plan: InitStep[] = [];
  if (interactive && (!savedKey || savedKeyRejected)) plan.push("key");
  if (interactive) plan.push("email");
  // The cache question is about how Claude is paid for; it has no answer without Claude.
  if (interactive && claudePresent && !savedCacheTtl && detectedTtl === null)
    plan.push("cache");
  if (interactive) plan.push("wiring");
  if (interactive && control) plan.push("control");
  if (interactive) plan.push("finished");

  // "Set up before" = both answers already saved AND the key still works. This is
  // the re-run branch, which skips a fresh install's full disclosure. A Codex-only machine never gets the pricing
  // question, so there its saved key alone makes the next run a re-run.
  const isRerun =
    Boolean(savedKey) &&
    (Boolean(savedCacheTtl) || !claudePresent) &&
    !savedKeyRejected;

  log(
    interactive
      ? [
          "MarginFront setup for Claude Code and Codex.",
          isRerun
            ? `Your key${savedCacheTtl ? " and pricing are" : " is"} already saved, so this run has ${plan.length} steps.`
            : `${plan.length} steps. You can stop anytime with Ctrl+C.`,
        ].join("\n")
      : noPrompt
        ? "MarginFront setup for Claude Code and Codex (no-prompt mode, for scripts)."
        : "MarginFront setup for Claude Code and Codex.",
  );

  if (savedKeyRejected) {
    log(
      [
        "",
        `PROBLEM: your saved MarginFront key isn't working: ${savedKeyProblem}.`,
        interactive
          ? "The key step below asks for a working one."
          : "Fix: run init in a terminal and paste a working SECRET key (mf_sk_...).",
      ].join("\n"),
    );
  }

  // The four-line read-back this run will end with. Each step updates its own row as
  // it happens, so the checklist can never drift from what actually ran.
  const rows: SetupChecklist = {
    key: savedKey
      ? savedKeyRejected
        ? "saved, but not working (see PROBLEM above)"
        : "saved"
      : "not saved yet",
    meter: "not installed",
    claude: claudePresent ? "usage reporting off" : CLAUDE_NOT_DETECTED_ROW,
    codex: codexPresent
      ? "usage reporting off"
      : "not found on this machine, nothing to do",
  };

  // --- Step: the secret key (interactive; when none is saved, or the saved one
  // failed the pre-plan check) ------------------------------------------------
  // keySaved tracks "is a key present after this step?" - true if one was already
  // on disk OR we just saved one. It feeds the daemon-install decision below
  // (presence, not validity: a daemon with a dead key holds safely).
  //
  // Every paste is validated against the server before it is saved - the server
  // call is the gate, not a prefix heuristic, so a pasted Anthropic/OpenAI key or
  // a truncated paste is caught here instead of failing silently forever. When the
  // server can't be reached there is no verdict, so the key saves anyway with an
  // honest line (setup must work on a plane) and only then does the
  // publishable-prefix warning fire as the one remaining guard.
  let keySaved = Boolean(savedKey);
  if (plan.includes("key")) {
    log(
      [
        "",
        stepHeader(plan, "key", "paste your MarginFront secret key."),
        "  Get it here: your MarginFront dashboard, then Build, then API keys (Create key pair).",
        "  Use the SECRET key. It starts with mf_sk_.",
        "  Don't paste an Anthropic or OpenAI key here.",
      ].join("\n"),
    );
    let promptText =
      "Paste your MarginFront SECRET key (mf_sk_*) - not your Anthropic/OpenAI key (Enter to skip): ";
    for (let attempt = 1; attempt <= KEY_PASTE_ATTEMPTS; attempt++) {
      let entered = await askSecret(promptText);
      if (!entered) {
        log("  No key saved. Run init again whenever you have one.");
        break;
      }
      const verdict = await checkKey(entered);
      if (!verdict.ok && verdict.reason === "wrong-address") {
        return stopForWrongAddress(verdict.serverUrl);
      }
      if (!verdict.ok && verdict.reason === "rejected") {
        log(
          `  That key didn't work: MarginFront rejected it (HTTP ${verdict.status}).\n` +
            "  It's probably not a MarginFront secret key, or it was revoked or cut\n" +
            "  short in the paste.",
        );
        if (attempt === KEY_PASTE_ATTEMPTS) {
          log(
            `  Nothing was saved after ${KEY_PASTE_ATTEMPTS} tries. Get a fresh SECRET key (mf_sk_...)\n` +
              "  from the address above, then run init again.",
          );
          break;
        }
        promptText =
          "Try again - paste your MarginFront SECRET key (mf_sk_*) (Enter to skip): ";
        continue;
      }
      if (!verdict.ok && verdict.reason === "publishable") {
        log(
          `  That's a PUBLISHABLE key (mf_pk_*) for ${verdict.organizationName}. It can\n` +
            "  never send usage, so the meter can't use it. Paste the SECRET key (mf_sk_*)\n" +
            "  from the same key pair.",
        );
        if (attempt === KEY_PASTE_ATTEMPTS) {
          log(
            `  Nothing was saved after ${KEY_PASTE_ATTEMPTS} tries. Get the SECRET key (mf_sk_...)\n` +
              "  from the address above, then run init again.",
          );
          break;
        }
        promptText =
          "Try again - paste your MarginFront SECRET key (mf_sk_*) (Enter to skip): ";
        continue;
      }
      if (!verdict.ok) {
        // No verdict (network problem, server outage): fall back to the soft prefix
        // warning, then save.
        if (entered.startsWith("mf_pk_")) {
          log(
            "  Heads up: that looks like a PUBLISHABLE key (mf_pk_*). The forwarder POSTs your\n" +
              "  usage, and publishable keys are rejected on writes - you want a SECRET key (mf_sk_*).",
          );
          const retry = await askSecret(
            "Paste your SECRET key (mf_sk_*), or press Enter to keep what you typed: ",
          );
          if (retry) entered = retry;
        }
        saveKey(entered);
        clearHold();
        // Confirm by location, never by value - the key itself is never printed.
        log(
          "  Saved, but I couldn't reach MarginFront to check the key, so it's saved\n" +
            "  as-is. If it turns out not to work, `status` says so and no usage is lost.\n" +
            `  Your key is in ${ENV_PATH}, a file only you can read.`,
        );
        keySaved = true;
        rows.key = "saved";
        break;
      }
      // The server vouched for the key. Echoing the org name is also the
      // wrong-org tripwire: a valid key for the wrong workspace reads back as a
      // name the user doesn't expect. Clearing the hold file matters because the
      // daemon (re)installed below is a fresh process that reads it at startup - a
      // running daemon never re-reads it.
      saveKey(entered);
      clearHold();
      log(
        `  Saved. Connected to ${verdict.organizationName}.\n` +
          `  Your key is in ${ENV_PATH}, a file only you can read.`,
      );
      keySaved = true;
      rows.key = "saved";
      break;
    }
  }

  // --- Step: per-developer attribution (shared coding-agent login) -----------
  // WHY THIS QUESTION EXISTS: many teams share ONE Claude/Codex login, so every
  // developer's telemetry carries the SAME login email and all the AI cost collapses
  // onto one person. The meter runs locally on each laptop, so asking here - once, per
  // machine - restores per-developer cost visibility. The full explanation lives on
  // the docs page the step links to.
  if (plan.includes("email")) {
    // Pre-fill with the developer's saved choice (a re-run), else the global git
    // email. Either may be "" - then the prompt starts blank.
    const gitDefault = (deps.gitDefaultEmail ?? (() => gitGlobalUserEmail()))();
    const defaultEmail = env["CCC_DEVELOPER_EMAIL"] || gitDefault;
    log(
      [
        "",
        stepHeader(plan, "email", "whose AI spending is this computer's?"),
        "  Press Enter to keep the email shown, type a different one, or clear it",
        "  to auto-detect from your coding-agent login.",
        "  Why this matters:",
        '  packages/code-cost-clarity/README.md, "Sharing one login across the team"',
      ].join("\n"),
    );
    const askDeveloper =
      deps.promptDeveloperEmail ??
      ((defaultValue: string) =>
        promptVisible(
          "Developer email for this machine's AI cost: ",
          defaultValue,
        ));
    const chosenEmail = (await askDeveloper(defaultEmail)).trim();
    const writeDeveloper =
      deps.writeDeveloperEmail ??
      ((value: string) => writeDeveloperEmailToEnv(value));
    // Always write the chosen value - a blank overwrites any prior value to empty,
    // which the forwarder treats as "unset" (auto-detect).
    writeDeveloper(chosenEmail);
    log(
      chosenEmail
        ? `  Got it. This machine's AI cost goes to ${chosenEmail}.`
        : "  Got it. This machine's AI cost follows the coding-agent login.",
    );
  }

  // --- cache-write TTL (5m vs 1h) - honest cache-write pricing ---
  // Anthropic bills prompt-cache WRITES at 1.25x input (5-minute cache: API key /
  // Bedrock / Vertex) or 2x input (1-hour cache: Claude subscriptions), and the
  // server can't see which one a machine runs. Saved answer wins, then detection,
  // and only an ambiguous machine gets the question. Unknown keeps the 2x ceiling.
  if (savedCacheTtl) {
    log(
      `  Kept your saved cache setting: the ${
        savedCacheTtl === "5m" ? "5-minute" : "1-hour"
      } rate.`,
    );
  } else if (detectedTtl === "5m") {
    writeTtl("5m");
    log(
      "  Detected FORCE_PROMPT_CACHING_5M: this machine uses the 5-minute cache, so\n" +
        "  cache writes price at 1.25x input. Saved, no question needed.",
    );
  } else if (detectedTtl === "1h") {
    writeTtl("1h");
    log(
      "  Detected ENABLE_PROMPT_CACHING_1H: this machine uses the 1-hour cache, so\n" +
        "  cache writes price at 2x input. Saved, no question needed.",
    );
  } else if (plan.includes("cache")) {
    log(
      [
        "",
        stepHeader(plan, "cache", "how do you sign in to Claude?"),
        "  This picks the right price for cache writes (Claude saving your prompt for reuse).",
        "  1) A Claude subscription (Pro, Max, or Team)",
        "  2) An API key, Bedrock, or Vertex",
        "  3) Not sure (safe choice, never under-counts)",
      ].join("\n"),
    );
    const askTtl =
      deps.promptCacheTtl ??
      (() =>
        promptVisible("Type 1, 2, or 3 and press Enter (Enter = 3): ", ""));
    // Only an explicit "2" means 5m - every other answer (1, 3, blank, typo)
    // takes the ceiling, because a wrong 5m answer would UNDER-count.
    const ttlAnswer = (await askTtl()).trim();
    const chosenTtl: CacheWriteTtl = ttlAnswer === "2" ? "5m" : "1h";
    writeTtl(chosenTtl);
    log(
      [
        chosenTtl === "5m"
          ? "  Saved the 5-minute cache rate, priced at 1.25x input."
          : "  Saved the 1-hour cache rate. It never under-counts.",
        '  Why: packages/code-cost-clarity/README.md, "Cache pricing"',
      ].join("\n"),
    );
  }
  // No TTY / --no-prompt and nothing detected: leave it unset - the server keeps
  // the 1h ceiling, and a later interactive `init` re-run will ask.

  // --- Step: BLOCKING CONSENT before we touch any GLOBAL config --------------
  // Two questions: wiring, then Spend Control. Each is short enough to
  // read, and neither is pre-answered. --no-prompt and a non-TTY see the same list of
  // changes as a printed record, so even an unattended run leaves one.
  let consented: boolean;
  if (plan.includes("wiring")) {
    log("");
    log(
      [
        stepHeader(plan, "wiring", "OK to wire it up?"),
        ...renderWiringConsent(agents, isRerun),
      ].join("\n"),
    );
    const askConsent =
      deps.promptConsent ??
      (() =>
        promptYesNo(
          "\nWire it up now? Press Enter for yes, or type n to cancel. [Y/n] ",
          {},
          true,
        ));
    consented = await askConsent();
  } else {
    log("");
    log(renderChangeRecord(agents, control).join("\n"));
    if (noPrompt) {
      // CI / scripted installs: --no-prompt skips the question AND proceeds.
      log(
        "--no-prompt set: proceeding without asking (CI / scripted install). " +
          renderNoPromptScope(agents),
      );
      consented = true;
    } else {
      // No TTY and no --no-prompt: we can't get explicit consent, so default to NO
      // and leave every global file untouched.
      consented = false;
    }
  }

  if (!consented) {
    log(
      [
        "",
        "No problem - I did NOT change ~/.claude/settings.json or ~/.codex/config.toml,",
        "and I did NOT install the background helper. Nothing outside ~/.marginfront-ccc",
        "was touched.",
        "",
        "Recommended: re-run `init` and answer 'y' so the meter wires itself up and",
        "runs on its own - no source, no second terminal.",
        "",
        "Fallback (only because you declined the auto-wiring): with no background helper,",
        "you can still run it by hand, one terminal at a time:",
        "  1. source ~/.marginfront-ccc/.env",
        "  2. claude            (or codex)",
        "  3. in another terminal:  node ~/.marginfront-ccc/cli.js run",
      ].join("\n"),
    );
    return 0;
  }

  // --- consented: wire the GLOBAL config -------------------------------------
  // ONE STEP, ONE OUTCOME. This whole block runs on the wiring answer and BEFORE the
  // Spend Control question is asked, so the developer reads what their answer did
  // while it's still the thing they answered. Batching every outcome behind the last
  // consent would make an answered question look like it did nothing.
  //
  // cmdInit is the single narrator from here down. The writers keep their own
  // detailed log lines for direct callers and their unit tests, but here their output
  // is captured so the ordering of what the developer reads is enforceable in ONE
  // place, which keeps the /hooks instruction last.
  const capture: (message: string) => void = () => {};

  // Did this run change something a running Claude or Codex already read at startup?
  // That decides the closing headline: only those changes need "quit and reopen".
  // Saved answers never make it true, and neither does check-cap.py, which is re-read
  // on every tool call.
  let installedSomething = false;

  // 1) Claude Code telemetry into ~/.claude/settings.json (CLI + Desktop), and ONLY
  //    when Claude Code is actually on this machine: a Codex-only laptop gets no
  //    ~/.claude file it never asked for.
  if (claudePresent) {
    const writeClaude =
      deps.writeClaudeTelemetry ??
      (() =>
        writeClaudeTelemetrySettings(CCC_TELEMETRY_VALUES, { log: capture }));
    const claudeResult = writeClaude();
    if (claudeResult.changed === false) {
      log("  Claude Code: already wired. Nothing to change.");
    } else {
      log(
        `  Claude Code: usage reporting is on (${claudeResult.written.length} settings in ${CLAUDE_SETTINGS_PATH}).`,
      );
      installedSomething = true;
    }
    rows.claude = "usage reporting on";
    // The one genuinely useful detail from the writer: settings we LEFT ALONE because
    // the user had already set them to something else.
    if (claudeResult.skipped.length > 0) {
      log(
        `  Left ${claudeResult.skipped.length} Claude setting(s) you'd already set untouched.`,
      );
    }
  } else if (!codexPresent) {
    log(NO_AGENTS_FOUND_LINE);
  }

  // 2) Codex telemetry into ~/.codex/config.toml - conservatively, and ONLY when
  //    Codex is actually on this machine (a Claude-only laptop
  //    gets no ~/.codex file it never asked for). If the user has their OWN [otel]
  //    we don't rewrite it; we hand them the block to paste.
  if (codexPresent) {
    const writeCodex =
      deps.writeCodexConfig ?? (() => writeCodexOtelConfig({ log: capture }));
    const codexHasBlock =
      deps.codexHasCccBlock ?? (() => codexConfigHasCccBlock());
    const codexResult = writeCodex();
    if (codexResult.action === "skipped-existing" && !codexHasBlock()) {
      log(
        [
          `  HEADS UP: ${CODEX_CONFIG_PATH} already has your own [otel] settings.`,
          "  What happened: I left that file alone.",
          "  Why: rewriting settings you wrote could break them.",
          `  Fix: copy this block to the end of ${CODEX_CONFIG_PATH}, then run status.`,
          ...CODEX_OTEL_TOML_BLOCK.split("\n").map(
            (line: string) => `      ${line}`,
          ),
          "  More on Codex capture:",
          '  packages/code-cost-clarity/README.md, "Also capture Codex"',
        ].join("\n"),
      );
      rows.codex = "usage capture needs your paste (see HEADS UP above)";
    } else if (codexResult.action === "skipped-existing") {
      log("  Codex: already wired. Nothing to change.");
      rows.codex = "usage reporting on";
    } else {
      log(`  Codex: reports to the same meter now (${CODEX_CONFIG_PATH}).`);
      rows.codex = "usage reporting on";
      installedSomething = true;
    }
  }

  // 3) Install + start the background daemon - but ONLY with a saved key. A daemon
  //    with no key would exit instantly and launchd's KeepAlive would respawn it
  //    forever (an invisible crash-loop). So if there's no key yet, we hold off and
  //    tell the user the one step left.
  const keyIsPresent = (deps.hasApiKey ?? (() => keySaved))();
  if (keyIsPresent) {
    const install =
      deps.installDaemon ??
      (() => selectServiceManager(hostPlatform()).install({ log: capture }));
    // There is no background meter on Linux or WSL, so this throws for every Linux
    // user with a key saved. Guarded so init still finishes after the telemetry
    // wiring has landed.
    let daemonResult: unknown;
    let daemonError: unknown;
    try {
      daemonResult = install();
    } catch (err) {
      daemonError = err;
    }
    if (daemonError) {
      const detail =
        daemonError instanceof Error
          ? daemonError.message
          : String(daemonError);
      log(
        [
          "  HEADS UP: the background meter didn't install. Everything above is done.",
          `  What happened: ${detail}`,
          "  Why: the background meter is a macOS LaunchAgent or a Windows scheduled",
          "  task. Linux and WSL have neither, so this step always fails there. On",
          "  macOS or Windows it means the OS refused, and the line above is its reason.",
          "  Your key is saved. Nothing you pasted was lost.",
          "  Fix: 1. Meter your spend in a terminal instead, and leave it open while",
          `          you code:  ${CCC_COMMAND_INVOCATION} run`,
          "          Usage that happens while that terminal is closed is lost, not",
          "          buffered.",
          "       2. On macOS or Windows, read the line above and retry:",
          `          ${CCC_COMMAND_INVOCATION} start`,
          "       3. On Linux or WSL, there's no background meter to install. See",
          '          packages/code-cost-clarity/README.md, "Platforms"',
          `  If a file turned up at ${PLIST_PATH} on Linux or WSL, it does nothing`,
          "  there and is safe to delete.",
        ].join("\n"),
      );
      rows.meter = "not installed, run it in a terminal (see above)";
    } else {
      const reloaded =
        typeof daemonResult === "object" &&
        daemonResult !== null &&
        (daemonResult as { reloaded?: boolean }).reloaded === true;
      log(
        reloaded
          ? "  Meter: reloaded with your latest settings. It starts by itself when you log in."
          : "  Meter: installed and running. It starts by itself when you log in.",
      );
      rows.meter = "running, starts at login";
      if (!reloaded) installedSomething = true;
    }
  } else {
    log(
      [
        "  HEADS UP: I did NOT start the background meter yet.",
        "  What happened: no MarginFront key is saved, and a keyless meter would loop",
        "  doing nothing.",
        `  Fix: 1. Paste your SECRET key (mf_sk_*) after MARGINFRONT_API_KEY= in ${ENV_PATH}`,
        "          (or run init again).",
        `       2. Run: ${CCC_COMMAND_INVOCATION} start`,
      ].join("\n"),
    );
    rows.meter = "not started yet, waiting for your key";
  }

  // --- Step: Spend Control's own consent (--control only) --------------------
  // Asked AFTER the wiring above has reported itself, so each question owns the lines
  // underneath it. Separate question, never pre-answered, because this is the one that
  // turns a meter into something that can stop you.
  let wantsControl = control;
  if (plan.includes("control")) {
    log("");
    log(
      [
        stepHeader(
          plan,
          "control",
          isRerun ? "keep Spend Control on?" : "turn on Spend Control?",
        ),
        ...renderControlConsent(),
      ].join("\n"),
    );
    const askControl =
      deps.promptControlConsent ??
      (() =>
        promptYesNo(
          "\nTurn it on now? Press Enter for yes, or type n to skip. [Y/n] ",
          {},
          true,
        ));
    wantsControl = await askControl();
  }

  // --- Step: count what you FINISH, not only what you spend ---
  // The only optional step, and the only one that writes into a file the customer's
  // assistant reads every session - hence default No on a machine that is off, and
  // hence never in a script.
  if (plan.includes("finished")) {
    log("");
    log(
      [
        stepHeader(plan, "finished", "count finished work too?"),
        "  Today this meter counts what your AI spends. This also counts what you",
        "  finish. Your assistant runs one short command each time, or you do.",
        `  ${roiFinishedWorkPointer("to see what each one cost in AI")}`,
        `  On a yes I add a short note to your assistant's memory file, and ${CCC_COMMAND_INVOCATION} uninstall takes it back out.`,
      ].join("\n"),
    );
    await runFinishedWorkSetup({
      currentFinishedNames: () => env[FINISHED_WORK_NAMES_ENV_KEY],
      ...deps,
      log,
    });
  }

  // 3b) Spend Control, only when it was asked for AND agreed
  //     to: the cap-check script, the Claude PreToolUse hook, the Codex hook, then
  //     the FIRST spend pull so the cap is real before the daemon's next cycle.
  let codexOutcome: CodexInitOutcome = "no-codex";
  let controlInstalled = false;
  let claudeHookFailed = false;
  if (wantsControl) {
    const installScript =
      deps.installControlScript ?? (() => writeControlScript());
    const installHook =
      deps.installControlHook ?? (() => writeControlHook({ log: capture }));
    // The wrapper is written only when Codex is actually here, so a Claude-only
    // machine gets no stray file.
    const installCodexHook =
      deps.installCodexControlHook ??
      ((): CodexInitOutcome => {
        if (!codexPresent) return "no-codex";
        writeCodexCapHookWrapper();
        const result = writeCodexControlHook({
          codexInstalled: true,
          log: capture,
        });
        if (result.action === "added") return "wired";
        if (result.action === "already-present") return "already-wired";
        return "skipped";
      });
    installScript();
    // A malformed ~/.claude/settings.json makes the hook writer throw. Uncaught, it
    // would take the whole run down mid-flight, so the checklist, the zshrc question,
    // and the Codex step would never print. Catch it, say what to do, and let the run
    // finish its contract - still exiting 1 so a script knows it failed.
    let hookResult: unknown;
    try {
      if (claudePresent) hookResult = installHook();
    } catch (hookError) {
      claudeHookFailed = true;
      // The writer's message already names the exact broken entry and where the
      // spare copy landed. We drop its own headline and Fix line so this block has
      // one headline and one numbered fix, in the shape every other deviation uses.
      const detail = (hookError as Error).message
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("Could not update ") && !line.startsWith("Fix: "),
        );
      errorLog(
        [
          `PROBLEM: I couldn't update ${CLAUDE_SETTINGS_PATH}.`,
          ...detail,
          "Why: overwriting it could delete hooks you added yourself.",
          `Fix: 1. Open ${CLAUDE_SETTINGS_PATH} and repair the entry named above.`,
          `     2. Run: ${CCC_COMMAND_INVOCATION} init --control`,
        ].join("\n"),
      );
      rows.claude = "cap check NOT installed (see PROBLEM above)";
      rows.codex = "cap check not attempted, fix the problem first";
    }
    if (!claudeHookFailed) {
      const claudeHookExisted =
        typeof hookResult === "object" &&
        hookResult !== null &&
        (hookResult as { action?: string }).action === "already-present";
      if (!claudePresent) {
        log(
          "  Cap check for Claude Code: not added, Claude Code isn't on this machine. Install it\n" +
            `  later and run: ${CCC_COMMAND_INVOCATION} init --control`,
        );
      } else {
        log(
          claudeHookExisted
            ? "  Cap check for Claude Code: already in place."
            : "  Cap check installed for Claude Code. It arms on your next claude session.",
        );
        rows.claude = claudeHookExisted
          ? "usage reporting on, cap check active"
          : "usage reporting on, cap check arms next session";
        if (!claudeHookExisted) installedSomething = true;
      }
      controlInstalled = true;
      codexOutcome = installCodexHook();
      if (codexOutcome === "wired" || codexOutcome === "already-wired") {
        log(
          codexOutcome === "wired"
            ? "  Cap check installed for Codex. One step left, shown at the end."
            : "  Cap check for Codex: already in place, but not trusted yet.",
        );
        rows.codex =
          "usage reporting on, cap check needs one more step (below)";
        if (codexOutcome === "wired") installedSomething = true;
      } else if (codexOutcome === "skipped") {
        log(
          [
            `  PROBLEM: I couldn't add the Codex cap check to ${CODEX_HOOKS_PATH}.`,
            "  What happened: I left that file alone, so the Codex cap check isn't installed.",
            "  Why: it isn't valid JSON, or its hooks block isn't a shape I can add to.",
            "       The usual cause is a trailing comma or a missing quote.",
            `  Fix: 1. Open ${CODEX_HOOKS_PATH} and repair it.`,
            `       2. Run: ${CCC_COMMAND_INVOCATION} init --control`,
            ...(claudePresent
              ? ["  Your Claude Code cap is on and working."]
              : [
                  "  Nothing else changed. The meter is still running and still counting Codex.",
                ]),
          ].join("\n"),
        );
        rows.codex = "cap check skipped (see PROBLEM above)";
      } else {
        log(
          "  Cap check for Codex: not added, Codex isn't on this machine. Install it\n" +
            `  later and run: ${CCC_COMMAND_INVOCATION} init --control`,
        );
      }
      if (keyIsPresent) {
        const firstPull =
          deps.syncControl ??
          (async () => {
            // Re-read: a key pasted at Step 1 landed on disk after `env` was taken.
            const freshEnv = loadEnv();
            const devEmail = resolveDeveloperOverride(freshEnv);
            const result = await syncControlState({
              apiKey: freshEnv["MARGINFRONT_API_KEY"],
              devEmail,
              log: (message: string) => log(`  ${message}`),
            });
            if (!result.synced) {
              log(
                "  Control is armed, but the first cap pull didn't complete " +
                  `(${result.reason ?? "unknown"}). The background meter will retry on ` +
                  "its own; until then the cap fails open (nothing is blocked).",
              );
            }
          });
        await firstPull();
      }
    }
  }

  // 4) If ~/.zshrc carries a redundant `source ~/.marginfront-ccc/.env` line,
  //    offer to tidy it - never
  //    edit ~/.zshrc silently. This asks BEFORE the checklist so nothing interrupts
  //    the closing read-back.
  const findZshrc = deps.findZshrcLines ?? (() => findCccZshrcSourceLines());
  const zshrc = findZshrc();
  if (zshrc.found) {
    log(
      [
        "",
        "One more thing: your ~/.zshrc has a leftover line from an older setup:",
        ...zshrc.matchedLines.map((line) => `    ${line}`),
        "Telemetry is wired through settings.json, so that line is redundant.",
      ].join("\n"),
    );
    let removeIt = false;
    if (!noPrompt && isTTY()) {
      const askRemove =
        deps.promptRemoveZshrc ??
        (() =>
          promptYesNo(
            "Remove that redundant line from your ~/.zshrc now? [y/N]: ",
          ));
      removeIt = await askRemove();
    }
    if (removeIt) {
      const removeZshrc =
        deps.removeZshrcLines ??
        (() => {
          removeCccZshrcSourceLine({ log });
        });
      removeZshrc();
    } else {
      log(
        "Left your ~/.zshrc as-is - you can delete that line by hand whenever you like.",
      );
    }
  }

  // 5) Resolve Codex's trust state ONCE, before the read-back, so the checklist row
  //    and the final block agree. Ask for the /hooks click only when the hook is
  //    installed and Codex has not trusted it yet. An unreadable state asks anyway:
  //    trusting twice is harmless, missing it leaves Codex uncapped.
  let codexNeedsTrust = false;
  if (
    controlInstalled &&
    (codexOutcome === "wired" || codexOutcome === "already-wired")
  ) {
    const readTrust =
      deps.resolveCodexTrust ??
      (() => resolveCodexControlStatus({ timeoutMs: 3_000 }));
    let trust: CodexControlStatus;
    try {
      trust = await readTrust();
    } catch {
      trust = { state: "unknown", reason: "check-failed" };
    }
    codexNeedsTrust = trust.state !== "armed";
    if (!codexNeedsTrust) {
      rows.codex = "usage reporting on, cap check active";
    }
  }

  // 6) The closing read-back. On the crashed-hook path it is the last thing printed
  //    (no final block: there is no click to ask for until the file is repaired).
  if (claudeHookFailed) {
    printChecklist(log, "SETUP COMPLETE, except one problem (above).", rows);
    return 1;
  }

  // The headline follows what this run DID, not which flags it was given. A run that
  // installed anything has to ask for the relaunch (a running Claude or Codex reads its
  // config at startup, so nothing is counted until it restarts). Only a run that put
  // nothing new on the machine may say everything is still in place.
  // schtasksServiceManager.applyDesktopEnvironment is deliberately a no-op, so telling
  // a Windows user to reopen the desktop app promises counting that never starts.
  const desktopAppsAreMetered = hostPlatform() !== "win32";
  const relaunch = [
    ...(claudePresent ? ["Claude"] : []),
    ...(codexPresent ? ["Codex"] : []),
  ];
  printChecklist(
    log,
    !installedSomething
      ? "SETUP COMPLETE. Everything from before is still in place."
      : relaunch.length === 0
        ? "SETUP COMPLETE."
        : `SETUP COMPLETE. Quit and reopen ${relaunch.join(" and ")}${
            desktopAppsAreMetered
              ? ` (desktop app${relaunch.length > 1 ? "s" : ""} too)`
              : ""
          } so counting starts.`,
    rows,
  );

  // 7) How to put this machine's spend on a work item. Above the final block, which
  //    has to stay the last thing printed - this step is optional, that one is not.
  //    `env` is the settings file, never the shell: name the key that file carries.
  log(workIdInitStep(resolveWorkId(env)));

  // 8) The final block, and nothing after it, ever.
  printFinalBlock(log, codexNeedsTrust);
  return 0;
}

// --- start ------------------------------------------------------------------

// HEALTH CHECK timing: after we load the daemon, briefly poll launchd to
// confirm it's actually RUNNING - `launchctl bootstrap` returning 0 only means
// "loaded", not "healthy". A forwarder that crashes on startup is loaded-then-dead
// within a moment, so we give launchd a beat to bring it up before we judge. ~6
// checks, ~300ms apart (~1.8s worst case) - long enough to catch a healthy start,
// short enough that `start` never feels hung.
const START_HEALTH_ATTEMPTS = 6;
const START_HEALTH_INTERVAL_MS = 300;

// Turn the meter into a background daemon that survives logout/reboot and needs no
// second terminal. The dependencies are injectable ONLY so the crash-loop guard and
// the health check can be unit-tested without touching real launchd or the real
// ~/.marginfront-ccc/.env; every real caller (main) omits them and the production
// defaults run.
export interface StartDeps {
  // Picks the service manager (launchd or schtasks). It is a seam so a macOS or Linux
  // test can drive the real win32 path. (Default: os.platform().)
  platform?: () => string;
  // Replaces the real installDaemon() in tests (a spy that records it was called).
  installDaemon?: () => void;
  // "Is a usable API key present?" Default: load the saved .env, then read the env var.
  hasApiKey?: () => boolean;
  // "Did init already run?" Default: the collector binary + config both exist.
  isSetUp?: () => boolean;
  // Health check - all injectable so the "don't claim success on a dead
  // daemon" logic is testable without real launchd or real sleeping:
  //   - queryStatus(): ask this platform's service manager whether the meter is
  //     actually running (default: the manager's own status call).
  //   - sleep(ms):     wait between checks (default: real setTimeout).
  //   - errLogTail():  the last lines of the forwarder's error log, shown when it
  //                    didn't come up (default: tail DAEMON_STDERR_LOG_PATH).
  queryStatus?: () => DaemonStatus;
  sleep?: (ms: number) => Promise<void>;
  errLogTail?: () => string[];
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export async function cmdStart(deps: StartDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const hostPlatform = deps.platform ?? platform;

  // First, because it is the one refusal no later step can clear: Linux and WSL have no
  // service manager to install into. Unguarded, selecting one throws into main()'s catch,
  // so a documented state would print "Something went wrong" instead of what to do.
  const serviceManager = findServiceManager(hostPlatform());
  if (serviceManager === null) {
    errorLog(unsupportedPlatformMessage(hostPlatform()));
    return 1;
  }

  // CRASH-LOOP GUARD (the important one): the background job runs under launchd with
  // KeepAlive on, so launchd RESPAWNS the forwarder every time it exits. The forwarder
  // exits immediately when there's no API key - so installing the daemon without a key
  // would create an invisible, log-flooding respawn loop the user can't see. Refuse up
  // front and point them at `init` instead. (loadEnvFile pulls a key saved by `init`
  // into this process so a user who ran init but never `source`d still counts as ready.)
  const hasApiKey =
    deps.hasApiKey ??
    (() => {
      loadEnvFile();
      return Boolean(process.env.MARGINFRONT_API_KEY);
    });
  if (!hasApiKey()) {
    errorLog(
      [
        "Can't start the background meter yet - no MarginFront API key is saved.",
        "A background meter with no key can't send anything, so start would report",
        "  success on a meter that does nothing.",
        `Fix: run  ${CCC_COMMAND_INVOCATION} init  and paste your SECRET key (mf_sk_*),`,
        `     or add it after MARGINFRONT_API_KEY= in ${ENV_PATH}, then run start again.`,
      ].join("\n"),
    );
    return 1;
  }

  // Second crash-loop guard: if init never fetched the collector, the forwarder would
  // exit on every launch too. Refuse rather than install a daemon doomed to respawn.
  const isSetUp =
    deps.isSetUp ??
    (() => existsSync(COLLECTOR_BIN_PATH) && existsSync(COLLECTOR_CONFIG_PATH));
  if (!isSetUp()) {
    errorLog(
      `Not set up yet. From the root of your MarginFront source checkout, run  ${CCC_SOURCE_INIT_COMMAND}  first, then start.`,
    );
    return 1;
  }

  // The default wraps the real install so its progress lines flow through our logger;
  // tests inject a spy here instead.
  const install = deps.installDaemon ?? (() => serviceManager.install({ log }));
  install();

  // HEALTH CHECK - DON'T CLAIM SUCCESS ON A DEAD DAEMON. `bootstrap`
  // exiting 0 only means launchd LOADED the job, not that the forwarder is actually
  // up. So poll a few times and only print the happy "running in the background"
  // message once launchd reports it's genuinely running. If it never comes up
  // (e.g. a bad/expired key, or a setup problem), show the tail of its error log so
  // the user can see WHY instead of being told "it's running" while it silently isn't.
  const queryStatus = deps.queryStatus ?? (() => serviceManager.status());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let running = false;
  for (let attempt = 0; attempt < START_HEALTH_ATTEMPTS; attempt++) {
    // Sleep first: right after bootstrap launchd usually hasn't spawned it yet, so
    // an immediate check would almost always read "not running" and waste a turn.
    await sleep(START_HEALTH_INTERVAL_MS);
    if (queryStatus().running) {
      running = true;
      break;
    }
  }

  if (!running) {
    const errLogTail =
      deps.errLogTail ?? (() => readLastLines(DAEMON_STDERR_LOG_PATH, 15));
    errorLog(
      [
        "The background meter was installed, but it isn't running yet.",
        "Your computer loaded the job, but the meter keeps stopping - most often a",
        "  missing or expired MarginFront key (mf_sk_...) or a setup problem it can't fix itself.",
        "Here are the last lines of its error log:",
      ].join("\n"),
    );
    const tail = errLogTail();
    if (tail.length === 0) {
      errorLog(`  (no errors logged yet at ${DAEMON_STDERR_LOG_PATH})`);
    } else {
      for (const line of tail) errorLog(`  ${line}`);
    }
    errorLog(
      [
        "",
        `Check again anytime:  ${CCC_COMMAND_INVOCATION} status`,
        `Re-check your MarginFront key (mf_sk_...) with:  ${CCC_COMMAND_INVOCATION} init  (then run start again)`,
      ].join("\n"),
    );
    return 1;
  }

  log(
    [
      "",
      "The MarginFront cost meter is now running in the background.",
      "  - It starts itself automatically every time you log in.",
      "  - It keeps running after you close this window or reboot.",
      `  - Check on it anytime:  ${CCC_COMMAND_INVOCATION} status`,
      `  - Pause it:             ${CCC_COMMAND_INVOCATION} stop`,
      "",
      "Use Claude Code (and/or Codex) normally - your spend shows up in MarginFront.",
    ].join("\n"),
  );
  return 0;
}

// --- status -----------------------------------------------------------------
// Tell the user, in plain English, whether the background meter is alive - and show
// the last ~15 lines of its output + errors so a stuck user can self-diagnose.
function printDaemonLogTail(
  label: string,
  path: string,
  lines: string[],
  log: (message: string) => void,
): void {
  log("");
  if (lines.length === 0) {
    log(`Recent ${label} (${path}): none yet.`);
    return;
  }
  log(
    `Recent ${label} (last ${lines.length} ${
      lines.length === 1 ? "line" : "lines"
    } of ${path}):`,
  );
  for (const line of lines) log(`  ${line}`);
}

// Injectable so a unit test can drive `status` WITHOUT touching real launchd or
// this machine's real log files. Real callers (main) omit deps.
export interface StatusDeps {
  log?: (message: string) => void;
  // Which OS's background-meter story the copy tells. (Default: os.platform().)
  platform?: () => string;
  queryStatus?: () => DaemonStatus;
  readOutputLog?: () => string[];
  readErrorLog?: () => string[];
  // "Is a usable API key present?" Same resolution as `start`'s guard. Lets the
  // keyless not-loaded state say "waiting for a key", not "broken, run start"
  // (start refuses keyless, so that advice would go nowhere).
  hasApiKey?: () => boolean;
  // Error-log freshness (epoch ms of last write, null = no log) + the clock:
  // together they tell an ESTABLISHED crash-loop apart from one long-ago crash.
  errorLogMtimeMs?: () => number | null;
  now?: () => number;
  // Codex arm. Two seams so a test can drive every state without a
  // real ~/.codex and without spawning the real Codex app-server.
  controlIsArmed?: () => boolean;
  codexControlStatus?: () => Promise<CodexControlStatus>;
  // Read-only surface checks for the checklist rows. Injectable so a test drives
  // every state without a real ~/.claude, a real ~/.codex, or the Codex app-server.
  claudeTelemetryOn?: () => boolean;
  claudeInstalled?: () => boolean;
  codexInstalled?: () => boolean;
  codexCaptureWired?: () => boolean;
  // Auth-hold honesty: the daemon's hold marker, the parked-queue
  // depth, and spent.json's last write time (null = no file). Injectable so a
  // test drives every held state without a real ~/.marginfront-ccc.
  authHold?: () => AuthHoldState | null;
  queueDepth?: () => number;
  capsSpentMtimeMs?: () => number | null;
  // This machine's work item. Injectable so a test drives both
  // sentences without a real ~/.marginfront-ccc/.env.
  workId?: () => WorkId;
  // The names of the things this team finishes, read from the same
  // settings file. Injectable for the same reason workId is.
  finishedWorkNames?: () => string | undefined;
  // Read from the same settings file as workId, and injectable for the same reason.
  ignoredRepos?: () => IgnoredRepos;
}

// The Codex checklist row. Control armed = the five trust states; never armed = the
// capture truth, so `status` always answers "is Codex counted?".
function codexStatusRow(
  armed: boolean,
  trust: CodexControlStatus | null,
  codexPresent: boolean,
  captureWired: boolean,
): string {
  if (armed && trust) {
    switch (trust.state) {
      case "armed":
        return "OK. Cap check trusted. Nothing to do.";
      case "needs-re-trust":
        return "ACTION NEEDED. Open codex, type /hooks, pick trust for the MarginFront cap check.";
      case "hooks-disabled":
        return "ACTION NEEDED. Hooks are turned off inside Codex's own settings. Turn them on, then type /hooks inside codex and pick trust.";
      case "not-installed":
        return `No cap check yet. Want one? Run: ${CCC_COMMAND_INVOCATION} init --control`;
      case "unknown":
        return "CAN'T TELL. I couldn't read Codex's trust state. Detail below.";
    }
  }
  if (!codexPresent) return "Not found on this machine. Nothing to do.";
  if (captureWired) return "OK. Codex usage is being captured.";
  return `ACTION NEEDED. Codex usage isn't being captured. Run: ${CCC_COMMAND_INVOCATION} init`;
}

// "2026-08-26T14:03:22.123Z" -> "2026-08-26 14:03 UTC". The hold file's own ISO
// stamp, trimmed for a checklist row; anything malformed passes through as-is.
function holdSinceForHumans(sinceIso: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sinceIso)) {
    return `${sinceIso.replace("T", " ").slice(0, 16)} UTC`;
  }
  return sinceIso;
}

// Linux and WSL. One checklist row still has to carry all three things: what's true,
// why it matters, and the command that does work.
function noBackgroundMeterRow(platformName: string): string {
  return `There's no background meter on ${platformName} yet. Nothing's counting your spend right now. Meter it in a terminal: ${CCC_COMMAND_INVOCATION} run`;
}

// Capitalised from the one exported noun, so renaming it stays a one-line change.
const WORK_ITEM_LABEL =
  WORK_ITEM_NOUN.charAt(0).toUpperCase() + WORK_ITEM_NOUN.slice(1);

// This may never say "valid" or "matched", and cannot: reading the org's own records
// needs a key role an ingest key is denied, so the meter cannot check the name against
// the page. All it can honestly give is where the customer goes to look.
//
// Spend carrying a work-item name is never a row on the tab, so with counting off
// there is nothing there to send a reader to.
export function workIdStatusLine(
  workId: WorkId,
  finishedWorkCounted: boolean,
): string {
  const whatItDoes = workId.value
    ? `${WORK_ITEM_LABEL}: ${workId.value} (from ${workId.key} in ${ENV_PATH}). Everything this machine sends carries that name, so this machine's AI spend adds up under it.`
    : `${WORK_ITEM_LABEL}: not set. Set ${WORK_ID_ENV_KEY} in ${ENV_PATH}, or run ${CCC_COMMAND_INVOCATION} work "<name>" in your terminal, and this machine's AI spend adds up under that one name.`;
  if (!finishedWorkCounted) return whatItDoes;
  return `${whatItDoes} ${roiFinishedWorkPointer(
    workId.value
      ? "to see what you finished under it and what it cost in AI"
      : "to see what you've finished so far and what it cost in AI",
  )}`;
}

// Quoted: a stray space or a pasted web address is invisible otherwise, and either
// one ignores nothing.
function quoteEntries(entries: string[]): string {
  return entries.map((entry) => `"${entry}"`).join(", ");
}

// A rule that stops spend being counted has to be readable back. The unset wording is
// load-bearing, not filler: a machine sending everything and a machine quietly holding
// a repo back look identical from the outside.
export function ignoreReposStatusLine(ignored: IgnoredRepos): string {
  const named = [...ignored.repos].sort().join(", ");
  // The set is lowercased, so Acme-Corp/Billing reads back as acme-corp/billing. The
  // parenthetical is what stops a customer going back to fix a spelling that was fine.
  const sentences =
    ignored.repos.size > 0
      ? [
          `Ignoring: ${named} (from ${IGNORE_REPOS_ENV_KEY} in ${ENV_PATH}, capitals make no difference). Sessions the meter can't place in a repo are still sent.`,
        ]
      : [
          `Ignoring: no repos. Every repo on this machine is metered. Set ${IGNORE_REPOS_ENV_KEY} in ${ENV_PATH} to keep one off.`,
        ];
  if (ignored.malformed.length > 0) {
    sentences.push(
      `Not owner/repo, so these ignore nothing: ${quoteEntries(ignored.malformed)}. Write each one as owner/repo.`,
    );
  }
  if (ignored.hostPrefixed.length > 0) {
    sentences.push(
      `Check these, they look like a web address came along with the repo name: ${quoteEntries(ignored.hostPrefixed)}. Write the repo on its own, like acme-corp/billing, or it ignores nothing.`,
    );
  }
  return sentences.join(" ");
}

export async function cmdStatus(deps: StatusDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;

  // find, not select: `status` ANSWERS a question, so a platform with no background
  // meter gets "there isn't one here" - not a throw that escapes into main()'s catch.
  // The README tells Linux users to run this command.
  const hostPlatform = deps.platform ?? platform;
  const backend = findServiceManager(hostPlatform());
  const queryStatus =
    deps.queryStatus ?? (backend === null ? null : () => backend.status());
  const status: DaemonStatus = queryStatus
    ? queryStatus()
    : { loaded: false, running: false, pid: null, lastExitCode: null };
  const hasApiKey =
    deps.hasApiKey ??
    (() => {
      loadEnvFile();
      return Boolean(process.env.MARGINFRONT_API_KEY);
    });
  const keyPresent = hasApiKey();

  // Auth-hold honesty: while the daemon holds, the Key row must say
  // the key is broken (presence alone is a lie), the Meter row must not claim
  // capture is flowing to MarginFront, and the parked queue gets its own row.
  const hold = (
    deps.authHold ?? (() => readAuthHold(FORWARDER_AUTH_HOLD_PATH))
  )();
  const queueDepth = (
    deps.queueDepth ?? (() => countQueueRecords(FORWARDER_QUEUE_PATH))
  )();

  // CRASH-LOOP CHECK (a broken cli.js can restart thousands of times silently). launchd's
  // "last exit code" persists across KeepAlive respawns, so nonzero + a freshly
  // written error log = the meter is crashing RIGHT NOW even if a pid shows
  // (KeepAlive keeps handing it a new one). One long-ago crash (stale err log)
  // stays quiet - a recovered meter shouldn't cry wolf.
  const CRASH_FRESH_MS = 10 * 60 * 1000;
  const errorLogMtimeMs =
    deps.errorLogMtimeMs ??
    (() => {
      try {
        return statSync(DAEMON_STDERR_LOG_PATH).mtimeMs;
      } catch {
        return null;
      }
    });
  const now = deps.now ?? (() => Date.now());
  let crashLooping = false;
  if (
    status.loaded &&
    typeof status.lastExitCode === "number" &&
    status.lastExitCode !== 0
  ) {
    const mtime = errorLogMtimeMs();
    const errFresh = mtime !== null && now() - mtime < CRASH_FRESH_MS;
    crashLooping = !status.running || errFresh;
  }

  let meterRow: string;
  if (!queryStatus) {
    meterRow = noBackgroundMeterRow(hostPlatform());
  } else if (crashLooping) {
    meterRow =
      "PROBLEM. The meter keeps stopping right after it starts. See below.";
  } else if (!status.loaded) {
    meterRow = keyPresent
      ? `ACTION NEEDED. Not running. Run: ${CCC_COMMAND_INVOCATION} start`
      : `Waiting for your key. After you save one, run: ${CCC_COMMAND_INVOCATION} start`;
  } else if (status.running) {
    meterRow = hold
      ? "Running, and still recording your spend locally, but nothing's being sent. See the Key line above."
      : "OK. The background meter is running. Your spend is being captured.";
  } else if (hostPlatform() === "win32") {
    // The task runs node behind conhost --headless, which exits 0 whatever node did,
    // so Task Scheduler never restarts a crashed meter (see windows-service.ts). Only
    // `start` or the next sign-in brings it back; "wait" alone would strand them.
    meterRow =
      "Installed but not running right now. Wait a minute and run status again. " +
      `Still not running? Run: ${CCC_COMMAND_INVOCATION} start`;
  } else {
    meterRow =
      "Installed but not running right now. Wait a minute, then run status again.";
  }

  const claudeWired = (
    deps.claudeTelemetryOn ?? (() => claudeTelemetryIsWired())
  )();
  const claudePresent = (
    deps.claudeInstalled ?? (() => isClaudeCodeInstalled())
  )();
  const codexPresent = (deps.codexInstalled ?? (() => isCodexInstalled()))();
  const captureWired = (
    deps.codexCaptureWired ?? (() => codexConfigHasCccBlock())
  )();

  // The Codex trust check spawns Codex's app-server, so it only runs when Control is
  // actually armed. Anything it can't read is "unknown", never a thrown status.
  const armed = (
    deps.controlIsArmed ?? (() => isControlArmed() || isCodexControlArmed())
  )();
  let trust: CodexControlStatus | null = null;
  if (armed) {
    const readStatus =
      deps.codexControlStatus ?? (() => resolveCodexControlStatus({}));
    try {
      trust = await readStatus();
    } catch {
      trust = { state: "unknown", reason: "check-failed" };
    }
  }

  log(
    [
      `  Key:         ${
        keyPresent
          ? hold
            ? `PROBLEM. Your last send was rejected: this key isn't working, and nothing's been sent since ${holdSinceForHumans(hold.since)}. Fix: run ${CCC_COMMAND_INVOCATION} init and paste a working secret key (mf_sk_...).`
            : `OK. Saved in ${ENV_PATH}, a file only you can read.`
          : `ACTION NEEDED. No MarginFront key saved. Run: ${CCC_COMMAND_INVOCATION} init and paste it.`
      }`,
      `  Meter:       ${meterRow}`,
      `  Claude Code: ${
        !claudePresent
          ? CLAUDE_NOT_DETECTED_ROW
          : claudeWired
            ? "OK. Usage reporting is on."
            : `ACTION NEEDED. Usage reporting is off. Run: ${CCC_COMMAND_INVOCATION} init`
      }`,
      `  Codex:       ${codexStatusRow(armed, trust, codexPresent, captureWired)}`,
      ...(queueDepth > 0
        ? [
            `  Queue:       ${queueDepth} record(s) waiting to send: turns, and anything you counted with done. They're saved on disk and will go out ${
              hold ? "once the key works" : "when sending recovers"
            }.`,
          ]
        : []),
    ].join("\n"),
  );

  // Read the settings file the way the running meter reads it, not process.env, so
  // this says what the NEXT record will carry rather than what this shell inherited.
  log("");
  const countedNames = parseFinishedWorkNames(
    (
      deps.finishedWorkNames ??
      (() => loadEnvFile()[FINISHED_WORK_NAMES_ENV_KEY])
    )(),
  );
  log(
    workIdStatusLine(
      (deps.workId ?? createWorkIdReader())(),
      countedNames.length > 0,
    ),
  );
  log(
    ignoreReposStatusLine((deps.ignoredRepos ?? createIgnoredReposReader())()),
  );
  log(finishedWorkStatusLine(countedNames));

  // Spend Control runs off spent.json, and its own freshness gate fails open once
  // that file is an hour stale - so an armed machine whose numbers stopped
  // refreshing (held key, dead meter, network outage) is silently not enforcing.
  // Say so, cause-neutral, because the stale file looks the same for every cause.
  const capsSpentMtimeMs =
    deps.capsSpentMtimeMs ??
    (() => {
      try {
        return statSync(CONTROL_SPENT_PATH).mtimeMs;
      } catch {
        return null;
      }
    });
  const CAPS_STALE_MS = 3600 * 1000;
  const spentMtime = capsSpentMtimeMs();
  if (armed && spentMtime !== null && now() - spentMtime > CAPS_STALE_MS) {
    log("");
    log(
      [
        "Heads up: your spend caps aren't being enforced right now. The spend numbers",
        "they check against stopped refreshing over an hour ago, and stale numbers fail",
        "open on purpose. Enforcement resumes on its own once the meter is sending",
        "normally.",
      ].join("\n"),
    );
  }

  log("");
  log(
    `CCC version ${readVersion()}, built from source. To update: pull the MarginFront repository, rebuild this package, then run ${CCC_SOURCE_INIT_COMMAND} from its root.`,
  );

  if (crashLooping) {
    log(
      [
        "",
        "PROBLEM: the meter keeps stopping right after it starts.",
        `Why: usually a bad setting, or something on this machine changed since setup (last exit code ${status.lastExitCode}).`,
        `Fix: run ${CCC_COMMAND_INVOCATION} init again, then status.`,
        "Still stuck? Read the Recent errors below.",
      ].join("\n"),
    );
  }

  // Everything below is for the curious (and for a stuck user's own diagnosis). It is
  // labeled so a reader knows it is safe to stop reading at the checklist.
  log("");
  log("Optional detail, for the curious:");
  const trustDetail = trust ? renderCodexControlStatusDetail(trust) : null;
  if (trustDetail) log(`Codex detail:${trustDetail}`);
  const readOutput =
    deps.readOutputLog ?? (() => readLastLines(DAEMON_STDOUT_LOG_PATH, 15));
  const readError =
    deps.readErrorLog ?? (() => readLastLines(DAEMON_STDERR_LOG_PATH, 15));
  printDaemonLogTail("output", DAEMON_STDOUT_LOG_PATH, readOutput(), log);
  printDaemonLogTail("errors", DAEMON_STDERR_LOG_PATH, readError(), log);
  return 0;
}

// --- COUNT WHAT YOU FINISH -----------------------------------
// Two commands and one optional question. The meter never computes a price for a
// finished thing: one $0 catalog row does, which is also what marks it as one.

// The two questions, asked by `init` once and by `done --setup` whenever the answer
// changes. Written once so the two callers cannot drift.
export const FINISHED_WORK_QUESTION =
  "\nWant to count finished work too, not only spend? (y/N) ";
export const FINISHED_WORK_NAMES_QUESTION =
  "What do you finish? A few words each, comma-separated: ";

export function finishedWorkQuestion(currentNames: readonly string[]): string {
  return currentNames.length > 0
    ? `\nYou count finished work now: ${renderFinishedWorkNames(currentNames)}. Keep counting it? (Y/n) `
    : FINISHED_WORK_QUESTION;
}

export interface FinishedWorkSetupDeps {
  // What the settings file says today, so an answer that changes nothing writes
  // nothing. Injectable for the same reason every other file read here is.
  currentFinishedNames?: () => string | undefined;
  promptFinishedWork?: (
    question: string,
    defaultYes: boolean,
  ) => Promise<boolean>;
  promptFinishedNames?: (currentNames: string) => Promise<string>;
  promptIO?: PromptIO;
  writeFinishedNames?: (value: string) => void;
  writeMemoryBlocks?: (names: string[]) => MemoryBlockResult[];
  removeMemoryBlocks?: () => MemoryBlockResult[];
  log?: (message: string) => void;
}

// The names line in the settings file is the ONE source of truth for "is this on".
// A blank line is off, which is why the No branch writes a blank rather than leaving
// whatever was there before.
async function runFinishedWorkSetup(
  deps: FinishedWorkSetupDeps,
): Promise<boolean> {
  const log = deps.log ?? console.log;
  const askOn =
    deps.promptFinishedWork ??
    ((question: string, defaultYes: boolean) =>
      promptYesNo(question, deps.promptIO ?? {}, defaultYes));
  const askNames =
    deps.promptFinishedNames ??
    ((currentNames: string) =>
      promptVisible(
        FINISHED_WORK_NAMES_QUESTION,
        currentNames,
        deps.promptIO ?? {},
      ));
  const writeNames =
    deps.writeFinishedNames ??
    ((value: string) => writeFinishedWorkNamesToEnv(value));
  const writeBlocks =
    deps.writeMemoryBlocks ??
    ((names: string[]) => writeFinishedWorkMemoryBlocks({ names }));
  const removeBlocks =
    deps.removeMemoryBlocks ?? (() => removeFinishedWorkMemoryBlocks());

  // A No on a machine that was already off has nothing to undo, and rewriting the
  // settings file for it would make a fresh `init` edit a file it never needed to
  // touch. Only a real change is written.
  const currentNames = parseFinishedWorkNames(
    (
      deps.currentFinishedNames ??
      (() => loadEnvFile()[FINISHED_WORK_NAMES_ENV_KEY])
    )(),
  );
  const wasOn = currentNames.length > 0;

  function turnOff(why: string): boolean {
    if (wasOn) {
      writeNames("");
      removeBlocks();
    }
    log(why);
    return false;
  }

  const turnOn = await askOn(finishedWorkQuestion(currentNames), wasOn);
  if (!turnOn) {
    return turnOff(
      wasOn
        ? "  Turned off. The meter keeps counting spend, and the note is out of your assistant's memory file."
        : "  No problem. The meter keeps counting spend, and nothing else changed.",
    );
  }

  const names = parseFinishedWorkNames(
    await askNames(renderFinishedWorkNames(currentNames)),
  );
  if (names.length === 0) {
    return turnOff(
      `  Nothing to count yet, so this stays off. Run ${CCC_COMMAND_INVOCATION} done --setup when you know what you want counted.`,
    );
  }

  writeNames(renderFinishedWorkNames(names));
  const written = writeBlocks(names)
    .filter((result) => result.action === "written")
    .map((result) => result.path);
  log(
    [
      `  Got it. I'll count: ${renderFinishedWorkNames(names)}.`,
      written.length > 0
        ? `  Added a short note to ${written.join(" and ")} so your assistant records them as it goes.`
        : `  I couldn't find a memory file to add the note to, so run ${CCC_COMMAND_INVOCATION} done "<name>" yourself when you finish one.`,
      `  ${roiFinishedWorkPointer("to see each one you finish with its AI cost beside it")}`,
    ].join("\n"),
  );
  return true;
}

// What `status` says about this machine's mode. Reads the names line, not the memory
// files: the names are what a finished thing gets counted as, and a note in a file
// the customer deleted by hand would otherwise report as "on".
export function finishedWorkStatusLine(names: readonly string[]): string {
  return names.length > 0
    ? `Finished work: on, ${names.length} name${names.length === 1 ? "" : "s"} (${renderFinishedWorkNames(names)}). Record one with ${CCC_COMMAND_INVOCATION} done "<name>". ${roiFinishedWorkPointer("to see each one with its AI cost beside it")}`
    : `Finished work: off. Run ${CCC_COMMAND_INVOCATION} done --setup to turn it on. ${roiFinishedWorkPointer("to see what each finished thing cost in AI once it is on")}`;
}

// --- work: set, show, clear this machine's work-item label ---------------
//
// Attribution splits AI spend by (developer, work item), so the label has to be as
// cheap to change as the work is.

export interface WorkDeps {
  readWorkId?: () => WorkId;
  finishedWorkNames?: () => string | undefined;
  writeWorkId?: (value: string) => void;
  clearWorkId?: () => void;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

export function cmdWork(rest: string[], deps: WorkDeps = {}): number {
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const readWorkId = deps.readWorkId ?? createWorkIdReader();

  if (rest.includes("--clear")) {
    (deps.clearWorkId ?? (() => clearWorkIdsInEnv()))();
    log(
      `${WORK_ITEM_LABEL} cleared. Spend and finished work from this machine belong to no one ${WORK_ITEM_NOUN_PLAIN} until you set one.`,
    );
    return 0;
  }

  // Joined, not only the first word: a customer who types the name without quotes
  // means all of it, and the shell has already thrown the quotes away either way.
  const positionals = rest.filter((argument) => !argument.startsWith("--"));
  const typed = positionals.join(" ");
  // NO argument is the question "what is it now?". An argument that is only spaces
  // is an answer we can't save, and the two must not collapse into each other.
  if (positionals.length === 0) {
    const current = readWorkId();
    if (current.value) {
      log(`${WORK_ITEM_LABEL}: ${current.value}`);
      return 0;
    }
    const counted = parseFinishedWorkNames(
      (
        deps.finishedWorkNames ??
        (() => loadEnvFile()[FINISHED_WORK_NAMES_ENV_KEY])
      )(),
    );
    const whatItWouldDo = `${WORK_ITEM_LABEL}: none. Set one with ${CCC_COMMAND_INVOCATION} work "<name>" so this machine's AI spend adds up under that one name.`;
    log(
      counted.length > 0
        ? `${whatItWouldDo} ${roiFinishedWorkPointer("to see the split")}`
        : whatItWouldDo,
    );
    return 0;
  }

  const name = normalizeWorkId(typed);
  // A line break would split the settings file's KEY=value line in two and take the
  // rest of the value with it, so this one is refused rather than trimmed.
  if (!name || /[\r\n]/.test(typed)) {
    errorLog(
      `That isn't a name I can save. Try ${CCC_COMMAND_INVOCATION} work "Q3 pricing model". Nothing changed.`,
    );
    return 2;
  }

  (deps.writeWorkId ?? ((value: string) => writeWorkIdToEnv(value)))(name);
  log(
    `${WORK_ITEM_LABEL}: ${name}. Everything this machine records from now on goes under it, with nothing to restart.`,
  );
  return 0;
}

// --- done: count one finished thing ------------------------------------------

export type DoneAgentResult =
  | { ok: true; agentCode: string }
  | { ok: false; reason: "unknown-name" | "cannot-tell" };

const DONE_AGENT_CODES = ["claude-code", "codex"];

// WHY THIS REFUSES INSTEAD OF PICKING ONE: agentCode decides which assistant's column
// the row lands in on the ROI page, and the page's agent checkbox scopes the count and
// the attributed cost together. A guess puts the count under one assistant and the
// spend that produced it under the other, which is the exact lie this feature exists
// to stop telling.
export function resolveDoneAgent(input: {
  flag?: string;
  claudeInstalled: boolean;
  codexInstalled: boolean;
  lastSeen: string | null;
}): DoneAgentResult {
  if (input.flag !== undefined) {
    return DONE_AGENT_CODES.includes(input.flag)
      ? { ok: true, agentCode: input.flag }
      : { ok: false, reason: "unknown-name" };
  }
  if (input.claudeInstalled && !input.codexInstalled) {
    return { ok: true, agentCode: "claude-code" };
  }
  if (input.codexInstalled && !input.claudeInstalled) {
    return { ok: true, agentCode: "codex" };
  }
  if (input.claudeInstalled && input.codexInstalled) {
    return input.lastSeen && DONE_AGENT_CODES.includes(input.lastSeen)
      ? { ok: true, agentCode: input.lastSeen }
      : { ok: false, reason: "cannot-tell" };
  }
  return { ok: false, reason: "cannot-tell" };
}

export interface DoneDeps extends FinishedWorkSetupDeps {
  loadEnv?: () => Record<string, string>;
  resolveServer?: () => ServerUrlResult;
  apiKeyInEnvironment?: () => string | undefined;
  readWorkId?: () => WorkId;
  claudeInstalled?: () => boolean;
  codexInstalled?: () => boolean;
  lastAgentSeen?: () => string | null;
  readGitCoordinates?: () => GitCoordinates | null;
  ignoredRepos?: () => IgnoredRepos;
  now?: () => Date;
  post?: (body: RequestBody) => Promise<PostResult>;
  queue?: (records: UsageRecord[]) => void;
  isTTY?: () => boolean;
  errorLog?: (message: string) => void;
}

// `--agent codex` and `--agent=codex` both, because both are what people type.
function flagValue(rest: string[], name: string): string | undefined {
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === name) return rest[index + 1];
    if (rest[index].startsWith(`${name}=`)) {
      return rest[index].slice(name.length + 1);
    }
  }
  return undefined;
}

// main()'s own splitter would hand "codex" back as a positional and read it as the
// name of a finished thing, so `done` parses its own arguments.
function donePositionals(rest: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--agent") {
      index += 1;
      continue;
    }
    if (rest[index].startsWith("--")) continue;
    positionals.push(rest[index]);
  }
  return positionals;
}

export async function cmdDone(
  rest: string[],
  deps: DoneDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;

  if (rest.includes("--setup")) {
    const interactive = (deps.isTTY ?? (() => Boolean(process.stdin.isTTY)))();
    if (!interactive) {
      errorLog(
        `${CCC_COMMAND_INVOCATION} done --setup asks two questions, so it needs a terminal. Nothing changed.`,
      );
      return 2;
    }
    await runFinishedWorkSetup(deps);
    return 0;
  }

  const positionals = donePositionals(rest);
  const name = normalizeFinishedName(positionals[0]);
  if (!name) {
    errorLog(
      `Name what you finished, like ${CCC_COMMAND_INVOCATION} done "contract summarized", or with a count: ${CCC_COMMAND_INVOCATION} done "contract summarized" 3. Nothing was counted.`,
    );
    return 2;
  }

  const count = parseFinishedCount(positionals[1]);
  if (!count.ok) {
    errorLog(
      count.reason === "out-of-range"
        ? `The count has to be between 1 and ${FINISHED_WORK_MAX_COUNT}. Nothing was counted.`
        : `"${positionals[1]}" isn't a whole number. Put a count after the name, like ${CCC_COMMAND_INVOCATION} done "contract summarized" 3. Nothing was counted.`,
    );
    return 2;
  }

  // NO git fallback, though init pre-fills its own prompt from git. With this blank
  // the daemon falls back to the coding-agent login, which lives in telemetry only
  // it reads, so a git guess here would split the count from the spend it is
  // attributed from.
  const env = (deps.loadEnv ?? (() => loadEnvFile()))();
  const identity = (env["CCC_DEVELOPER_EMAIL"] || "").trim();
  if (!identity) {
    errorLog(
      `I don't know whose work this is, so nothing was counted. Fix: run ${CCC_COMMAND_INVOCATION} init and answer the developer email question.`,
    );
    return 2;
  }

  // Only decides whether to TRY: loadEnvFile has already copied the file's key into
  // the environment, which is where postToMarginFront reads it from.
  const apiKey =
    (env["MARGINFRONT_API_KEY"] || "").trim() ||
    (
      (deps.apiKeyInEnvironment ?? (() => process.env.MARGINFRONT_API_KEY))() ||
      ""
    ).trim();
  if (!apiKey) {
    errorLog(
      `No MarginFront key is saved on this machine, so nothing was counted. Fix: run ${CCC_COMMAND_INVOCATION} init and paste your secret key (mf_sk_...).`,
    );
    return 2;
  }

  const server = (deps.resolveServer ?? (() => resolveConfiguredServer()))();
  if (!server.ok) {
    errorLog(
      `${server.problem} Nothing was counted. Fix: run ${CCC_COMMAND_INVOCATION} init --api-url <address>.`,
    );
    return 2;
  }

  // Asked-for-but-empty has to reach resolveDoneAgent as a value it will refuse. A
  // trailing `--agent` read as "no flag given" would fall through to auto-detection
  // and file a typo under whichever assistant happened to be working last.
  const agentAsked = rest.some(
    (argument) => argument === "--agent" || argument.startsWith("--agent="),
  );
  const agentTyped = flagValue(rest, "--agent");
  const agent = resolveDoneAgent({
    flag: agentAsked ? (agentTyped ?? "") : undefined,
    claudeInstalled: (
      deps.claudeInstalled ?? (() => isClaudeCodeInstalled())
    )(),
    codexInstalled: (deps.codexInstalled ?? (() => isCodexInstalled()))(),
    lastSeen: (
      deps.lastAgentSeen ?? (() => readLastAgentSeen(LAST_AGENT_PATH))
    )(),
  });
  if (!agent.ok) {
    errorLog(
      agent.reason !== "unknown-name"
        ? `I can't tell which assistant this belongs to, so nothing was counted. Fix: name it with --agent claude-code or --agent codex.`
        : agentTyped
          ? `"${agentTyped}" isn't one I know. Use --agent claude-code or --agent codex. Nothing was counted.`
          : `--agent needs a name after it. Use --agent claude-code or --agent codex. Nothing was counted.`,
    );
    return 2;
  }

  // `done` posts on its own path, not through the watcher's partition, so the one
  // command a customer types by hand has to ask the ignore question itself.
  const git = (
    deps.readGitCoordinates ?? (() => readGitCoordinates(process.cwd()))
  )();
  const ignoredRepos = (deps.ignoredRepos ?? createIgnoredReposReader())();
  const repo = git?.repo;
  if (typeof repo === "string" && ignoredRepos.repos.has(repo.toLowerCase())) {
    log(
      `${repo} is named in ${IGNORE_REPOS_ENV_KEY} in ${ENV_PATH}, so nothing was counted and nothing was sent.`,
    );
    return 0;
  }

  const workId = (deps.readWorkId ?? createWorkIdReader())();
  const record = buildFinishedWorkRecord({
    identity,
    agentCode: agent.agentCode,
    name,
    count: count.count,
    workItem: workId.value,
    git,
    doneAt: (deps.now ?? (() => new Date()))().toISOString(),
  });

  const said = workId.value
    ? `Recorded "${name}" x${count.count} for ${identity} under ${WORK_ITEM_NOUN} ${workId.value}. ${roiFinishedWorkPointer("to see it with its AI cost beside it")}`
    : `Recorded "${name}" x${count.count} for ${identity} with no ${WORK_ITEM_NOUN} set, so its AI cost is a share of everything your AI spent outside one. Run ${CCC_COMMAND_INVOCATION} work "<name>" in your terminal first next time to narrow that to one ${WORK_ITEM_NOUN_PLAIN}.`;

  const post = deps.post ?? ((body: RequestBody) => postToMarginFront(body));
  const result = await post({ records: [record] });
  if (result.ok) {
    log(said);
    return 0;
  }
  // Read before the narrowing below consumes the http shape.
  const httpStatus = result.reason === "http" ? result.status : null;

  // The same durable outbox the turn records use. A dead key parks too: the daemon
  // holds and drains it once the key works, and dropping the count instead would
  // lose the one thing the customer typed by hand.
  const keyIsDead = isAuthFailurePostResult(result);
  if (isRetryablePostResult(result) || keyIsDead) {
    (
      deps.queue ??
      ((records: UsageRecord[]) => appendToQueue(FORWARDER_QUEUE_PATH, records))
    )([record]);
    log(
      keyIsDead
        ? `${said} MarginFront isn't accepting your key right now, so it's saved on this machine and the meter sends it once the key works. Fix the key with ${CCC_COMMAND_INVOCATION} init.`
        : `${said} Couldn't reach MarginFront, so it's saved on this machine and the meter sends it the next time it's running. On Linux and WSL that means the next time you run ${CCC_COMMAND_INVOCATION} run.`,
    );
    return 0;
  }

  errorLog(
    `MarginFront refused that record${httpStatus === null ? "" : ` (HTTP ${httpStatus})`}. Nothing was counted, and running it again would be refused the same way. Check your key with ${CCC_COMMAND_INVOCATION} status.`,
  );
  return 2;
}

// --- preview ----------------------------------------------------------------
function cmdPreview(positionals: string[], foldCache: boolean): number {
  const inputFilePath = positionals[0];
  if (!inputFilePath) {
    console.error(
      "preview needs a capture file:  node ~/.marginfront-ccc/cli.js preview <capture.json>\n" +
        "A capture is one OTLP/JSON snapshot - e.g. a line from ~/.marginfront-ccc/live-otlp.jsonl.",
    );
    return 1;
  }
  const parsedOtlp = readAndParseOtlpFile(inputFilePath);
  // Make preview tell the TRUTH about who the spend gets attributed to. The live
  // watcher (cmdRun -> watchAndForward) loads the saved settings and resolves
  // CCC_DEVELOPER_EMAIL into a per-developer override before it forwards. If preview
  // skips that step it prints the shared login email even when the developer set an
  // override - so the record the user inspects here would NOT match the record that
  // actually gets sent. We do the SAME two steps the watcher does:
  //   1) loadEnvFile() pulls CCC_DEVELOPER_EMAIL (and the rest of ~/.marginfront-ccc/.env)
  //      into process.env WITHOUT overriding a value already exported in this shell.
  //   2) resolveDeveloperOverride(process.env) reads it the exact same way the watcher
  //      does (trimmed; empty/whitespace -> undefined).
  // No key is needed for any of this: with no .env, loadEnvFile() returns {} and the
  // override stays undefined, so the telemetry's own email is used - preview keeps
  // working with no key configured.
  loadEnvFile();
  const developerOverride = resolveDeveloperOverride(process.env);
  // Same preview==send rule for the cache-write TTL stamp: resolve
  // CCC_CACHE_WRITE_TTL exactly like the watcher so the previewed metadata
  // matches what would actually be sent.
  const cacheWriteTtl = resolveCacheWriteTtl(process.env);
  // Same preview==send rule for the work item, through the watcher's own
  // reader rather than process.env: the settings file is what the running meter
  // consults, so a line edited a minute ago shows up here too.
  const workId = createWorkIdReader()();
  // Same preview==send rule for the repos this machine never sends from: without a
  // git resolver, preview could never show an ignore rule working and would print
  // records the running meter refuses.
  const ignoredRepos = createIgnoredReposReader()().repos;
  const resolveGitCoordinates = createGitCoordinatesResolver();
  const buildOptions = {
    foldCache,
    fallbackCustomerId: NO_IDENTITY_CUSTOMER,
    developerOverride,
    matterNumber: workId.value,
    cacheWriteTtl,
    resolveGitCoordinates,
  };
  // Shape-detects Claude Code (metrics) vs Codex (logs); previews either, tool line items included.
  const body = buildRequestBodyForLine(parsedOtlp, {
    ...buildOptions,
    ignoredRepos,
  });
  console.log(JSON.stringify(body, null, 2));
  // A capture that previews as nothing at all is indistinguishable from a broken
  // capture, so name the repos the rule refused. The unfiltered build is what knows
  // them: each dropped record already carries the repo the resolver placed it in.
  if (ignoredRepos.size > 0) {
    const everything = buildRequestBodyForLine(parsedOtlp, buildOptions);
    const keptSessions = new Set(body.records.map(recordSessionId));
    const refused = new Set<string>();
    for (const record of everything.records) {
      if (keptSessions.has(recordSessionId(record))) continue;
      const repo = record.metadata.repo;
      if (typeof repo === "string" && repo) refused.add(repo);
    }
    if (refused.size > 0) {
      const names = [...refused].sort().join(", ");
      console.log("");
      console.log(
        `Ignoring: ${names}. ${IGNORE_REPOS_ENV_KEY} in ${ENV_PATH} names ${
          refused.size === 1 ? "it" : "them"
        }, so this machine sends no spend from ${
          refused.size === 1 ? "it" : "them"
        }.`,
      );
    }
  }
  // A typo in the ID is invisible in a wall of JSON, and it is the difference between
  // a job's page and the Unassigned bucket. Say it in one readable line - but only
  // when there is a record to carry it: a capture that previews as no records at all
  // would otherwise name a work item nothing is being attributed to.
  if (workId.value && body.records.length) {
    console.log("");
    console.log(`${WORK_ITEM_LABEL}: ${workId.value}`);
  }
  // If any record landed under the placeholder, explain how to fix attribution.
  const usedFallback = body.records.some(
    (r) =>
      r.customerExternalId === NO_IDENTITY_CUSTOMER ||
      r.customerExternalId === CODEX_NO_IDENTITY_CUSTOMER,
  );
  if (usedFallback) {
    console.log("");
    printNoIdentityHint();
  }
  return 0;
}

// Exported for testing - cmdRun delegates to this instead of inlining the logic.
// Returns the live pid when a forwarder is already running, null when the path
// is clear (absent, unreadable, or stale/dead pid). Tests call this directly with
// a temp pidfile path, so we always test the REAL guard, not a copy of it.
export function runningForwarderPid(pidFilePath: string): number | null {
  if (!existsSync(pidFilePath)) return null;
  try {
    const raw = readFileSync(pidFilePath, "utf8").trim();
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && isPidAlive(parsed)) return parsed;
  } catch {
    // Unreadable pidfile = treat as stale; don't block the user on a bad file.
  }
  return null;
}

// --- run --------------------------------------------------------------------
// Exported for testing. _overridePidPath is test-only - every real caller (main)
// omits it so the production FORWARDER_PID_PATH is used.
export function cmdRun(
  foldCache: boolean,
  logToFiles: boolean,
  _overridePidPath?: string,
  // Tests inject both log paths, like the pidfile: the defaults live under the real
  // home, and a test that touches them trips the suite's real-home guard on CI.
  _overrideLogPaths?: { out: string; err: string },
): number | null {
  const outLogPath = _overrideLogPaths?.out ?? DAEMON_STDOUT_LOG_PATH;
  const errLogPath = _overrideLogPaths?.err ?? DAEMON_STDERR_LOG_PATH;
  // WHERE THIS RUN'S OWN OUTPUT GOES, decided before anything below prints - the
  // refusal right underneath included. The Windows task passes the flag because
  // nothing else there captures a background process's output; launchd already
  // redirects the macOS job, so its plist does not pass it.
  if (logToFiles) routeConsoleOutputToFiles(outLogPath, errLogPath);

  // LOG CAP: a crash loop can fill the disk with error log. Ahead of the refusal below, which writes to that same
  // err log. Rotation must never stop the meter.
  try {
    rotateLogIfHuge(outLogPath, 5 * 1024 * 1024);
    rotateLogIfHuge(errLogPath, 5 * 1024 * 1024);
  } catch {
    // log hygiene is best-effort by design
  }

  // SINGLE-INSTANCE GUARD: two forwarders racing on the same cursor +
  // queue files would double-count or drop records. Check for a live pidfile
  // before any work that loads state - loadEnvFile included - so a clear message is
  // the first thing the user sees.
  const guardPath = _overridePidPath ?? FORWARDER_PID_PATH;
  const livePid = runningForwarderPid(guardPath);
  if (livePid !== null) {
    // WHY the stop-first advice is safe: cmdStop sends SIGTERM to the
    // forwarder process (if still alive) AND deletes the pidfile, so after
    // `stop` the next `run` always starts clean - no loop.
    console.error(
      `A CCC forwarder is already running (pid ${livePid}).\n` +
        "  Stop it first:  node ~/.marginfront-ccc/cli.js stop\n" +
        "  (If nothing seems to be running, 'stop' also clears the stale\n" +
        `  pid file at ${FORWARDER_PID_PATH}.)`,
    );
    return 1;
  }
  // Dead or absent pidfile - fall through. watchAndForward overwrites/creates it.

  // Snapshot the work item this SHELL exported, before the next line copies the
  // settings file into process.env. After that copy the two are indistinguishable, and
  // a line deleted from the file mid-run would keep resolving out of the copy. The
  // snapshot is read only when the settings file names neither key.
  const shellMatterEnv: NodeJS.ProcessEnv = {
    [WORK_ID_ENV_KEY]: process.env[WORK_ID_ENV_KEY],
    [MATTER_NUMBER_ENV_KEY]: process.env[MATTER_NUMBER_ENV_KEY],
  };

  // Load saved settings (API key + telemetry vars) without overriding the shell.
  loadEnvFile();

  if (!existsSync(COLLECTOR_BIN_PATH) || !existsSync(COLLECTOR_CONFIG_PATH)) {
    console.error(
      `Not set up yet. From the root of your MarginFront source checkout, run \`${CCC_SOURCE_INIT_COMMAND}\` first.`,
    );
    return 1;
  }

  if (!process.env.MARGINFRONT_API_KEY) {
    console.error(
      [
        "No MARGINFRONT_API_KEY found, so there's nothing to send to.",
        `Fix: paste your MarginFront secret key (mf_sk_...) after MARGINFRONT_API_KEY= in ${ENV_PATH},`,
        "     or export MARGINFRONT_API_KEY=... in this shell, then re-run.",
        "No key handy? `preview <capture.json>` shows what it would send without one.",
      ].join("\n"),
    );
    return 1;
  }

  const server = resolveConfiguredServer();
  if (!server.ok) {
    console.error(
      [
        "The meter did not start, so nothing is being counted.",
        server.problem,
        `Fix: put the address after ${SERVER_URL_SETTING}= in ${ENV_PATH}, or run`,
        `     ${CCC_COMMAND_INVOCATION} init --api-url <address>, then start again.`,
      ].join("\n"),
    );
    return 1;
  }

  // Start the collector as its own background process, then stream.
  const { startedByUs } = startCollector();
  // DESKTOP COVERAGE: also put the telemetry vars where the Claude/Codex *desktop* apps
  // will see them (on macOS, the launchd GUI-session env). They don't read
  // ~/.claude/settings.json's env block and never see the shell. This runs here so the
  // background job re-applies it at every sign-in; desktop apps must be (re)opened
  // afterward to inherit it. Harmless in the foreground, and a no-op where the platform
  // has no equivalent - see service-manager.ts.
  findServiceManager(platform())?.applyDesktopEnvironment();
  console.log("");
  printNoIdentityHint();
  console.log("");

  const stopWatch = watchAndForward(LIVE_JSONL_PATH, {
    foldCache,
    fallbackCustomerId: NO_IDENTITY_CUSTOMER,
    // Resume from the last cursor so stop-then-run doesn't re-send (re-bill) a session.
    cursorPath: FORWARDER_CURSOR_PATH,
    // Park transient send failures instead of dropping them; drains each poll
    // (pairs with server dedup for exactly-once delivery).
    queuePath: FORWARDER_QUEUE_PATH,
    // Single-instance guard: watchAndForward writes process.pid here and removes it
    // on clean stop. cmdRun read it above to refuse a duplicate; now pass it so the
    // forwarder owns the slot for the lifetime of this run. Use guardPath so a
    // test-path override flows through to the forwarder too.
    pidFilePath: guardPath,
    // Auth hold: persists a 401/403 pause across restarts so a
    // respawned daemon resumes holding instead of hammering a dead key.
    authHoldPath: FORWARDER_AUTH_HOLD_PATH,
    // Which assistant was last seen working, so `done` can name it on a machine
    // that has both installed.
    lastAgentPath: LAST_AGENT_PATH,
    // The shell's own work-item keys, taken above before loadEnvFile() ran.
    matterEnv: shellMatterEnv,
  });

  // The other half of the ladder in connector.ts: on Windows this poll is what turns
  // `stop` into the clean shutdown SIGTERM gets everywhere else. It runs on every
  // platform on purpose - one path the whole suite exercises beats a Windows-only path
  // nobody runs. Swept first, or a request left by a forced `stop` shuts this forwarder
  // down seconds after it starts.
  clearShutdownRequest();
  let shutdownMailboxTimer: NodeJS.Timeout | null = null;

  // Ctrl-C: stop the watcher, and the collector if WE started it - leave nothing running.
  const shutdown = () => {
    console.log("\nStopping…");
    if (shutdownMailboxTimer) clearInterval(shutdownMailboxTimer);
    clearShutdownRequest();
    stopWatch();
    if (startedByUs) stopCollector();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  shutdownMailboxTimer = setInterval(() => {
    if (readShutdownRequest(process.pid)) shutdown();
  }, SHUTDOWN_REQUEST_POLL_MS);

  return null; // signals "long-running, do not exit" (watch interval keeps the process alive)
}

// --- stop -------------------------------------------------------------------

// How long to wait between checks of "is the forwarder gone yet?", and how long to
// wait overall before we give up being polite. The forwarder shuts down in a blink
// (clear its timer, exit), so in practice we almost always see it gone on the first
// check. These only matter if something is wedged.
const STOP_FORWARDER_POLL_MS = 50;
const STOP_FORWARDER_TIMEOUT_MS = 3_000;

// What `stopForwarderThenStopCollector` needs from the outside world, injected so the
// ORDER it does things in can be unit-tested without killing real processes or sleeping.
export interface StopDeps {
  // Is the forwarder process still running? (production: isPidAlive(forwarderPid))
  isForwarderAlive: () => boolean;
  // Ask the forwarder to stop. SIGTERM = "please shut down cleanly"; SIGKILL = "down, now."
  signalForwarder: (signal: "SIGTERM" | "SIGKILL") => void;
  // Stop the collector (production: stopCollector()).
  stopCollector: () => void;
  // Wait this many ms before checking again (production: real setTimeout).
  sleep: (ms: number) => Promise<void>;
  // Wall-clock ms, injected so a test can drive the timeout without really waiting.
  now: () => number;
  // Where status lines go (defaults to console.log).
  log?: (message: string) => void;
}

// STOP IN THE RIGHT ORDER - this is the whole point of this function.
//
// WHY ORDER MATTERS, in plain English: while the forwarder is running, it checks every
// second "is the collector still alive? if not, restart it" (the self-heal in
// forwarder.ts). That's great while you're collecting - but during `stop` it's a trap.
// If we killed the collector FIRST, the forwarder's very next once-a-second check would
// see the collector gone and cheerfully start a brand-new one. Worse: if this forwarder
// attached to a collector it did NOT start itself (someone had one running already), the
// forwarder's own shutdown does NOT stop the collector - so that resurrected collector
// would be left running with nobody watching it. That breaks the promise that `stop`
// leaves nothing running (see the Ctrl-C shutdown comment in cmdRun).
//
// So: stop the FORWARDER first and wait until its process is actually gone. Once
// it's gone, its once-a-second loop is gone too, so nothing can revive the collector.
// THEN - and only then - stop the collector. (If the forwarder started the collector
// itself, its clean shutdown already stopped it; calling stopCollector again is a
// harmless no-op. If the forwarder did NOT start it, this is the call that stops it.)
export async function stopForwarderThenStopCollector(
  deps: StopDeps,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const log = deps.log ?? console.log;

  if (deps.isForwarderAlive()) {
    // 1) Politely ask the forwarder to shut down.
    deps.signalForwarder("SIGTERM");

    // 2) Wait until it's actually gone (or we run out of patience). We must NOT stop the
    //    collector until this loop confirms the forwarder is down - otherwise a lingering
    //    once-a-second tick could revive the collector after we've stopped it.
    const deadline = deps.now() + timeoutMs;
    while (deps.isForwarderAlive() && deps.now() < deadline) {
      await deps.sleep(pollMs);
    }

    // 3) Still alive after the grace period? Force it down. Its clean-shutdown handler
    //    won't run on SIGKILL, but that's fine: we delete its pidfile and stop the
    //    collector ourselves below, so nothing is left dangling - and a wedged forwarder
    //    can no longer revive the collector once its process is gone.
    if (deps.isForwarderAlive()) {
      log("Forwarder didn't stop on its own; forcing it down.");
      deps.signalForwarder("SIGKILL");
      const hardDeadline = deps.now() + timeoutMs;
      while (deps.isForwarderAlive() && deps.now() < hardDeadline) {
        await deps.sleep(pollMs);
      }
    }
  }

  // The forwarder is confirmed down (or was never running): no poll loop exists, so
  // stopping the collector now cannot be undone by a self-heal tick.
  deps.stopCollector();
}

async function cmdStop(): Promise<number> {
  // FIRST, take the meter out of the service manager's hands. Its whole job is to
  // bring the meter back when it dies (launchd KeepAlive, Task Scheduler
  // restart-on-failure), so stopping the forwarder while it is still watching gets the
  // forwarder respawned and `stop` appears to do nothing. PAUSE, not remove: `stop`
  // comes back at the next `start` or sign-in; `uninstall` REMOVES.
  const suspended = findServiceManager(platform())?.suspend() ?? null;
  if (suspended?.wasActive) {
    console.log(
      "Paused the background daemon (it won't auto-restart until you run `start` or log in again).",
    );
  }

  // Read the forwarder's pid up front (if `run` left a pidfile behind).
  let forwarderPid: number | null = null;
  if (existsSync(FORWARDER_PID_PATH)) {
    try {
      const raw = readFileSync(FORWARDER_PID_PATH, "utf8").trim();
      const parsed = parseInt(raw, 10);
      if (Number.isInteger(parsed)) forwarderPid = parsed;
    } catch {
      // Unreadable pidfile - treat as "no live forwarder we can signal"; we still
      // delete the stale file at the end so the next `run` isn't blocked.
    }
  }

  // Stop the forwarder first, then the collector - see the big comment above for WHY.
  await stopForwarderThenStopCollector(
    {
      isForwarderAlive: () => forwarderPid !== null && isPidAlive(forwarderPid),
      signalForwarder: (signal) => {
        if (forwarderPid === null) return;
        signalForwarderStop(forwarderPid, signal);
        if (signal === "SIGTERM") {
          console.log(
            `Asked the forwarder (pid ${forwarderPid}) to shut down. Waiting for it to stop…`,
          );
        }
      },
      stopCollector: () => {
        stopCollector();
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      log: (message) => console.log(message),
    },
    STOP_FORWARDER_POLL_MS,
    STOP_FORWARDER_TIMEOUT_MS,
  );

  // Only now the forwarder is confirmed down. A no-op on macOS; on Windows it
  // re-enables the task, so `stop` means the same thing on both platforms.
  suspended?.restore();

  // A request the forwarder never read - it was already gone, or had to be forced -
  // would otherwise shut down the NEXT `run` seconds after it starts.
  clearShutdownRequest();

  // Always delete the forwarder pidfile. A clean shutdown already removed it, but a
  // SIGKILL (or a crashed/stale forwarder) won't have - remove it here so the
  // refused→stop→refused loop is impossible and the next `run` starts clean.
  if (existsSync(FORWARDER_PID_PATH)) {
    try {
      rmSync(FORWARDER_PID_PATH, { force: true });
    } catch {
      // Ignore - on the extremely rare chance we can't remove it, the user will
      // need to delete ~/.marginfront-ccc/forwarder.pid by hand.
    }
  }

  return 0;
}

// --- uninstall --------------------------------------------------------------
//
// REVERSE EVERYTHING `init` DID. init wires global state (the
// launchd daemon + ~/.claude/settings.json + ~/.codex/config.toml), so uninstall
// has matching reverters and prints what it put back. Each step is injectable
// (UninstallDeps) so a test can prove every reverter is called WITHOUT touching the
// real ~/.claude / launchd / ~/.marginfront-ccc; real callers (main) omit deps.
//
// The ONE thing we never touch is ~/.zshrc: if it carries our `source` line we
// REMIND the user (it's their file), we don't edit it silently.
export interface UninstallDeps {
  uninstallDaemon?: () => void;
  stopCollector?: () => void;
  removeClaudeTelemetry?: () => RemoveClaudeSettingsResult;
  removeCodexConfig?: () => RemoveCodexConfigResult;
  // Spend Control: remove the PreToolUse hook entry + the cap-check
  // script + the receipt (default: removeControlHook). A no-op when Control was
  // never armed, so uninstall stays safe on a metering-only install.
  removeControlHook?: () => void;
  // Codex arm: remove ONLY our entry from ~/.codex/hooks.json, plus the
  // shell wrapper and the receipt. A no-op when the Codex arm was never installed.
  removeCodexControlHook?: () => void;
  // Remove one regenerable runtime file (default: rm it if it exists).
  removeRuntimeFile?: (path: string) => void;
  // Sweep the materialized Control state dir - policy / spent / trip (default:
  // rm -rf ~/.marginfront-ccc/control). A seam, not a convenience: without it a
  // cmdUninstall test would delete the runner's REAL Spend Control install, because
  // this path is computed from homedir() when the module loads.
  removeControlStateDir?: () => void;
  // Delete the whole config dir on --purge (default: rm -rf ~/.marginfront-ccc).
  purgeConfigDir?: () => void;
  findZshrcLines?: () => ZshrcSourceLineResult;
  unsetDesktopEnv?: () => void;
  // Take our note back out of the assistants' memory files.
  removeMemoryBlocks?: () => MemoryBlockResult[];
  // FORWARDER TEARDOWN - injectable so a test drives the REAL signalling
  // path with a recording process.kill, never touching a live machine:
  //   - readForwarderPid(): the running forwarder's pid, or null if none is running
  //     (default: parse FORWARDER_PID_PATH the same way `stop` does).
  //   - isForwarderAlive(pid): is it still up? (default: isPidAlive).
  //   - signalForwarder(pid, signal): SIGTERM, then SIGKILL if it won't stop
  //     (default: process.kill, swallowing "already gone").
  //   - sleep / now: drive the patience deadline without really waiting in tests.
  readForwarderPid?: () => number | null;
  isForwarderAlive?: (pid: number) => boolean;
  signalForwarder?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export async function cmdUninstall(
  purge: boolean,
  deps: UninstallDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  const removeDaemon =
    deps.uninstallDaemon ??
    (() => findServiceManager(platform())?.uninstall({ log }));
  const stopColl =
    deps.stopCollector ??
    (() => {
      stopCollector({ log });
    });
  // Read the forwarder pid the SAME way `stop` does: a live pidfile left by `run`.
  const readForwarderPid =
    deps.readForwarderPid ??
    (() => {
      if (!existsSync(FORWARDER_PID_PATH)) return null;
      try {
        const raw = readFileSync(FORWARDER_PID_PATH, "utf8").trim();
        const parsed = parseInt(raw, 10);
        return Number.isInteger(parsed) ? parsed : null;
      } catch {
        // Unreadable pidfile - treat as "nothing we can signal"; the file is removed
        // below with the other runtime files anyway.
        return null;
      }
    });
  const isForwarderAlive =
    deps.isForwarderAlive ?? ((pid: number) => isPidAlive(pid));
  const signalForwarder =
    deps.signalForwarder ??
    ((pid: number, signal: "SIGTERM" | "SIGKILL") => {
      signalForwarderStop(pid, signal);
    });
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const removeClaude =
    deps.removeClaudeTelemetry ??
    (() => removeClaudeTelemetrySettings({ log }));
  const removeCodex =
    deps.removeCodexConfig ?? (() => removeCodexOtelConfig({ log }));
  const removeControl =
    deps.removeControlHook ?? (() => void removeControlHook({ log }));
  const removeCodexControl =
    deps.removeCodexControlHook ?? (() => void removeCodexControlHook({ log }));
  const removeFile =
    deps.removeRuntimeFile ??
    ((path: string) => {
      if (existsSync(path)) rmSync(path, { force: true });
    });
  const removeControlState =
    deps.removeControlStateDir ??
    (() => {
      if (existsSync(CONTROL_DIR))
        rmSync(CONTROL_DIR, { recursive: true, force: true });
    });
  const purgeDir =
    deps.purgeConfigDir ??
    (() => {
      if (existsSync(CONFIG_DIR))
        rmSync(CONFIG_DIR, { recursive: true, force: true });
    });
  const findZshrc = deps.findZshrcLines ?? (() => findCccZshrcSourceLines());
  const unsetDesktop =
    deps.unsetDesktopEnv ??
    (() => findServiceManager(platform())?.clearDesktopEnvironment());

  // 1) Remove the launchd background job FIRST: bootout (KeepAlive off so it can't
  //    respawn the forwarder mid-teardown) AND sweep any orphan ai.marginfront.ccc.*
  //    labels, then delete its plist + the stable cli.js copy so it won't auto-start
  //    at the next login. No-op if it was never installed.
  removeDaemon();

  // 2) Kill any STILL-RUNNING forwarder, THEN stop the collector - in the same
  //    order `stop` uses (forwarder fully down before the collector, so its
  //    once-a-second self-heal can't revive a collector we just stopped). This is
  //    what catches a foreground `run`, a wedged forwarder, or one the daemon bootout
  //    above didn't own. Without signalling the pid, a foreground forwarder would keep
  //    sending after --purge. The forwarder's
  //    stale pidfile is deleted below with the other runtime files.
  const forwarderPid = readForwarderPid();
  await stopForwarderThenStopCollector(
    {
      isForwarderAlive: () =>
        forwarderPid !== null && isForwarderAlive(forwarderPid),
      signalForwarder: (signal) => {
        if (forwarderPid !== null) signalForwarder(forwarderPid, signal);
      },
      stopCollector: () => {
        stopColl();
      },
      sleep,
      now,
      log,
    },
    STOP_FORWARDER_POLL_MS,
    STOP_FORWARDER_TIMEOUT_MS,
  );

  // 3) Undo the Claude Code telemetry wiring (~/.claude/settings.json) - surgically:
  //    removes ONLY the keys we recorded as ours, and only if their value still
  //    matches, so a value the user set or changed survives. A missing file or
  //    receipt is a soft no-op.
  removeClaude();

  // 4) Undo the Codex wiring - removes ONLY our fenced block from
  //    ~/.codex/config.toml and leaves every other setting byte-identical.
  removeCodex();

  // 4b) Undo the Spend Control wiring: remove ONLY our PreToolUse hook
  //     entry from ~/.claude/settings.json (matched by its command), plus the
  //     cap-check script and the receipt. A no-op if Control was never armed.
  removeControl();

  // 4b-ii) Same surgery on the Codex side: only our entry leaves
  //        ~/.codex/hooks.json, and the file itself goes only if our entry was the
  //        only thing in it. A no-op if the Codex arm was never installed.
  removeCodexControl();

  // 4b-iii) And the finished-work note: our fenced block leaves
  //         ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md byte for byte, and a file
  //         that held nothing else goes with it. Not gated on the assistant still
  //         being installed: the block would outlive an assistant someone removed.
  const memoryResults = (
    deps.removeMemoryBlocks ?? (() => removeFinishedWorkMemoryBlocks())
  )();
  const memoryRemoved = memoryResults
    .filter((result) => result.action === "removed")
    .map((result) => result.path);
  if (memoryRemoved.length > 0) {
    log(`Removed the finished-work note from ${memoryRemoved.join(" and ")}.`);
  }

  // 4c) Clear the desktop GUI-session telemetry env (the launchctl-setenv coverage that
  //     `run` applies). `launchctl unsetenv` on an unset key is a harmless no-op.
  unsetDesktop();

  // 5) Remove the heavy + regenerable bits. Keep .env (your API key) unless --purge.
  const toRemove = [
    COLLECTOR_BIN_PATH,
    COLLECTOR_CONFIG_PATH,
    LIVE_JSONL_PATH,
    COLLECTOR_PID_PATH,
    COLLECTOR_LOG_PATH,
    // Clear the resume cursor too - it points into the live file we just removed.
    FORWARDER_CURSOR_PATH,
    // And the retry queue - its records reference the now-removed live file.
    FORWARDER_QUEUE_PATH,
    // And the single-instance guard pidfile - no forwarder will be running after this.
    FORWARDER_PID_PATH,
    // And the auth-hold marker - left behind, a fresh install would start held.
    FORWARDER_AUTH_HOLD_PATH,
    // And which assistant the meter last saw - left behind, it would outlive the
    // assistant it names and put a later `done` in the wrong column.
    LAST_AGENT_PATH,
  ];
  for (const path of toRemove) removeFile(path);
  // The Control state dir (policy / spent / trip) - regenerable, so cleared here too
  // (removeControl already took the script; this sweeps the materialized state).
  removeControlState();
  log("Removed the collector binary, its config, and runtime files.");

  if (purge) {
    purgeDir();
    log(
      `Purged ${CONFIG_DIR} - your saved settings and MarginFront secret key (mf_sk_...) are gone.`,
    );
  } else {
    log(
      `Kept your settings at ${ENV_PATH}. Re-run init anytime to reinstall, ` +
        "or add --purge to delete settings too.",
    );
  }

  // 6) ~/.zshrc reminder - only if a leftover line is actually there. We never edit
  //    ~/.zshrc on uninstall; we only point at it.
  const zshrc = findZshrc();
  if (zshrc.found) {
    log(
      [
        "Reminder: your ~/.zshrc still has a leftover MarginFront line:",
        ...zshrc.matchedLines.map((line) => `    ${line}`),
        "It's harmless now, but you can delete it by hand if you like.",
      ].join("\n"),
    );
  }

  // 7) The closing read-back, in the same checklist shape init and status use, so the
  //    three commands rhyme. The last line is the only next action anyone wants here.
  log(
    [
      "",
      "UNINSTALL COMPLETE. Everything this tool added is gone.",
      "  Meter:       removed, the background helper is gone",
      "  Claude Code: usage reporting settings removed (backup saved)",
      "  Codex:       MarginFront block and cap check removed (backups saved)",
      purge
        ? `  Purged:      ${CONFIG_DIR} is deleted, including your saved secret key`
        : `  Kept:        your settings and secret key at ${ENV_PATH}`,
      `Reinstall anytime, from the root of your MarginFront source checkout: ${CCC_SOURCE_INIT_COMMAND}`,
    ].join("\n"),
  );
  return 0;
}

// --- dispatch ---------------------------------------------------------------
async function main(): Promise<number | null> {
  const argv: string[] = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);
  const flags = new Set<string>(rest.filter((a) => a.startsWith("--")));
  const positionals: string[] = rest.filter((a) => !a.startsWith("--"));
  const foldCache = flags.has("--fold-cache");

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "version":
    case "--version":
    case "-v":
      console.log(readVersion());
      return 0;
    case "init":
      return cmdInit(flags.has("--no-prompt"), flags.has("--control"), {
        apiUrl: flagValue(rest, "--api-url"),
      });
    case "start":
      return cmdStart();
    case "status":
      return cmdStatus();
    case "work":
      return cmdWork(rest);
    case "done":
      return await cmdDone(rest);
    case "preview":
      return cmdPreview(positionals, foldCache);
    case "run":
      return cmdRun(foldCache, flags.has(LOG_TO_FILES_FLAG));
    case "stop":
      return cmdStop();
    case "uninstall":
      return await cmdUninstall(flags.has("--purge"));
    default:
      console.error(`Unknown command "${command}".\n`);
      printHelp();
      return 1;
  }
}

// ENTRY-POINT GUARD - only invoke main() when this file is the program being run,
// NOT when another module (e.g. a Vitest test) imports it to use cmdRun /
// runningForwarderPid. Without this guard, importing cli.ts triggers main() which
// calls process.exit(0), crashing the test suite.
//
// We resolve symlinks on both sides (realpathSync) so a symlinked bin entry
// still works even though npm's bin directory is a symlink to the real file.
const __thisFile = fileURLToPath(import.meta.url);
let __isEntryPoint = false;
try {
  __isEntryPoint =
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(__thisFile);
} catch {
  // Unresolvable path (e.g. piped stdin invocation) - don't auto-run.
}

// Short commands set process.exitCode and let the loop drain instead of calling
// process.exit: on Windows, process.exit during teardown races libuv's async-signal
// path (UV_HANDLE_CLOSING in src/win/async.c: a background thread signals a handle
// the exit already began closing) and the assertion fires after everything has
// printed. It is a teardown race, not a pipe problem: closing the app-server child's
// pipes is not the trigger, so "fixing the pipes" would not fix this. An orderly
// drain runs platform tasks before handles close. The unref'd timer is the backstop
// for a leaked handle; an exit a few seconds late beats a command that never
// returns. cmdRun's signal handler keeps its process.exit on purpose: a daemon with
// live intervals cannot drain.
export const DRAIN_SAFETY_NET_MS = 5_000;

export function armDrainSafetyNet(
  code: number,
  timeoutMs: number = drainSafetyNetMs(),
): void {
  setTimeout(() => process.exit(code), timeoutMs).unref();
}

function drainSafetyNetMs(): number {
  const raw = Number(process.env.CCC_DRAIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DRAIN_SAFETY_NET_MS;
}

if (__isEntryPoint) {
  main()
    .then((code) => {
      // null = a long-running command (run) holding the process open on purpose; don't exit.
      if (code === null || code === undefined) return;
      process.exitCode = code;
      armDrainSafetyNet(code);
    })
    .catch((unexpectedError: unknown) => {
      console.error(
        `Something went wrong: ${(unexpectedError as Error).message}`,
      );
      process.exitCode = 1;
      armDrainSafetyNet(1);
    });
}
