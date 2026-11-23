// control.ts - Spend Control: the OPT-IN spend-cap brake that
// installs on the developer's machine. Three jobs, kept apart from the telemetry
// plumbing on purpose:
//   1. Materialize the local cap-check script (the ONE file devs + their agents
//      read before trusting the install) into ~/.marginfront-ccc/control/.
//   2. Wire a PreToolUse hook into ~/.claude/settings.json (USER scope, never
//      per-repo) with the same consent-gated, uninstall-clean ownership discipline
//      the telemetry keys use.
//   3. On the daemon's cadence, pull the read-back (caps + spend) and
//      write the two small files the hook reads. The hook does ZERO network I/O.
//
// Enforcement is honestly bounded (these are product decisions):
//   - Only ENFORCE-mode caps with providerScope 'all' ever block. Provider-scoped
//     caps are track-only on the device (blocking them against a TOTAL would
//     over-block), track-mode caps block nothing anywhere.
//   - Fail-open is absolute: missing / corrupt / stale state, or ANY script error,
//     never blocks. The only block path is files-present + parse-clean + an
//     'all'-scope enforce cap at/over its limit (or an active cool-off window).

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  copyFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  codexHooksList,
  codexDoctorConfigLoad,
  type CodexListedHook,
} from "./codex-app-server";
import { resolveBinaryOnPath } from "./binary-path";
import {
  controlBaseUrl,
  resolveConfiguredServer,
  sendToServer,
} from "./server-url";
import {
  WINDOWS_CAP_CHECK_SCRIPT,
  WINDOWS_CAP_SCRIPT_FILENAME,
  isWindows,
  windowsCapHookCommand,
  windowsCodexCapHookCommand,
} from "./windows-control";

type LogFn = (message: string) => void;

// Where the Codex telemetry writer parks the untouched original config.toml. Spelled
// out here rather than imported: connector.ts sits downstream of this file and
// importing it back would make a loop.
const CODEX_CONFIG_BACKUP_HINT = join(
  homedir(),
  ".codex",
  "config.toml.ccc-bak",
);

// Codex's own settings file. Spelled out here for the same reason as the line above.
// The status check reads it (never writes it) to answer one question hooks/list
// cannot: are Codex hooks switched off machine-wide?
const CODEX_CONFIG_FILE = join(homedir(), ".codex", "config.toml");

// The closed cap vocabularies, mirrored from the ONE source of truth in the
// platform: packages/db/src/lib/cap-policy.ts (CAP_MODES / CAP_PERIODS /
// CAP_SCOPES / CAP_PROVIDER_SCOPE_ALL). Mirrored, NOT imported: code-cost-clarity
// is a standalone customer-installed package and must never take a workspace
// dependency on @marginfront/db. Keep these in sync with that file if the platform
// ever adds a mode/period/scope.
export const CAP_MODE_ENFORCE = "enforce";
export const CAP_PROVIDER_SCOPE_ALL = "all";
export const CAP_PERIODS = ["day", "week", "month"] as const;
export type CapPeriod = (typeof CAP_PERIODS)[number];

// WHERE CONTROL STATE LIVES - a subdir under the meter's own home so uninstall can wipe
// it as a unit and nothing here can ever land in a customer's repo. The three files
// the hook reads are all siblings of the script, which finds them via its own path.
export const CONFIG_DIR = join(homedir(), ".marginfront-ccc");
export const CONTROL_DIR = join(CONFIG_DIR, "control");
export const CONTROL_SCRIPT_PATH = join(
  CONTROL_DIR,
  isWindows() ? WINDOWS_CAP_SCRIPT_FILENAME : "check-cap.py",
);
export const CONTROL_POLICY_PATH = join(CONTROL_DIR, "policy.json");
export const CONTROL_SPENT_PATH = join(CONTROL_DIR, "spent.json");

// Claude Code's user-scope settings file - the SAME file the telemetry writer uses.
// User scope, never per-repo: the desktop app can start a session in ~/Downloads,
// so a repo-scoped cap would miss desktop sessions entirely.
export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// THE EIGHT TELEMETRY VARIABLES we manage in settings.json - and ONLY these.
// This is deliberately NOT the API key: the secret stays in ~/.marginfront-ccc/.env
// (mode 0600) and must never be written into a settings file. Seven of them turn on
// Claude Code's usage broadcast (metrics + the event stream) and point it at the
// local collector; the eighth, OTEL_LOG_TOOL_DETAILS, makes Claude Code attach the
// MCP server + tool name to each tool event so paid MCP tools can be told apart from
// free ones. One frozen constant, so the writer, the reverter, and the
// Claude presence gate below agree on the same set. Lives here rather than in
// connector.ts because that file sits downstream of this one.
export const CCC_OWNED_TELEMETRY_KEYS: readonly string[] = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_TOOL_DETAILS",
];

// When an uninstall step leaves settings.json with nothing in it, nothing of the
// user's is in the file, so drop it, and the ~/.claude folder when nothing else is in it. Any other folder
// name is left alone: a test's temp dir is not ours to remove.
export function deleteEmptiedClaudeSettings(settingsPath: string): void {
  rmSync(settingsPath, { force: true });
  const dir = dirname(settingsPath);
  if (basename(dir) !== ".claude") return;
  try {
    rmdirSync(dir);
  } catch {
    // Something else lives there; leave it.
  }
}

// Our private receipt of the exact PreToolUse entry we added, so uninstall removes
// ONLY our hook (matched by its command string) and never a user's own hook. Same
// "uninstall removes only what we added" contract as the telemetry keys, kept in a
// SEPARATE receipt so extending Control never disturbs the telemetry owned-keys pins.
export const CONTROL_HOOK_OWNERSHIP_PATH = join(
  CONFIG_DIR,
  "claude-control-hook-owned.json",
);

// The command string Claude Code runs before every tool call. Absolute path (user
// scope has no project dir to anchor to) and python3. If python3 is missing the shell exits 127 - a NON-blocking error in
// Claude Code, so a machine without python3 fails open, it does not brick.
// On Windows the interpreter is node, for the reasons spelled out in the header of
// windows-control.ts - `python3` there is normally the Store stub, which would exit
// without running anything and hand the developer a cap that blocks nothing.
export function controlHookCommand(
  scriptPath: string = CONTROL_SCRIPT_PATH,
  nodePlatform: string = platform(),
): string {
  if (isWindows(nodePlatform)) return windowsCapHookCommand(scriptPath);
  return `python3 "${scriptPath}"`;
}

// --- Codex arm -------------------------------------------------

// The shell wrapper Codex runs. It lives beside check-cap.py so it can find it
// without anything being templated in - see CODEX_CAP_HOOK_WRAPPER for why that
// matters.
export const CODEX_CAP_HOOK_WRAPPER_PATH = join(
  CONTROL_DIR,
  "codex-cap-hook.sh",
);

// Codex's own hook registry. A SEPARATE file, never an inline [hooks] block in
// config.toml: a schema error inside config.toml is a fatal
// config-load error that breaks every Codex session, while the identical error in
// hooks.json leaves Codex working and only reports a warning.
export const CODEX_HOOKS_PATH = join(homedir(), ".codex", "hooks.json");

// Our private receipt of the exact Codex hook entry we added. Separate from the
// Claude receipt so the two arms can be installed, upgraded, and removed apart.
export const CODEX_CONTROL_HOOK_OWNERSHIP_PATH = join(
  CONFIG_DIR,
  "codex-control-hook-owned.json",
);

// Part of the frozen hook entry - see THE TRUST CONTRACT below before editing.
export const CODEX_HOOK_STATUS_MESSAGE = "Checking your MarginFront spend cap";

// Codex gives up on a hook that takes longer than this and lets the tool call
// through (a timed-out hook logs "PreToolUse Failed" and the tool
// still runs). The check itself takes about 0.04s per fire.
// Part of the frozen hook entry - see THE TRUST CONTRACT below before editing.
export const CODEX_HOOK_TIMEOUT_SECONDS = 10;

// THE TRUST CONTRACT (read before touching anything the hook entry is built from).
//
// Codex keys its "the user reviewed and trusted this hook" record to a hash of the
// WHOLE hook ENTRY, not only the command. Checked against codex-cli 0.145.0 in
// a throwaway CODEX_HOME: changing only `timeout` 10 -> 11 moved currentHash, and
// changing only `statusMessage` moved it again. So all five fields the entry carries
// are frozen - matcher, type, command, timeout, statusMessage - and editing any one
// of them silently un-trusts the hook on every machine that already armed it. Those
// developers keep metering but stop pausing, and nothing tells them: Codex silently skips
// an untrusted hook without a word.
//
// Only the wrapper BODY is free to change; it is not hashed. Ship a new script as
// often as you like. Change a hashed field only on purpose, with a release note that
// tells people to run /hooks again. Literal-pinned tests guard all five fields.
//
// The command string itself:
//
// /bin/sh, absolute, is deliberate. `python3 <missing file>` exits 2, and Codex reads
// exit 2 as "stop the tool call" - so a bare python3 command here would turn a
// deleted script into a permanently stuck machine. /bin/sh exits 127/126 instead,
// which Codex lets through.
//
// WINDOWS HAS ITS OWN FROZEN ENTRY, and the two never meet. Its command runs the cap
// script through node and no wrapper at all, because node returns 1 - never 2 - for
// a missing file, a syntax error, or an uncaught throw, so the accidental-stop trap
// the /bin/sh wrapper exists to absorb cannot happen there. The four other hashed
// fields are shared, so nothing about an already-armed Mac moves: same matcher, same
// type, same timeout, same statusMessage, same command, same hash, still trusted.
export function codexControlHookCommand(
  wrapperPath: string = CODEX_CAP_HOOK_WRAPPER_PATH,
  nodePlatform: string = platform(),
): string {
  if (isWindows(nodePlatform)) return windowsCodexCapHookCommand(wrapperPath);
  return `/bin/sh "${wrapperPath}"`;
}

