// windows-control.ts - the Windows half of the spend-cap brake.
//
// Node, not python, because `python3` on a stock Windows box is the Microsoft Store
// stub: it exits without running anything, and control.ts reads any exit that is not
// 2 as "let the tool call through" - an armed cap that blocks nothing.
//
// Node is also the safer interpreter here, which is the part worth knowing. It
// documents exit code 2 as unused and returns 1 for a missing file, a syntax error,
// an uncaught throw, and a directory passed as a script. `python3 <missing file>`
// returns 2, the very code that stops a tool call, which is why the Unix side needs
// codex-cap-hook.sh to filter accidental 2s out. Windows needs no such wrapper.

import { platform } from "node:os";

// The Windows cap script's filename, the sibling of check-cap.py. The extension is
// load-bearing: .mjs makes node read it as an ES module wherever it lands, with no
// package.json anywhere near it.
export const WINDOWS_CAP_SCRIPT_FILENAME = "check-cap.mjs";

// Bare `node`, not an absolute path: Codex hashes the command string into its "I
// trust this hook" record, so a path that moved on a node upgrade would silently
// un-trust the hook and the cap would go quiet with no message. Stability beats
// PATH insurance - the same bet the Unix side makes with bare `python3`.
export function windowsCapHookCommand(scriptPath: string): string {
  return `node "${scriptPath}"`;
}

// Takes the path the Unix side would have put its shell wrapper at, so a caller that
// threads a wrapperPath through needs no Windows branch; Windows has no wrapper, so it
// lands on the cap script sitting beside it.
export function windowsCodexCapHookCommand(wrapperPath: string): string {
  // Split on either separator by hand rather than through node:path. path.dirname
  // follows the HOST's rules, so a test that pins the Windows string while running
  // on a Mac would get "." back from a backslash path and pin the wrong answer.
  const lastSeparator = Math.max(
    wrapperPath.lastIndexOf("\\"),
    wrapperPath.lastIndexOf("/"),
  );
  const directory =
    lastSeparator === -1 ? "" : wrapperPath.slice(0, lastSeparator + 1);
  return windowsCapHookCommand(directory + WINDOWS_CAP_SCRIPT_FILENAME);
}

export function isWindows(nodePlatform: string = platform()): boolean {
  return nodePlatform === "win32";
}