// ===========================================================================
// THE CAP-CHECK SCRIPT
// ---------------------------------------------------------------------------
// This string is materialized verbatim to ~/.marginfront-ccc/control/check-cap.py.
// It is the product's trust surface: developers and their coding agents read it
// before agreeing to install (agents refuse policies they can't verify are safe),
// so its comments are load-bearing and it stays ONE small, self-contained file with
// no dependencies and no network. Byte-identical on every machine - it locates its
// own state files relative to itself, so nothing machine-specific is baked in.
// ===========================================================================
export const CAP_CHECK_SCRIPT = `#!/usr/bin/env python3
# MarginFront Code Cost Control - device cap check (opt-in, installed by
# \`node ~/.marginfront-ccc/cli.js init --control\`).
#
# Claude Code runs this before every tool call. Codex runs it too, through the small
# shell wrapper that sits next to this file (codex-cap-hook.sh). It reads two small
# local files the MarginFront meter wrote next to it - the spend policy and the
# latest spend totals - and does exactly one thing: if an ENFORCE cap covering ALL
# providers is at or over its limit, it stops that tool call (exit 2 + a message).
# Anything else exits 0 and the tool runs normally.
#
# It makes NO network calls and writes NOTHING except its own cool-off marker.
# Only exit code 2 stops a tool call; EVERY error path here exits 0, so a missing,
# corrupt, or stale file - or any bug in this script - can never stop your machine.
# That is the fail-open promise, and it is deliberate.
#
# "--surface codex" changes exactly one thing: WHERE the stop message goes. Codex
# rejects the reply format Claude Code uses, so the wrapper reads this script's
# stdout instead. On a stop we print one marker line, then the same message, and the
# wrapper copies the message to stderr, which is where Codex reads it. The marker is
# what makes the wrapper safe: a stray exit 2 from a broken interpreter has no marker
# line, so the wrapper treats it as "let the tool call through".
import json, os, sys, time

# The one-line handshake between this script and codex-cap-hook.sh. Change it here
# and you must change it in the wrapper too, or every stop turns into a pass.
CODEX_DENY_MARKER = "MF_CCC_CODEX_STOP_V1"

HERE = os.path.dirname(os.path.abspath(__file__))
POLICY_PATH = os.path.join(HERE, "policy.json")
SPENT_PATH = os.path.join(HERE, "spent.json")
TRIP_PATH = os.path.join(HERE, "trip.json")

# If the meter has not refreshed spend within this many seconds, the numbers are
# stale and we do NOT enforce - a dead or offline meter must never keep blocking
# forever. Freshness is the file's own write time (local clock on both sides), so it
# needs no agreement between your clock and the server's.
STALE_SECONDS = 3600


def _load(path):
    with open(path) as fh:
        return json.load(fh)


def _surface():
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--surface" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--surface="):
            return arg.split("=", 1)[1]
    return "claude"


SURFACE = _surface()


def _block(message):
    if SURFACE == "codex":
        # The wrapper splits this on the first newline.
        sys.stdout.write(CODEX_DENY_MARKER + "\\n" + message)
    else:
        sys.stderr.write(message)
    sys.exit(2)


def main():
    if SURFACE == "codex":
        # Codex writes the tool-call event to our stdin. We need nothing from it, but
        # we read it so Codex is never left writing into a pipe nobody is reading.
        try:
            sys.stdin.read()
        except Exception:
            pass

    # No policy / no spend file yet, or either unreadable -> nothing to enforce.
    try:
        policy = _load(POLICY_PATH)
        spent = _load(SPENT_PATH)
    except Exception:
        sys.exit(0)

    # Stale spend -> fail open.
    try:
        if time.time() - os.path.getmtime(SPENT_PATH) > STALE_SECONDS:
            sys.exit(0)
    except Exception:
        sys.exit(0)

    caps = policy.get("caps") or []
    by_period = spent.get("byPeriod") or {}
    now = time.time()

    try:
        trip = _load(TRIP_PATH)
    except Exception:
        trip = {}

    for cap in caps:
        # Belt-and-suspenders next to the daemon's own filter: ONLY all-provider
        # enforce caps can ever block here, whatever the meter wrote. Provider-scoped
        # caps and track-mode caps never stop you.
        if cap.get("providerScope") != "all" or cap.get("mode") != "enforce":
            continue

        cap_id = cap.get("id")
        amount = cap.get("amountUsd")
        period = cap.get("period")
        scope = cap.get("scope")  # 'org' or 'dev' - which spend total to compare
        cool_off_hours = cap.get("coolOffHours")
        if amount is None or period not in by_period:
            continue

        bucket = by_period[period]
        window_end = bucket.get("windowEndEpoch")
        spent_usd = (bucket.get(scope) or {}).get("spentUsd")

        # Active cool-off from an earlier trip: keep braking until the cool-off hours
        # pass OR the spend window rolls, whichever comes first.
        marker = trip.get(cap_id)
        if marker:
            limits = []
            coh = marker.get("coolOffHours")
            if coh is not None:
                limits.append(marker.get("trippedAt", 0) + coh * 3600)
            we = marker.get("windowEndEpoch")
            if we is not None:
                limits.append(we)
            if limits and now < min(limits):
                _block(_message(cap, spent_usd, cooloff_until=min(limits)))

        # Honest null: absent spend is absent, never a coerced 0 - it never blocks.
        if spent_usd is None:
            continue

        if spent_usd >= amount:
            if cool_off_hours is not None and cap_id is not None and cap_id not in trip:
                trip[cap_id] = {
                    "trippedAt": now,
                    "windowEndEpoch": window_end,
                    "coolOffHours": cool_off_hours,
                }
                try:
                    with open(TRIP_PATH, "w") as fh:
                        json.dump(trip, fh)
                except Exception:
                    pass  # a marker we could not persist must not turn a block into a crash
            _block(_message(cap, spent_usd))

    sys.exit(0)


def _message(cap, spent_usd, cooloff_until=None):
    amount = cap.get("amountUsd")
    period = cap.get("period")
    spent_txt = "an unknown amount" if spent_usd is None else ("$%s" % spent_usd)
    if cooloff_until is not None:
        head = (
            "Code Cost Control: your team's %s spend cap of $%s tripped and is in a "
            "cool-off window right now." % (period, amount)
        )
    else:
        head = (
            "Code Cost Control: your team's %s spend cap of $%s is reached "
            "(about %s spent so far)." % (period, amount, spent_txt)
        )
    lines = [head]
    why = cap.get("whyNote")
    if why:
        lines.append("Note from your admin: %s" % why)
    lines.append(
        "Your team's admin set this cap; to keep going, contact your admin to raise "
        "or reset it."
    )
    lines.append(
        "This is your team's spend cap, not the AI declining - the model itself did "
        "not refuse this."
    )
    return "\\n".join(lines) + "\\n"


if __name__ == "__main__":
    # The last line of the fail-open promise. sys.exit raises SystemExit, which is
    # NOT an Exception, so a real stop still gets out of here with code 2.
    try:
        main()
    except Exception:
        sys.exit(0)
`;

// ===========================================================================
// THE CODEX WRAPPER
// ---------------------------------------------------------------------------
// Codex runs this shell file, NOT check-cap.py directly. Codex treats exit 2 as "stop
// the tool call", and `python3 <a missing or unreadable file>` ALSO exits 2 - so a
// bare python3 hook command would turn an uninstall into a machine where every tool
// call is stopped forever, with no message. /bin/sh exits 127/126 there instead, and
// Codex lets those through.
//
// The rule this file enforces: the ONLY way out with exit 2 is a real over-cap
// decision, proven by the marker line the cap script prints. Everything else exits 0.
//
// SHIPPED AS STATIC BYTES - nothing is templated in, because the one remaining way
// /bin/sh exits 2 on its own is a syntax error, and a templated path with a stray
// quote is how one would ever get here.
// ===========================================================================
export const CODEX_CAP_HOOK_WRAPPER = `#!/bin/sh
# MarginFront Code Cost Control - Codex tool-call cap check.
# Installed by \`node ~/.marginfront-ccc/cli.js init --control\`; removed by
# \`node ~/.marginfront-ccc/cli.js uninstall\`.
#
# Codex runs this before a tool call. Exit 0 means "go ahead" and exit 2 means "stop
# this tool call". Every failure path below exits 0 on purpose: if anything about the
# cap check is broken, you keep working.

MF_CCC_STOP_MARKER="MF_CCC_CODEX_STOP_V1"

nl='
'

case $0 in
  */*) here=\${0%/*} ;;
  *) here=. ;;
esac
core="$here/check-cap.py"

if [ ! -r "$core" ]; then
  # No cap script (or we cannot read it). Drain the event Codex is writing to us so
  # it is not left writing into a closed pipe, then let the tool call through.
  while read -r _mf_ccc_line; do :; done
  exit 0
fi

# The cap script's own stderr is dropped: on a stop, the message we want rides its
# stdout after the marker line, so anything on stderr here is noise from a broken run.
out=$(python3 "$core" --surface codex 2>/dev/null)
rc=$?

if [ "$rc" -eq 2 ]; then
  marker=\${out%%"$nl"*}
  reason=\${out#*"$nl"}
  # "$reason" = "$out" means there was no newline, so there is no message - which
  # means this was not our stop. Let it through.
  if [ "$marker" = "$MF_CCC_STOP_MARKER" ] && [ "$reason" != "$out" ]; then
    printf '%s\\n' "$reason" >&2
    exit 2
  fi
fi

exit 0
`;

// ---------------------------------------------------------------------------
// tiny local helpers (kept here so control.ts stays self-contained and does not
// widen connector.ts's export surface for two three-line functions)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Copy a settings file to "<path>.ccc-bak" before we touch it, matching the
// telemetry writer's backup convention so a curious dev sees one predictable name.
function backupSettings(settingsPath: string): string {
  const backupPath = `${settingsPath}.ccc-bak`;
  copyFileSync(settingsPath, backupPath);
  return backupPath;
}

// Write JSON to a temp sibling then rename over the target, so the hook can never
// read a half-written file (a torn read would only fail-open anyway, but this keeps
// it clean). 2-space indent + trailing newline to match the rest of the package.
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// script install / removal
// ---------------------------------------------------------------------------

// Materialize the cap-check script to disk. Idempotent - a re-run rewrites the
// same bytes.
export function writeControlScript(
  scriptPath: string = CONTROL_SCRIPT_PATH,
  nodePlatform: string = platform(),
): void {
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(
    scriptPath,
    isWindows(nodePlatform) ? WINDOWS_CAP_CHECK_SCRIPT : CAP_CHECK_SCRIPT,
  );
}

// Mode 0755: Codex runs this through a shell, and a wrapper it cannot read is one of
// the very failure modes the wrapper exists to absorb.
// A no-op on Windows: node's exit codes already give the "only a real over-cap
// decision exits 2" property this wrapper buys on Unix, so Codex runs the same
// check-cap.mjs the Claude hook does and no wrapper is left for uninstall to find.
export function writeCodexCapHookWrapper(
  wrapperPath: string = CODEX_CAP_HOOK_WRAPPER_PATH,
  nodePlatform: string = platform(),
): void {
  if (isWindows(nodePlatform)) return;
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeFileSync(wrapperPath, CODEX_CAP_HOOK_WRAPPER, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// PreToolUse hook wiring in ~/.claude/settings.json
// ---------------------------------------------------------------------------

export interface WriteControlHookResult {
  action: "added" | "already-present";
  backupPath: string | null;
}

export interface RemoveControlHookResult {
  action: "removed" | "not-found";
  backupPath: string | null;
}

// The exact PreToolUse entry we add. matcher "*" = every tool, so an over-cap stops
// the agent's whole tool surface, not only Bash.
function controlHookEntry(command: string): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [{ type: "command", command }],
  };
}

// Does this PreToolUse array entry contain OUR command? (Identity for a clean,
// surgical uninstall - we never remove an entry we did not write.)
function entryHasCommand(entry: unknown, command: string): boolean {
  if (!isPlainObject(entry)) return false;
  const inner = entry.hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => isPlainObject(h) && h.command === command);
}

// ADD our PreToolUse hook to ~/.claude/settings.json - safely, merging into any
// existing hooks the user or another tool already installed. Refuses (throws) to
// overwrite a settings file it cannot parse or whose hooks block is the wrong shape,
// exactly like the telemetry writer: corrupting a user's global config is the worst
// possible outcome. Records our command in a private receipt for uninstall.
export function writeControlHook({
  settingsPath = CLAUDE_SETTINGS_PATH,
  ownershipPath = CONTROL_HOOK_OWNERSHIP_PATH,
  scriptPath = CONTROL_SCRIPT_PATH,
  log = console.log,
}: {
  settingsPath?: string;
  ownershipPath?: string;
  scriptPath?: string;
  log?: LogFn;
} = {}): WriteControlHookResult {
  const command = controlHookCommand(scriptPath);

  let settings: Record<string, unknown> = {};
  const fileExists = existsSync(settingsPath);
  if (fileExists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      const backupPath = backupSettings(settingsPath);
      throw new Error(
        `Could not update ${settingsPath}.\n` +
          "What happened: your Claude Code settings file isn't valid JSON, so we " +
          "stopped instead of risking your settings.\n" +
          `What we did: saved an untouched copy at ${backupPath}.\n` +
          "Fix: repair the JSON (often a trailing comma or a missing quote), then " +
          "run init --control again.",
      );
    }
    if (!isPlainObject(parsed)) {
      const backupPath = backupSettings(settingsPath);
      throw new Error(
        `Could not update ${settingsPath}.\n` +
          "What happened: the top level of your Claude Code settings file isn't a " +
          "JSON object, so there's nowhere safe to add the cap-check hook.\n" +
          `What we did: saved an untouched copy at ${backupPath}.\n` +
          'Fix: make the file a normal JSON object like { "hooks": { ... } }, then ' +
          "run init --control again.",
      );
    }
    settings = parsed;
  }

  if ("hooks" in settings && !isPlainObject(settings.hooks)) {
    const backupPath = backupSettings(settingsPath);
    throw new Error(
      `Could not update ${settingsPath}.\n` +
        'What happened: your settings file has a "hooks" entry that isn\'t a block ' +
        "of hook settings, so we stopped instead of overwriting it.\n" +
        `What we did: saved an untouched copy at ${backupPath}.\n` +
        'Fix: change "hooks" to a normal object (or remove it), then run ' +
        "init --control again.",
    );
  }

  const hooks: Record<string, unknown> = isPlainObject(settings.hooks)
    ? (settings.hooks as Record<string, unknown>)
    : {};

  if ("PreToolUse" in hooks && !Array.isArray(hooks.PreToolUse)) {
    const backupPath = backupSettings(settingsPath);
    throw new Error(
      `Could not update ${settingsPath}.\n` +
        "What happened: your settings file has a hooks.PreToolUse entry that isn't " +
        "a list, so we stopped instead of overwriting it.\n" +
        `What we did: saved an untouched copy at ${backupPath}.\n` +
        "Fix: make hooks.PreToolUse a list (or remove it), then run " +
        "init --control again.",
    );
  }

  const preToolUse: unknown[] = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as unknown[])
    : [];

  // Already ours? Idempotent no-op (re-record ownership so the receipt is current).
  if (preToolUse.some((entry) => entryHasCommand(entry, command))) {
    writeControlHookOwnership(ownershipPath, command);
    log(`Cap-check hook already present in ${settingsPath}.`);
    return { action: "already-present", backupPath: null };
  }

  preToolUse.push(controlHookEntry(command));
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  const backupPath = fileExists ? backupSettings(settingsPath) : null;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  writeControlHookOwnership(ownershipPath, command);
  log(
    `Wired the cap-check hook into ${settingsPath}` +
      (backupPath ? ` (backup at ${backupPath}).` : "."),
  );
  return { action: "added", backupPath };
}