// ===========================================================================
// THE CAP-CHECK SCRIPT (Windows)
// ---------------------------------------------------------------------------
// Materialized verbatim to ~/.marginfront-ccc/control/check-cap.mjs. Like its
// Python sibling this is the product's trust surface - developers and their coding
// agents read it before agreeing to install - so its comments are load-bearing and
// it stays ONE small file with no dependencies and no network. It finds its own
// state files relative to itself, so nothing machine-specific is baked in and every
// machine gets byte-identical bytes.
//
// Every decision below mirrors check-cap.py. The differences are noted inline where
// they exist, and each one moves in the fail-open direction.
// ===========================================================================
export const WINDOWS_CAP_CHECK_SCRIPT = `#!/usr/bin/env node
// MarginFront Code Cost Control - device cap check (opt-in, installed by
// \`node ~/.marginfront-ccc/cli.js init --control\`).
//
// Claude Code and Codex both run this before every tool call. It reads two small
// local files the MarginFront meter wrote next to it - the spend policy and the
// latest spend totals - and does exactly one thing: if an ENFORCE cap covering ALL
// providers is at or over its limit, it stops that tool call (exit 2, and the
// reason on stderr). Anything else exits 0 and the tool runs normally.
//
// It makes NO network calls and writes NOTHING except its own cool-off marker.
// Only exit code 2 stops a tool call; EVERY error path here exits 0, so a missing,
// corrupt, or stale file - or any bug in this script - can never stop your machine.
// That is the fail-open promise, and it is deliberate.
//
// This is the Windows twin of check-cap.py, which is what macOS and Linux get. It
// is node rather than python because on Windows \`python3\` is usually the Microsoft
// Store stub, which exits without running anything - a cap that never blocks. Node
// is already here: the meter runs on it.
import { readFileSync, writeFileSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = join(HERE, "policy.json");
const SPENT_PATH = join(HERE, "spent.json");
const TRIP_PATH = join(HERE, "trip.json");

// If the meter has not refreshed spend within this many seconds, the numbers are
// stale and we do NOT enforce - a dead or offline meter must never keep blocking
// forever. Freshness is the file's own write time (local clock on both sides), so it
// needs no agreement between your clock and the server's.
const STALE_SECONDS = 3600;

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// fs.writeSync onto fd 2, not console.error: on Windows a write to a piped stderr is
// asynchronous, and process.exit can cut it off half-written. A block whose reason
// never arrives is the same as no explanation at all.
function block(message) {
  try {
    writeSync(2, message);
  } catch {}
  process.exit(2);
}

function messageFor(cap, spentUsd, cooloffUntil) {
  const amount = cap.amountUsd;
  const period = cap.period;
  const spentText =
    spentUsd === null || spentUsd === undefined
      ? "an unknown amount"
      : "$" + String(spentUsd);
  const head =
    cooloffUntil === null || cooloffUntil === undefined
      ? "Code Cost Control: your team's " +
        period +
        " spend cap of $" +
        String(amount) +
        " is reached (about " +
        spentText +
        " spent so far)."
      : "Code Cost Control: your team's " +
        period +
        " spend cap of $" +
        String(amount) +
        " tripped and is in a cool-off window right now.";
  const lines = [head];
  const why = cap.whyNote;
  if (why) lines.push("Note from your admin: " + why);
  lines.push(
    "Your team's admin set this cap; to keep going, contact your admin to raise " +
      "or reset it.",
  );
  lines.push(
    "This is your team's spend cap, not the AI declining - the model itself did " +
      "not refuse this.",
  );
  return lines.join("\\n") + "\\n";
}

function main() {
  // No policy / no spend file yet, or either unreadable -> nothing to enforce.
  let policy;
  let spent;
  try {
    policy = load(POLICY_PATH);
    spent = load(SPENT_PATH);
  } catch {
    process.exit(0);
  }

  // Stale spend -> fail open.
  try {
    const ageSeconds = Date.now() / 1000 - statSync(SPENT_PATH).mtimeMs / 1000;
    if (ageSeconds > STALE_SECONDS) process.exit(0);
  } catch {
    process.exit(0);
  }

  const caps = policy.caps || [];
  const byPeriod = spent.byPeriod || {};
  const now = Date.now() / 1000;

  let trip;
  try {
    trip = load(TRIP_PATH);
  } catch {
    trip = {};
  }

  for (const cap of caps) {
    // Belt-and-suspenders next to the daemon's own filter: ONLY all-provider
    // enforce caps can ever block here, whatever the meter wrote. Provider-scoped
    // caps and track-mode caps never stop you.
    if (cap.providerScope !== "all" || cap.mode !== "enforce") continue;

    const capId = cap.id;
    const amount = cap.amountUsd;
    const period = cap.period;
    const scope = cap.scope; // 'org' or 'dev' - which spend total to compare
    const coolOffHours = cap.coolOffHours;
    if (amount === null || amount === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(byPeriod, period)) continue;

    const bucket = byPeriod[period] || {};
    const windowEnd = bucket.windowEndEpoch;
    const spentUsd = (bucket[scope] || {}).spentUsd;

    // Active cool-off from an earlier trip: keep braking until the cool-off hours
    // pass OR the spend window rolls, whichever comes first.
    const marker =
      capId === null || capId === undefined ? undefined : trip[capId];
    if (marker) {
      const limits = [];
      const coh = marker.coolOffHours;
      if (coh !== null && coh !== undefined) {
        limits.push((marker.trippedAt || 0) + coh * 3600);
      }
      const we = marker.windowEndEpoch;
      if (we !== null && we !== undefined) limits.push(we);
      if (limits.length > 0 && now < Math.min.apply(null, limits)) {
        block(messageFor(cap, spentUsd, Math.min.apply(null, limits)));
      }
    }

    // Honest null: absent spend is absent, never a coerced 0 - it never blocks.
    if (spentUsd === null || spentUsd === undefined) continue;

    // Both sides must be real numbers before they are compared. This is the one
    // place this script is STRICTER than check-cap.py: Python raises on "300" >= 200
    // and lands in the fail-open catch, while JavaScript would quietly coerce and
    // could BLOCK on a malformed file. A malformed file must let you work.
    if (typeof spentUsd !== "number" || typeof amount !== "number") continue;
    if (!Number.isFinite(spentUsd) || !Number.isFinite(amount)) continue;

    if (spentUsd >= amount) {
      if (
        coolOffHours !== null &&
        coolOffHours !== undefined &&
        capId !== null &&
        capId !== undefined &&
        !Object.prototype.hasOwnProperty.call(trip, capId)
      ) {
        trip[capId] = {
          trippedAt: now,
          windowEndEpoch: windowEnd,
          coolOffHours: coolOffHours,
        };
        try {
          writeFileSync(TRIP_PATH, JSON.stringify(trip));
        } catch {
          // a marker we could not persist must not turn a block into a crash
        }
      }
      block(messageFor(cap, spentUsd, null));
    }
  }

  process.exit(0);
}

// Both agents write the tool-call event to our stdin. We need nothing from it, but
// we keep reading so neither is left writing into a pipe nobody is reading. We never
// WAIT for it: every exit below is an explicit process.exit, so a stream that never
// ends cannot hold this open.
process.stdin.on("error", () => {});
process.stdin.on("data", () => {});

// The last line of the fail-open promise. A real stop leaves through process.exit
// inside block(), which unwinds nothing and so cannot be swallowed here.
try {
  main();
} catch {
  process.exit(0);
}
`;