// REMOVE our PreToolUse hook - surgically. Removes ONLY the entry whose command
// equals what we recorded, leaving every other hook byte-identical. Prunes an empty
// PreToolUse array and an empty hooks block so we don't orphan `{}`. A missing file
// or receipt is a soft no-op (uninstall must never throw on a customer machine).
export function removeControlHook({
  settingsPath = CLAUDE_SETTINGS_PATH,
  ownershipPath = CONTROL_HOOK_OWNERSHIP_PATH,
  scriptPath = CONTROL_SCRIPT_PATH,
  log = console.log,
}: {
  settingsPath?: string;
  ownershipPath?: string;
  scriptPath?: string;
  log?: LogFn;
} = {}): RemoveControlHookResult {
  const command =
    readControlHookOwnership(ownershipPath) ?? controlHookCommand(scriptPath);

  // Always drop the script + receipt at the end, even if settings.json is already
  // clean - "removed completely" means no residue.
  const cleanupArtifacts = (): void => {
    if (existsSync(scriptPath)) rmSync(scriptPath, { force: true });
    if (existsSync(ownershipPath)) rmSync(ownershipPath, { force: true });
  };

  if (!existsSync(settingsPath)) {
    cleanupArtifacts();
    log(
      `No ${settingsPath} to clean - removed the cap-check script and record instead.`,
    );
    return { action: "not-found", backupPath: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    log(
      `Couldn't undo the cap-check hook cleanly: ${settingsPath} isn't valid JSON ` +
        "right now, so we left it untouched. Fix the JSON and re-run uninstall, or " +
        "remove the hook by hand.",
    );
    cleanupArtifacts();
    return { action: "not-found", backupPath: null };
  }
  if (!isPlainObject(parsed)) {
    log(
      `Couldn't undo the cap-check hook cleanly: ${settingsPath} isn't a JSON ` +
        "object, so we left it untouched.",
    );
    cleanupArtifacts();
    return { action: "not-found", backupPath: null };
  }

  const settings = parsed;
  const hooks = isPlainObject(settings.hooks)
    ? (settings.hooks as Record<string, unknown>)
    : null;
  const preToolUse =
    hooks && Array.isArray(hooks.PreToolUse)
      ? (hooks.PreToolUse as unknown[])
      : null;

  let removed = false;
  if (hooks && preToolUse) {
    const kept = preToolUse.filter((entry) => !entryHasCommand(entry, command));
    if (kept.length !== preToolUse.length) {
      removed = true;
      if (kept.length > 0) {
        hooks.PreToolUse = kept;
      } else {
        delete hooks.PreToolUse;
      }
      if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
      }
    }
  }

  let backupPath: string | null = null;
  if (removed && Object.keys(settings).length === 0) {
    deleteEmptiedClaudeSettings(settingsPath);
    log(
      `Removed the cap-check hook from ${settingsPath}. Nothing else was in that file, so I deleted it.`,
    );
  } else if (removed) {
    backupPath = backupSettings(settingsPath);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    log(
      `Removed the cap-check hook from ${settingsPath} (backup at ${backupPath}).`,
    );
  } else {
    log(
      `Nothing to remove from ${settingsPath} - the cap-check hook was already gone.`,
    );
  }

  cleanupArtifacts();
  return { action: removed ? "removed" : "not-found", backupPath };
}

// The receipt is the exact command string we wrote. Small on purpose: the
// command is the identity we match on for a surgical removal.
interface ControlHookOwnership {
  command: string;
}

function writeControlHookOwnership(
  ownershipPath: string,
  command: string,
): void {
  mkdirSync(dirname(ownershipPath), { recursive: true });
  const payload: ControlHookOwnership & { _comment: string } = {
    _comment:
      "MarginFront code-cost-clarity added a PreToolUse cap-check hook to your " +
      "Claude Code settings.json. Uninstall removes ONLY the hook whose command " +
      "matches the one below. Safe to delete by hand if you've already cleaned up " +
      "settings.json yourself.",
    command,
  };
  writeFileSync(ownershipPath, JSON.stringify(payload, null, 2) + "\n");
}

function readControlHookOwnership(ownershipPath: string): string | null {
  if (!existsSync(ownershipPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownershipPath, "utf8"));
    if (isPlainObject(parsed) && typeof parsed.command === "string") {
      return parsed.command;
    }
    return null;
  } catch {
    return null;
  }
}

// True once init --control has wired the hook (the receipt exists). Gates BOTH the
// daemon's control pull and the armed-status telemetry stamp, so a metering-only
// install never touches the control API and stamps nothing.
export function isControlArmed(
  ownershipPath: string = CONTROL_HOOK_OWNERSHIP_PATH,
): boolean {
  return existsSync(ownershipPath);
}

// ---------------------------------------------------------------------------
// Codex PreToolUse hook wiring in ~/.codex/hooks.json
// ---------------------------------------------------------------------------

// THE STRICT-MINIMAL ENTRY. Codex's hooks file accepts exactly two top-level keys
// ("description" and "hooks"), and older CLI builds reject fields they don't know by
// refusing to register the whole file. So we write the smallest entry that works and
// nothing else - no description, no comment, no version stamp. In
// codex-cli 0.145.0 this shape registers as source "user", enabled true.
//
// matcher "*" = every tool, which covers shell commands,
// file edits, and MCP tool calls alike.
//
// EVERY FIELD BELOW IS HASHED into Codex's trust record (THE TRUST CONTRACT, above).
// Editing matcher, type, command, timeout, or statusMessage un-trusts the hook on
// every armed machine, silently. Literal-pinned tests fail if any of them moves.
function codexHookGroup(command: string): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command,
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
        statusMessage: CODEX_HOOK_STATUS_MESSAGE,
      },
    ],
  };
}

// Is this hooks.json group one of ours? Identity is the command string, same as the
// Claude side, so we can never remove a hook someone else wrote.
function codexGroupHasCommand(group: unknown, command: string): boolean {
  if (!isPlainObject(group)) return false;
  const inner = group.hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => isPlainObject(h) && h.command === command);
}

// Windows has no execute bit: a bare `codex` on PATH is really codex.cmd or
// codex.exe. The empty suffix stays for npm's extensionless shim. These answer
// "is it there", not "can we run it" - binary-path.ts keeps the shorter spawn list.
const WINDOWS_CODEX_SUFFIXES = ["", ".cmd", ".exe", ".bat", ".ps1"];
const WINDOWS_CLAUDE_SUFFIXES = ["", ".cmd", ".exe"];

// Is Codex on this machine at all? Two honest signals: its config directory exists,
// or its binary is on PATH. Codex being absent is a NORMAL state, not an error - we
// say one line and move on.
export function isCodexInstalled({
  codexDir = dirname(CODEX_HOOKS_PATH),
  pathEnv = process.env.PATH ?? "",
  platform = process.platform,
}: {
  codexDir?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
} = {}): boolean {
  if (existsSync(codexDir)) return true;
  return (
    resolveBinaryOnPath("codex", WINDOWS_CODEX_SUFFIXES, pathEnv, platform) !==
    null
  );
}

// The files this package writes under ~/.claude: the settings file and the backup
// the writer keeps beside it. Neither says Claude Code is installed.
const CCC_CLAUDE_DIR_ARTIFACTS = new Set([
  "settings.json",
  "settings.json.ccc-bak",
]);

// Windows spells one file several ways: every path segment there is
// case-insensitive, and "\\" and "/" both separate. Our own hook command therefore
// has to compare equal to itself across those spellings, or a receipt written with
// one spelling makes the hook we wrote look like a stranger's and the gate decides
// Claude Code is installed when it is not. Posix stays exact - there the two
// spellings really are two different files.
function capHookCommandsMatch(
  found: string,
  ours: string,
  nodePlatform: NodeJS.Platform,
): boolean {
  if (found === ours) return true;
  if (!isWindows(nodePlatform)) return false;
  const spelledTheSame = (value: string): string =>
    value.replace(/\\/g, "/").toLowerCase();
  return spelledTheSame(found) === spelledTheSame(ours);
}

function hooksBlockIsOnlyOurs(
  hooks: unknown,
  capHookCommand: string,
  nodePlatform: NodeJS.Platform,
): boolean {
  if (!isPlainObject(hooks)) return false;
  if (Object.keys(hooks).some((event) => event !== "PreToolUse")) return false;
  const preToolUse = hooks.PreToolUse;
  if (!Array.isArray(preToolUse)) return false;
  return preToolUse.every(
    (entry) =>
      isPlainObject(entry) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.every(
        (h) =>
          isPlainObject(h) &&
          typeof h.command === "string" &&
          capHookCommandsMatch(h.command, capHookCommand, nodePlatform),
      ),
  );
}

// Does ~/.claude hold anything Claude Code itself put there? Claude Code creates
// projects/, statsig/, todos/ and ~/.claude.json on first run. A directory holding
// only our settings.json, whose contents are only our telemetry env block and our
// cap-check hook, was written by this package and proves nothing.
function claudeDirShowsClaudeCode(
  claudeDir: string,
  capHookCommand: string,
  nodePlatform: NodeJS.Platform,
): boolean {
  let entries: string[];
  try {
    entries = readdirSync(claudeDir);
  } catch {
    return false;
  }
  if (entries.some((entry) => !CCC_CLAUDE_DIR_ARTIFACTS.has(entry)))
    return true;
  if (!entries.includes("settings.json")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  } catch {
    return true;
  }
  if (!isPlainObject(parsed)) return true;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "env") {
      if (!isPlainObject(value)) return true;
      if (Object.keys(value).some((k) => !CCC_OWNED_TELEMETRY_KEYS.includes(k)))
        return true;
    } else if (key === "hooks") {
      if (!hooksBlockIsOnlyOurs(value, capHookCommand, nodePlatform))
        return true;
    } else {
      return true;
    }
  }
  return false;
}

// The Claude Code twin of isCodexInstalled. Without it a Codex-only machine would get a
// ~/.claude/settings.json it never asked for and a "how do you sign in to Claude?"
// question it could not answer. ~/.claude.json sits BESIDE ~/.claude, not inside it,
// and a fresh install can have only that file. The directory alone is not enough:
// this package's own files can be all it holds, so its contents have to show Claude
// Code was ever here.
export function isClaudeCodeInstalled({
  claudeDir = dirname(CLAUDE_SETTINGS_PATH),
  pathEnv = process.env.PATH ?? "",
  platform = process.platform,
  capHookCommand = readControlHookOwnership(CONTROL_HOOK_OWNERSHIP_PATH) ??
    controlHookCommand(),
}: {
  claudeDir?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  capHookCommand?: string;
} = {}): boolean {
  if (claudeDirShowsClaudeCode(claudeDir, capHookCommand, platform))
    return true;
  if (existsSync(join(dirname(claudeDir), ".claude.json"))) return true;
  return (
    resolveBinaryOnPath(
      "claude",
      WINDOWS_CLAUDE_SUFFIXES,
      pathEnv,
      platform,
    ) !== null
  );
}

export interface WriteCodexControlHookResult {
  action:
    | "added"
    | "already-present"
    | "skipped-no-codex"
    | "skipped-existing-file";
  backupPath: string | null;
}

export interface RemoveCodexControlHookResult {
  action: "removed" | "not-found" | "deleted-file";
  backupPath: string | null;
}

// ADD our PreToolUse hook to ~/.codex/hooks.json.
//
// Merge, never clobber: any hooks the developer already wrote come back out
// byte-identical. Idempotent: running init twice leaves exactly one entry of ours.
//
// Unlike the Claude writer this NEVER throws. Codex is the second arm; a hooks file
// we can't understand must not be able to abort someone's whole install. We say
// plainly what we skipped and why, and leave their file alone.
export function writeCodexControlHook({
  hooksPath = CODEX_HOOKS_PATH,
  ownershipPath = CODEX_CONTROL_HOOK_OWNERSHIP_PATH,
  wrapperPath = CODEX_CAP_HOOK_WRAPPER_PATH,
  codexInstalled,
  log = console.log,
}: {
  hooksPath?: string;
  ownershipPath?: string;
  wrapperPath?: string;
  codexInstalled?: boolean;
  log?: LogFn;
} = {}): WriteCodexControlHookResult {
  const present =
    codexInstalled ?? isCodexInstalled({ codexDir: dirname(hooksPath) });
  if (!present) {
    log(
      "Codex isn't on this machine, so there's nothing to wire up for it. " +
        "Install Codex later and re-run init --control to add the cap check there too.",
    );
    return { action: "skipped-no-codex", backupPath: null };
  }

  const command = codexControlHookCommand(wrapperPath);
  const fileExists = existsSync(hooksPath);

  let root: Record<string, unknown> = {};
  if (fileExists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
    } catch {
      log(
        `Left ${hooksPath} alone: it isn't valid JSON right now, and rewriting it ` +
          "could lose the hooks you wrote. Fix the JSON (often a trailing comma or a " +
          "missing quote), then run init --control again to add the Codex cap check.",
      );
      return { action: "skipped-existing-file", backupPath: null };
    }
    if (!isPlainObject(parsed)) {
      log(
        `Left ${hooksPath} alone: the top level isn't a JSON object, so there's ` +
          "nowhere safe to add the cap check. Make it an object like " +
          '{ "hooks": { ... } }, then run init --control again.',
      );
      return { action: "skipped-existing-file", backupPath: null };
    }
    root = parsed;
  }

  if ("hooks" in root && !isPlainObject(root.hooks)) {
    log(
      `Left ${hooksPath} alone: its "hooks" entry isn't a block of hook settings, ` +
        "so we stopped instead of overwriting it.",
    );
    return { action: "skipped-existing-file", backupPath: null };
  }
  const hooks: Record<string, unknown> = isPlainObject(root.hooks)
    ? (root.hooks as Record<string, unknown>)
    : {};

  if ("PreToolUse" in hooks && !Array.isArray(hooks.PreToolUse)) {
    log(
      `Left ${hooksPath} alone: its hooks.PreToolUse entry isn't a list, so we ` +
        "stopped instead of overwriting it.",
    );
    return { action: "skipped-existing-file", backupPath: null };
  }
  const preToolUse: unknown[] = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as unknown[])
    : [];

  if (preToolUse.some((group) => codexGroupHasCommand(group, command))) {
    writeCodexHookOwnership(ownershipPath, command);
    log(`Codex cap-check hook already present in ${hooksPath}.`);
    return { action: "already-present", backupPath: null };
  }

  preToolUse.push(codexHookGroup(command));
  hooks.PreToolUse = preToolUse;
  root.hooks = hooks;

  const backupPath = fileExists ? backupSettings(hooksPath) : null;
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, JSON.stringify(root, null, 2) + "\n");
  writeCodexHookOwnership(ownershipPath, command);
  log(
    `Wired the cap-check hook into ${hooksPath}` +
      (backupPath ? ` (backup at ${backupPath}).` : "."),
  );
  return { action: "added", backupPath };
}

// REMOVE our Codex hook - surgically. Only the entry whose command matches the one
// we recorded goes; everything else in the file survives byte-for-byte. If our entry
// was the ONLY thing in the file, the file goes too, because Codex never had a
// hooks.json before we made one.
export function removeCodexControlHook({
  hooksPath = CODEX_HOOKS_PATH,
  ownershipPath = CODEX_CONTROL_HOOK_OWNERSHIP_PATH,
  wrapperPath = CODEX_CAP_HOOK_WRAPPER_PATH,
  log = console.log,
}: {
  hooksPath?: string;
  ownershipPath?: string;
  wrapperPath?: string;
  log?: LogFn;
} = {}): RemoveCodexControlHookResult {
  const command =
    readControlHookOwnership(ownershipPath) ??
    codexControlHookCommand(wrapperPath);

  const cleanupArtifacts = (): void => {
    if (existsSync(wrapperPath)) rmSync(wrapperPath, { force: true });
    if (existsSync(ownershipPath)) rmSync(ownershipPath, { force: true });
  };

  if (!existsSync(hooksPath)) {
    cleanupArtifacts();
    log(
      `No ${hooksPath} to clean - removed the Codex cap-check wrapper and record instead.`,
    );
    return { action: "not-found", backupPath: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
  } catch {
    log(
      `Couldn't undo the Codex cap-check hook cleanly: ${hooksPath} isn't valid ` +
        "JSON right now, so we left it untouched. Fix the JSON and re-run uninstall, " +
        "or remove the hook by hand.",
    );
    cleanupArtifacts();
    return { action: "not-found", backupPath: null };
  }
  if (!isPlainObject(parsed)) {
    log(
      `Couldn't undo the Codex cap-check hook cleanly: ${hooksPath} isn't a JSON ` +
        "object, so we left it untouched.",
    );
    cleanupArtifacts();
    return { action: "not-found", backupPath: null };
  }

  const root = parsed;
  const hooks = isPlainObject(root.hooks)
    ? (root.hooks as Record<string, unknown>)
    : null;
  const preToolUse =
    hooks && Array.isArray(hooks.PreToolUse)
      ? (hooks.PreToolUse as unknown[])
      : null;

  let removed = false;
  if (hooks && preToolUse) {
    const kept = preToolUse.filter(
      (group) => !codexGroupHasCommand(group, command),
    );
    if (kept.length !== preToolUse.length) {
      removed = true;
      if (kept.length > 0) {
        hooks.PreToolUse = kept;
      } else {
        delete hooks.PreToolUse;
      }
      if (Object.keys(hooks).length === 0) delete root.hooks;
    }
  }

  if (!removed) {
    log(
      `Nothing to remove from ${hooksPath} - the Codex cap-check hook was already gone.`,
    );
    cleanupArtifacts();
    return { action: "not-found", backupPath: null };
  }

  // Our entry was the whole file. Codex had no hooks.json before we wrote one, so
  // leaving an empty "{}" behind would be residue.
  if (Object.keys(root).length === 0) {
    const backupPath = backupSettings(hooksPath);
    rmSync(hooksPath, { force: true });
    cleanupArtifacts();
    log(
      `Removed ${hooksPath} - the cap-check hook was the only thing in it ` +
        `(backup at ${backupPath}).`,
    );
    return { action: "deleted-file", backupPath };
  }

  const backupPath = backupSettings(hooksPath);
  writeFileSync(hooksPath, JSON.stringify(root, null, 2) + "\n");
  cleanupArtifacts();
  log(
    `Removed the Codex cap-check hook from ${hooksPath} (backup at ${backupPath}).`,
  );
  return { action: "removed", backupPath };
}

function writeCodexHookOwnership(ownershipPath: string, command: string): void {
  mkdirSync(dirname(ownershipPath), { recursive: true });
  const payload = {
    _comment:
      "MarginFront code-cost-clarity added a PreToolUse cap-check hook to your " +
      "Codex hooks.json. Uninstall removes ONLY the hook whose command matches the " +
      "one below. Safe to delete by hand if you've already cleaned up hooks.json " +
      "yourself.",
    command,
  };
  writeFileSync(ownershipPath, JSON.stringify(payload, null, 2) + "\n");
}

export function isCodexControlArmed(
  ownershipPath: string = CODEX_CONTROL_HOOK_OWNERSHIP_PATH,
): boolean {
  return existsSync(ownershipPath);
}

// ---------------------------------------------------------------------------
// Codex self-heal (runs on the daemon's cadence)
// ---------------------------------------------------------------------------

export interface HealCodexControlResult {
  // "not-armed"      - we never wired Codex up; nothing to check.
  // "unknown"        - we couldn't ask Codex (not installed, or it didn't answer).
  // "ok"             - Codex is reading our hook file fine.
  // "removed-hook"   - Codex could not parse the hook file, so we took our entry out.
  // "left-alone"     - Codex complained, but the file isn't ours to repair safely.
  action: "not-armed" | "unknown" | "ok" | "removed-hook" | "left-alone";
  reason?: string;
}

// THE FAIL-OPEN INSURANCE. A future Codex release could change the hooks file format
// under us. If that happens Codex refuses the WHOLE file - including any hooks the
// developer wrote themselves - and says so in a hooks/list warning. So once a cycle
// we ask, and if the complaint names our file we take our own entry back out. Their
// hooks start working again, our cap check stops working, and nothing is stuck.
//
// We also ask whether Codex can still load config.toml. We do NOT edit config.toml
// here - that file carries the telemetry block and a background process rewriting it
// on a heuristic is a bigger risk than the problem - we say it plainly, name the
// backup, and give the one command that undoes our part.
export async function healCodexControlState({
  hooksPath = CODEX_HOOKS_PATH,
  ownershipPath = CODEX_CONTROL_HOOK_OWNERSHIP_PATH,
  wrapperPath = CODEX_CAP_HOOK_WRAPPER_PATH,
  hooksList = codexHooksList,
  doctorConfigLoad = codexDoctorConfigLoad,
  log = () => {},
}: {
  hooksPath?: string;
  ownershipPath?: string;
  wrapperPath?: string;
  hooksList?: typeof codexHooksList;
  doctorConfigLoad?: typeof codexDoctorConfigLoad;
  log?: LogFn;
} = {}): Promise<HealCodexControlResult> {
  if (!isCodexControlArmed(ownershipPath)) {
    return { action: "not-armed" };
  }

  const listed = await hooksList({});
  if (!listed.ok) {
    return { action: "unknown", reason: listed.reason ?? "no-answer" };
  }

  const config = await doctorConfigLoad({});
  if (config.status === "failed") {
    log(
      "[control] Codex can't read its own config file right now, so no Codex " +
        `session will start until it's fixed (${config.summary ?? "no detail given"}). ` +
        "Your untouched copy from before we added our settings block is at " +
        `${CODEX_CONFIG_BACKUP_HINT}. To take our block out, run: ` +
        "node ~/.marginfront-ccc/cli.js uninstall",
    );
  }

  const complaint = listed.warnings.find((w) => w.includes(hooksPath));
  if (!complaint) {
    return { action: "ok" };
  }

  // Codex rejected the file. If we can still read it as JSON, the break is in the
  // SHAPE, which means our entry is the part we're allowed to take back.
  let readable = false;
  try {
    JSON.parse(readFileSync(hooksPath, "utf8"));
    readable = true;
  } catch {
    readable = false;
  }
  if (!readable) {
    log(
      `[control] Codex can't read ${hooksPath} (${complaint}). It isn't valid JSON, ` +
        "so we left it alone rather than risk losing the hooks you wrote. Fix the " +
        "JSON and Codex will pick it up again.",
    );
    return { action: "left-alone", reason: complaint };
  }

  log(
    `[control] Codex rejected ${hooksPath} (${complaint}). Taking the MarginFront ` +
      "cap check back out so your other Codex hooks work again. The cap still shows " +
      "your spend; it won't pause Codex tool calls until you run init --control " +
      "on a newer version.",
  );
  removeCodexControlHook({ hooksPath, ownershipPath, wrapperPath, log });
  return { action: "removed-hook", reason: complaint };
}

// ---------------------------------------------------------------------------
// Codex arming status
// ---------------------------------------------------------------------------

// FIVE states, and no sixth. "armed" is the only one that claims the cap can pause a
// Codex tool call, so everything we cannot prove lands in "unknown", never in "armed".
export type CodexControlState =
  | "armed"
  | "needs-re-trust"
  | "hooks-disabled"
  | "not-installed"
  | "unknown";

export interface CodexControlStatus {
  state: CodexControlState;
  // Machine-readable "why", for tests and for the extra line `status` prints under
  // "unknown". Never shown as the headline.
  reason?: string;
}

// Does ~/.codex/config.toml switch hooks off?
//
// WHY WE READ THE FILE AT ALL: with `hooks = false`, `hooks/list` answers with an
// EMPTY hook list, no warning and no error - identical to a machine where nothing was
// ever installed (checked against codex-cli 0.145.0 in a throwaway CODEX_HOME). So the app-server cannot tell "switched off" from "never installed",
// and this file is the only place the answer exists.
//
// Deliberately a small scanner, not a TOML parser: we need one boolean out of a file
// we never write. Returns null when the key is absent or unreadable, which the caller
// treats as "hooks are on" (Codex's own default).
//
// Missing a spelling here is not harmless: it makes status say "not installed" on a
// machine that IS installed, which sends the developer to reinstall what they already
// have. So the header match takes every form Codex honours. In codex-cli 0.145.0,
// "[features] # comment", "[ features ]", and both together all switch hooks off.
//
// KNOWN AND OUT OF SCOPE, both rare and both fail toward "we don't know" rather than a
// false "armed": the inline-table form (features = { hooks = false }) and the quoted
// header (["features"]). Neither is read here.
export function codexHooksFeatureDisabled(
  configPath: string = CODEX_CONFIG_FILE,
): boolean | null {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  let inFeatures = false;
  let answer: boolean | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#") || line.length === 0) continue;
    if (line.startsWith("[")) {
      // Array-of-tables headers ("[[features]]") are excluded on purpose: Codex
      // rejects that shape outright ("invalid type: sequence, expected struct
      // FeaturesToml"), so it is a broken config, not hooks switched off.
      inFeatures = /^\[\s*features\s*\]\s*(?:#.*)?$/.test(line);
      continue;
    }
    const match = /^(?:features\s*\.\s*)?hooks\s*=\s*(true|false)\b/.exec(line);
    if (!match) continue;
    const isDotted = /^features\s*\./.test(line);
    if (!inFeatures && !isDotted) continue;
    if (inFeatures && isDotted) continue;
    answer = match[1] === "false";
  }
  return answer;
}

// Identity has to survive an edit, because an edited hook is exactly the state we
// most need to report. The label is the last resort: it is what still matches when
// the edit landed inside the wrapper path itself.
function listedHookIsOurs(
  hook: CodexListedHook,
  frozenCommand: string,
  receiptCommand: string | null,
): boolean {
  if (hook.command === frozenCommand) return true;
  if (receiptCommand !== null && hook.command === receiptCommand) return true;
  if (hook.command.includes(CONTROL_DIR)) return true;
  return hook.statusMessage === CODEX_HOOK_STATUS_MESSAGE;
}

// Two orderings below are load-bearing, and both look redundant until they aren't:
//   - "hooks switched off" is decided BEFORE hooks/list is believed, because in that
//     state hooks/list returns an empty list and would read as "not-installed" -
//     which sends the developer to reinstall something already installed.
//   - "armed" needs trustStatus, never `enabled` alone. A hook can be enabled:true
//     and untrusted at the same time, and Codex then skips it without a word.
export async function resolveCodexControlStatus({
  hooksPath = CODEX_HOOKS_PATH,
  ownershipPath = CODEX_CONTROL_HOOK_OWNERSHIP_PATH,
  wrapperPath = CODEX_CAP_HOOK_WRAPPER_PATH,
  configPath = CODEX_CONFIG_FILE,
  codexInstalled,
  hooksList = codexHooksList,
  // Codex resolves hooks per working directory, so an answer is only ever about
  // one. Defaulting to Codex's own default keeps `status` answering about the repo
  // the human is standing in; the daemon overrides it (CODEX_TRUST_SCOPE_CWD in
  // forwarder.ts) because its own cwd is whatever launchd handed it.
  cwd,
  // A status command must never hang on a child process. The round trip takes
  // about 0.12s; five seconds is a wide margin that still fails fast.
  timeoutMs = 5_000,
}: {
  hooksPath?: string;
  ownershipPath?: string;
  wrapperPath?: string;
  configPath?: string;
  codexInstalled?: boolean;
  hooksList?: typeof codexHooksList;
  cwd?: string;
  timeoutMs?: number;
} = {}): Promise<CodexControlStatus> {
  const present =
    codexInstalled ?? isCodexInstalled({ codexDir: dirname(hooksPath) });
  if (!present) return { state: "unknown", reason: "codex-missing" };

  if (codexHooksFeatureDisabled(configPath) === true) {
    return { state: "hooks-disabled", reason: "features-hooks-false" };
  }

  const listed = await hooksList(
    cwd === undefined ? { timeoutMs } : { timeoutMs, cwd },
  );
  if (!listed.ok) {
    return { state: "unknown", reason: listed.reason ?? "no-answer" };
  }
  if (listed.warnings.some((w) => w.includes(hooksPath))) {
    return { state: "unknown", reason: "hooks-file-rejected" };
  }

  const frozenCommand = codexControlHookCommand(wrapperPath);
  const receiptCommand = readControlHookOwnership(ownershipPath);
  const ours = listed.hooks.filter((h) =>
    listedHookIsOurs(h, frozenCommand, receiptCommand),
  );
  if (ours.length === 0) return { state: "not-installed" };

  const exact = ours.find((h) => h.command === frozenCommand);
  if (exact && exact.trustStatus === "trusted" && exact.enabled) {
    return { state: "armed" };
  }
  if (!exact) return { state: "needs-re-trust", reason: "command-changed" };
  if (!exact.enabled) {
    return { state: "hooks-disabled", reason: "hook-switched-off" };
  }
  return { state: "needs-re-trust", reason: exact.trustStatus };
}

// Every state except "armed" ends with the action that fixes it. A test pins that.
export function renderCodexControlStatusLine(
  status: CodexControlStatus,
): string {
  switch (status.state) {
    case "armed":
      return "Codex: on. You've trusted the cap check, so it runs before Codex tool calls. Nothing to do.";
    case "needs-re-trust":
      return "Codex: not on yet. Codex only runs hooks you've trusted, and it asks again whenever one changes. To turn it on, run /hooks inside codex and trust the MarginFront cap check.";
    case "hooks-disabled":
      return "Codex: off. Hooks are switched off in your Codex settings, so the cap can't pause Codex tool calls. Turn hooks back on, then run /hooks inside codex and trust the MarginFront cap check.";
    case "not-installed":
      return "Codex: no cap check installed. To add one, run: node ~/.marginfront-ccc/cli.js init --control";
    case "unknown":
      return "Codex: we couldn't check, so we don't know if the cap is on.";
  }
}

// The second line, only under "unknown" - it names why we couldn't check, because
// "Codex isn't installed" and "Codex didn't answer in time" need different next steps.
export function renderCodexControlStatusDetail(
  status: CodexControlStatus,
): string | null {
  if (status.state !== "unknown") return null;
  switch (status.reason) {
    case "codex-missing":
      return "  Codex isn't on this machine. If you install it later, run init --control again to add the cap check there too.";
    case "timeout":
      return "  Codex took too long to answer. Run status again in a minute.";
    case "hooks-file-rejected":
      return "  Codex couldn't read your Codex hooks file. Run: node ~/.marginfront-ccc/cli.js init --control";
    default:
      return "  Codex answered with something we don't understand. Run: node ~/.marginfront-ccc/cli.js init --control";
  }
}

// ---------------------------------------------------------------------------
// armed-status telemetry stamp (rides the existing metadata channel)
// ---------------------------------------------------------------------------

export interface ControlArmedStamp {
  controlArmed: true;
  controlPolicyAsOf: string | null;
}

// The stamp the forwarder attaches to Claude turn metadata so the dashboard can
// count "cap armed for N of M developers". undefined when Control isn't armed, so an
// unarmed install's records carry no stamp.
export function resolveControlArmedStamp({
  ownershipPath = CONTROL_HOOK_OWNERSHIP_PATH,
  policyPath = CONTROL_POLICY_PATH,
}: {
  ownershipPath?: string;
  policyPath?: string;
} = {}): ControlArmedStamp | undefined {
  if (!isControlArmed(ownershipPath)) return undefined;
  return {
    controlArmed: true,
    controlPolicyAsOf: readControlPolicyAsOf(policyPath),
  };
}

function readControlPolicyAsOf(policyPath: string): string | null {
  try {
    const policy: unknown = JSON.parse(readFileSync(policyPath, "utf8"));
    if (isPlainObject(policy) && typeof policy.asOf === "string") {
      return policy.asOf;
    }
  } catch {
    // Armed but no readable policy yet (first pull hasn't landed) - still armed.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex armed-status telemetry stamp
// ---------------------------------------------------------------------------
//
// THE ASYMMETRY. Claude arming is a file that either exists or doesn't, so the
// answer is always yes or no. Codex arming can only be learned by asking Codex,
// which can decline to answer - so this side has a THIRD answer, "we don't know",
// and it must never collapse into either of the other two.

// The stamp version. Its ABSENCE on a Codex record means the sending meter reports
// no Codex answer, which is not the same as "no".
// That is the only way those two are distinguishable, so it rides every Codex
// record this version emits, including the ones that report we couldn't tell.
export const CODEX_CONTROL_STAMP_VERSION = 2;

// Sits beside policy.json and spent.json so uninstall wipes it with the rest of
// CONTROL_DIR. Exists for ONE reason: a restart shouldn't stamp "we don't know"
// for five minutes on a machine we already knew was armed.
export const CODEX_TRUST_CACHE_PATH = join(CONTROL_DIR, "codex-trust.json");

// Six refresh cycles, so five failed refreshes in a row degrade to "we don't know"
// rather than to a stale yes. That direction can only ever undercount protection.
export const CODEX_TRUST_TTL_MS = 30 * 60 * 1000;

const CODEX_CONTROL_STATES: readonly string[] = [
  "armed",
  "needs-re-trust",
  "hooks-disabled",
  "not-installed",
  "unknown",
];

export interface CodexTrustCacheEntry {
  state: CodexControlState;
  reason: string | null;
  resolvedAt: string;
  ccc: string;
}

// What rides Codex record metadata. codexControlArmed is OMITTED - never null,
// never false - when we could not tell, so the server side stays a plain
// equals-true / equals-false read and "we don't know" can't be mistaken for "no".
export interface CodexControlStamp {
  controlStampVersion: number;
  codexControlState: CodexControlState;
  codexControlArmed?: boolean;
  controlPolicyAsOf?: string | null;
}

// The one place a cached answer is judged fit to use. NOT called per telemetry line
// - the daemon pairs it with codexTrustValidForMs and re-checks that deadline
// instead, so the TTL still binds at stamp time without a Date parse per event.
export function validateCodexTrustCache(
  value: unknown,
  cccVersion: string,
  now: Date = new Date(),
): CodexTrustCacheEntry | null {
  if (!isPlainObject(value)) return null;
  const { state, resolvedAt, ccc } = value;
  if (typeof state !== "string" || !CODEX_CONTROL_STATES.includes(state)) {
    return null;
  }
  // A verdict written by a different release is not evidence about this one: the
  // frozen hook command the resolver matches on can change between versions, so an
  // "armed" from an older build may be describing a hook this build would reject.
  if (typeof ccc !== "string" || ccc !== cccVersion) return null;
  if (typeof resolvedAt !== "string") return null;
  const resolvedMs = Date.parse(resolvedAt);
  if (Number.isNaN(resolvedMs)) return null;
  const ageMs = now.getTime() - resolvedMs;
  // A future timestamp is a clock jump or an edited file. Refusing it matters:
  // an answer dated tomorrow would otherwise never age out.
  if (ageMs < 0 || ageMs > CODEX_TRUST_TTL_MS) return null;
  return {
    state: state as CodexControlState,
    reason: typeof value.reason === "string" ? value.reason : null,
    resolvedAt,
    ccc,
  };
}

export function readCodexTrustCache(
  cccVersion: string,
  {
    cachePath = CODEX_TRUST_CACHE_PATH,
    now = new Date(),
  }: { cachePath?: string; now?: Date } = {},
): CodexTrustCacheEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    return validateCodexTrustCache(parsed, cccVersion, now);
  } catch {
    return null;
  }
}

// Every resolution gets written, including "unknown" - that keeps resolvedAt moving,
// so "we checked and couldn't tell" stays distinguishable from "we never checked."
export function writeCodexTrustCache(
  status: CodexControlStatus,
  cccVersion: string,
  {
    cachePath = CODEX_TRUST_CACHE_PATH,
    now = new Date(),
  }: { cachePath?: string; now?: Date } = {},
): CodexTrustCacheEntry {
  const entry: CodexTrustCacheEntry = {
    state: status.state,
    reason: status.reason ?? null,
    resolvedAt: now.toISOString(),
    ccc: cccVersion,
  };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(entry, null, 2) + "\n");
  } catch {
    // Best effort. The caller keeps the returned entry in memory and that is what
    // the stamp reads; an unwritable disk only costs us the answer across a restart.
  }
  return entry;
}

// The three doors to the Codex answer, injectable. One spawns a Codex
// process and two touch the disk, and counting their calls is the only proof they
// never run per telemetry line - a source-layout check stays green while a refactor
// moves one into the per-line loop.
export interface CodexTrustDeps {
  resolveStatus: (opts: { cwd?: string }) => Promise<CodexControlStatus>;
  readCache: (cccVersion: string) => CodexTrustCacheEntry | null;
  writeCache: (
    status: CodexControlStatus,
    cccVersion: string,
  ) => CodexTrustCacheEntry;
  // Injectable so a test can walk 30 minutes forward in a millisecond.
  monotonicNow?: () => number;
  // The wall clock, paired with monotonicNow because neither alone bounds the
  // verdict's age. See currentCodexControlStamp in forwarder.ts.
  wallNow?: () => number;
}

// What a record carries when we have nothing to say about Codex. Exported so the
// daemon can fall back to it per line without re-running any resolution.
export function unknownCodexControlStamp(): CodexControlStamp {
  return {
    controlStampVersion: CODEX_CONTROL_STAMP_VERSION,
    codexControlState: "unknown",
  };
}

// How much longer a cached verdict may keep riding records, in ms from `now`; zero
// when it is already unusable. This is the half of the TTL that binds at STAMP time:
// expire only inside the refresh and an "armed" claim is unbounded in age whenever
// refreshes stop landing. The daemon turns it into a MONOTONIC deadline.
export function codexTrustValidForMs(
  cached: CodexTrustCacheEntry | null,
  cccVersion: string,
  now: Date = new Date(),
): number {
  const fresh = validateCodexTrustCache(cached, cccVersion, now);
  if (fresh === null) return 0;
  const ageMs = now.getTime() - Date.parse(fresh.resolvedAt);
  return Math.max(0, CODEX_TRUST_TTL_MS - ageMs);
}

// "Armed" means Codex told us it TRUSTS the hook. An installed hook Codex has not
// trusted is inert - Codex skips it without a word - so it is not armed, and the
// answer comes from resolveCodexControlStatus, never from a receipt file existing.
export function resolveCodexControlStamp({
  cached,
  cccVersion,
  policyPath = CONTROL_POLICY_PATH,
  now = new Date(),
}: {
  cached: CodexTrustCacheEntry | null;
  cccVersion: string;
  policyPath?: string;
  now?: Date;
}): CodexControlStamp {
  const fresh = validateCodexTrustCache(cached, cccVersion, now);
  // No answer, a stale one, or one from another release: say so. Never the last
  // known value, and never an optimistic yes.
  if (fresh === null || fresh.state === "unknown") {
    return unknownCodexControlStamp();
  }
  if (fresh.state === "armed") {
    return {
      controlStampVersion: CODEX_CONTROL_STAMP_VERSION,
      codexControlState: "armed",
      codexControlArmed: true,
      controlPolicyAsOf: readControlPolicyAsOf(policyPath),
    };
  }
  // needs-re-trust / hooks-disabled / not-installed: Codex answered, and the answer
  // was no. That is a PROVEN gap, which is a different thing from an unread one.
  return {
    controlStampVersion: CODEX_CONTROL_STAMP_VERSION,
    codexControlState: fresh.state,
    codexControlArmed: false,
  };
}

// ---------------------------------------------------------------------------
// spend-state sync (the daemon's job): pull the caps + spend read-back -> policy + spent
// ---------------------------------------------------------------------------

// A cap row as the /v1/control/caps endpoint returns it (the full cap_policies
// row). We read only the fields the device brake needs.
interface CapRow {
  id: string;
  scope: string;
  scopeValue: string | null;
  providerScope: string;
  amountUsd: number | string;
  period: string;
  mode: string;
  coolOffHours: number | null;
  whyNote?: string | null;
}

// The /v1/control/spend response shape (fail-open contract: spentUsd may be null).
interface SpendReadback {
  period: string;
  asOf: string;
  org: { spentUsd: number | null };
  dev: { customerExternalId: string; spentUsd: number | null } | null;
}

export interface SyncControlStateResult {
  synced: boolean;
  reason?: string;
  capCount?: number;
}

// Pull the caps + spend read-back and materialize policy.json + spent.json for the
// hook. Called by the daemon on its cadence AND once by init (so the cap is real
// before the daemon's first cycle). Injectable fetch / now / paths for tests.
//
// FAIL-OPEN ON SYNC TOO: any network or parse failure leaves the LAST-GOOD files in
// place (or, on a first run, no files at all) and returns synced:false. Stale files
// are handled by the hook's own freshness gate - a sync failure never itself blocks.
export async function syncControlState({
  apiKey = process.env.MARGINFRONT_API_KEY,
  serverUrl,
  devEmail,
  now = () => new Date(),
  fetchImpl = fetch,
  policyPath = CONTROL_POLICY_PATH,
  spentPath = CONTROL_SPENT_PATH,
  ownershipPath = CONTROL_HOOK_OWNERSHIP_PATH,
  log = () => {},
}: {
  apiKey?: string;
  serverUrl?: string;
  devEmail?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  policyPath?: string;
  spentPath?: string;
  ownershipPath?: string;
  log?: LogFn;
}): Promise<SyncControlStateResult> {
  if (!isControlArmed(ownershipPath)) {
    return { synced: false, reason: "not-armed" };
  }
  if (!apiKey) {
    return { synced: false, reason: "no-key" };
  }

  const server = resolveConfiguredServer(process.env, serverUrl);
  if (!server.ok) {
    log(`[control] caps not read. ${server.problem}`);
    return { synced: false, reason: "no-server" };
  }
  const base = controlBaseUrl(server.baseUrl);
  const headers = {
    "x-api-key": apiKey,
    Accept: "application/json",
  };

  let caps: CapRow[];
  try {
    const res = await sendToServer(
      server.baseUrl,
      `${base}/caps`,
      { headers },
      fetchImpl,
    );
    if (!res.ok) {
      log(
        `[control] caps read-back returned HTTP ${res.status}; keeping last-good state.`,
      );
      return { synced: false, reason: `http-${res.status}` };
    }
    const body: unknown = await res.json();
    caps = Array.isArray(body) ? (body as CapRow[]) : [];
  } catch (err) {
    log(
      `[control] could not reach the caps read-back: ${(err as Error).message}; keeping last-good state.`,
    );
    return { synced: false, reason: "network" };
  }

  // Only caps this device can honestly enforce: enforce mode, all-provider, and
  // either the org ceiling (compared to org total) or THIS dev's own cap (compared
  // to this dev's total). Team caps are excluded - the read-back exposes no team
  // total and the device can't resolve team membership (documented limitation).
  const enforceable = caps.filter(
    (c) =>
      c.mode === CAP_MODE_ENFORCE &&
      c.providerScope === CAP_PROVIDER_SCOPE_ALL &&
      (c.scope === "org" ||
        (c.scope === "dev" && !!devEmail && c.scopeValue === devEmail)),
  );

  const periods = Array.from(new Set(enforceable.map((c) => c.period))).filter(
    (p): p is CapPeriod => (CAP_PERIODS as readonly string[]).includes(p),
  );

  const asOf = now().toISOString();
  const byPeriod: Record<string, unknown> = {};
  for (const period of periods) {
    let spend: SpendReadback;
    try {
      const url = new URL(`${base}/spend`);
      url.searchParams.set("period", period);
      if (devEmail) url.searchParams.set("customerExternalId", devEmail);
      const res = await sendToServer(
        server.baseUrl,
        url.toString(),
        { headers },
        fetchImpl,
      );
      if (!res.ok) {
        log(
          `[control] spend read-back (${period}) returned HTTP ${res.status}; keeping last-good state.`,
        );
        return { synced: false, reason: `http-${res.status}` };
      }
      spend = (await res.json()) as SpendReadback;
    } catch (err) {
      log(
        `[control] could not reach the spend read-back (${period}): ${(err as Error).message}; keeping last-good state.`,
      );
      return { synced: false, reason: "network" };
    }
    byPeriod[period] = {
      windowEndEpoch: periodWindowEndEpoch(period, now()),
      // Honest null preserved end-to-end: the server sends null for "no priced
      // usage", we store null, the hook treats null as no-block.
      org: { spentUsd: spend.org?.spentUsd ?? null },
      ...(spend.dev ? { dev: { spentUsd: spend.dev.spentUsd ?? null } } : {}),
    };
  }

  const policy = {
    version: asOf,
    asOf,
    caps: enforceable.map((c) => ({
      id: c.id,
      scope: c.scope,
      providerScope: c.providerScope,
      mode: c.mode,
      amountUsd:
        typeof c.amountUsd === "string" ? Number(c.amountUsd) : c.amountUsd,
      period: c.period,
      coolOffHours: c.coolOffHours ?? null,
      ...(c.whyNote ? { whyNote: c.whyNote } : {}),
    })),
  };
  const spent = { asOf, byPeriod };

  writeJsonAtomic(policyPath, policy);
  writeJsonAtomic(spentPath, spent);
  log(`[control] synced ${enforceable.length} enforceable cap(s).`);
  return { synced: true, capCount: enforceable.length };
}

// The UTC epoch-seconds at which a period's current window rolls to the next one.
// Mirrors the platform's window math (cap-policy.ts currentPeriodWindow): weeks
// start Monday 00:00 UTC (ISO-8601). Epoch (not ISO) so the Python hook needs no
// date parsing. Exported for its own unit test.
export function periodWindowEndEpoch(period: string, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === "day") {
    return Date.UTC(y, m, d + 1) / 1000;
  }
  if (period === "month") {
    return Date.UTC(y, m + 1, 1) / 1000;
  }
  // week: forward to the NEXT Monday 00:00 UTC. getUTCDay() is 0 (Sun)..6 (Sat).
  const dow = now.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const daysUntilNextMonday = 7 - daysSinceMonday;
  return Date.UTC(y, m, d + daysUntilNextMonday) / 1000;
}
