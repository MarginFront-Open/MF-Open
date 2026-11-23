// finished-work.ts - "count what you finish", the pure half.
//
// A finished thing is a usage record with no tokens and no model cost, priced $0 by
// ONE row in the price list under provider "outcome", model "work-item". That
// provider word is the only marker the ROI page reads, so nothing here may add a
// second one, and nothing here may add a field a pricing path would charge for.
//
// Everything in this file is pure: string in, string or object out, no disk, no
// clock, no environment. The CLI owns when to call it and what to do with the answer.

import { createHash } from "node:crypto";
import { WORK_ITEM_NOUN_PLAIN } from "./work-item-noun";
import type { GitCoordinates, UsageRecord } from "./types";

// The catalog pair that prices a finished thing at zero. Changing either word
// orphans every record already sent, so treat both as a wire contract.
export const FINISHED_WORK_PROVIDER = "outcome";
export const FINISHED_WORK_MODEL = "work-item";

// The metadata discriminant, matching how "codex" and "tool" records mark themselves.
export const FINISHED_WORK_SOURCE = "outcome";

// The one spelling of the one direction to the page, so status, done, work and the
// memory block cannot drift apart. `reason` is a parameter because a direction has to
// carry its reason in the same sentence.
//
// Do not trim the parenthetical: ROI is role-gated to finance, admin and owner, and
// the ingest key a developer installs with comes off Build, which is not gated.
export function roiFinishedWorkPointer(reason: string): string {
  return `On your MarginFront dashboard, open ROI in the left menu (ask whoever owns your MarginFront account if you don't see it), then the Finished work tab, ${reason}.`;
}

// Held to INGEST_STRING_MAX_LENGTH, the cap on every top-level ingest string, so a
// long name is trimmed here rather than rejected by the server after a round trip.
export const FINISHED_WORK_NAME_MAX_LENGTH = 255;

// A typo guard, not a policy: "done report 100000" is a slip, and a phantom
// hundred thousand on someone's ROI page is worse than one refusal.
export const FINISHED_WORK_MAX_COUNT = 10000;

// The settings-file line holding the names the customer gave init, so `status` can
// say which mode this machine is in without a second source of truth.
export const FINISHED_WORK_NAMES_ENV_KEY = "CCC_FINISHED_WORK";

// Enough names to describe what a team finishes; past this it is a paste, not a list.
export const FINISHED_WORK_NAMES_MAX = 50;

// Trimmed and inner-whitespace-collapsed so "contract  summarized" and "contract summarized"
// are one row on the page. NEVER re-cased: the page groups case-insensitively and
// shows the first spelling it saw, which is the customer's own.
export function normalizeFinishedName(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, FINISHED_WORK_NAME_MAX_LENGTH);
}

export type FinishedCountResult =
  | { ok: true; count: number }
  | { ok: false; reason: "not-a-whole-number" | "out-of-range" };

export function parseFinishedCount(
  raw: string | undefined,
): FinishedCountResult {
  if (raw === undefined) return { ok: true, count: 1 };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed))
    return { ok: false, reason: "not-a-whole-number" };
  const parsed = Number(trimmed);
  if (parsed < 1 || parsed > FINISHED_WORK_MAX_COUNT) {
    return { ok: false, reason: "out-of-range" };
  }
  return { ok: true, count: parsed };
}

// One name per row on the ROI page, so two spellings of the same name would read as
// two kinds of work. Case-insensitive de-dup, first spelling kept.
export function parseFinishedWorkNames(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const piece of (raw ?? "").split(",")) {
    const name = normalizeFinishedName(piece);
    if (!name) continue;
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    names.push(name);
    if (names.length >= FINISHED_WORK_NAMES_MAX) break;
  }
  return names;
}

export function renderFinishedWorkNames(names: readonly string[]): string {
  return names.join(", ");
}

// The dedup key. Hashed over the minute rather than the instant, so a customer who
// runs the same command twice by reflex records the thing once, while the same thing
// genuinely finished twice in one minute is a count of 2 they type themselves. The
// "done" sentinel keeps this key structurally unable to collide with a turn's.
export function finishedWorkIdempotencyKey(
  identity: string,
  name: string,
  count: number,
  atIso: string,
): string {
  const minute = atIso.slice(0, 16);
  return createHash("sha256")
    .update(`done|${identity}|${name}|${count}|${minute}`)
    .digest("hex");
}

export interface FinishedWorkRecordInput {
  // The developer this count and its AI spend both roll up under.
  identity: string;
  // Which assistant's column the row lands in: "claude-code" or "codex".
  agentCode: string;
  // The customer's own words, already normalized.
  name: string;
  count: number;
  // The current work-item label, when one is set. Rides the wire field ingest reads.
  workItem?: string;
  // Read fresh from the cwd. All-null (not a repo) is omitted rather than stamped.
  git?: GitCoordinates | null;
  doneAt: string;
}

export function buildFinishedWorkRecord(
  input: FinishedWorkRecordInput,
): UsageRecord {
  const git =
    input.git && (input.git.repo || input.git.branch || input.git.commitSha)
      ? input.git
      : null;

  return {
    customerExternalId: input.identity,
    agentCode: input.agentCode,
    signalName: input.name,
    model: FINISHED_WORK_MODEL,
    modelProvider: FINISHED_WORK_PROVIDER,
    quantity: input.count,
    environment: "development",
    idempotencyKey: finishedWorkIdempotencyKey(
      input.identity,
      input.name,
      input.count,
      input.doneAt,
    ),
    metadata: {
      source: FINISHED_WORK_SOURCE,
      ...(input.workItem ? { matterId: input.workItem } : {}),
      ...(git ?? {}),
      doneAt: input.doneAt,
    },
  };
}

// --- THE NOTE THE ASSISTANT READS -------------------------------------------
//
// The assistant learns this feature from ONE block in the memory file it already
// reads every session. Not a hook: a Stop hook fires on every turn on both
// assistants and cannot tell finishing a piece of work from answering a question.
//
// Fenced by two HTML comments so it is idempotent (re-running init replaces the
// block, never adds a second) and so `uninstall` can take back exactly what it put
// there. Both files are Markdown, so a TOML-style "#" fence would render as a
// heading the assistant would try to follow.

export const MEMORY_BEGIN_MARKER =
  "<!-- >>> MarginFront code-cost-clarity - auto-added; the meter's `uninstall` command removes this block >>> -->";
// A second accepted opening marker, the one that names the npx command. `init`
// replaces a block that starts with it and `uninstall` removes it.
export const LEGACY_MEMORY_BEGIN_MARKER =
  "<!-- >>> MarginFront code-cost-clarity - auto-added; `npx @marginfront/code-cost-clarity uninstall` removes this block >>> -->";

function isMemoryBeginMarker(line: string): boolean {
  return line === MEMORY_BEGIN_MARKER || line === LEGACY_MEMORY_BEGIN_MARKER;
}
export const MEMORY_END_MARKER =
  "<!-- <<< MarginFront code-cost-clarity - end of auto-added block <<< -->";

// `invocation` is passed in rather than read from a constant here so this file stays
// pure, and so the block always spells the command the same way the README does.
//
// `agentCode` is set only on a machine with BOTH assistants installed, where `done`
// cannot tell on its own which one a finished thing belongs to until the meter has
// seen one working. Each file's own copy carries its own answer, so the assistant
// reading it never meets that refusal.
// Wording: a loose instruction like "count the work you finish" plus "pick a
// short plain name" leads assistants to record their own edits under invented
// names and refuse the person's real finish. Saying whose outcomes they are,
// listing the only names, and forbidding self-counting prevents that. The sandbox sentence is there because Codex blocks the network by
// default, so without it the first attempt fails and the assistant
// sometimes drops the work step silently.
export function renderFinishedWorkMemoryBlock(
  names: readonly string[],
  invocation: string,
  agentCode?: string,
): string {
  const examples = names.length > 0 ? renderFinishedWorkNames(names) : "";
  const agentFlag = agentCode ? ` --agent ${agentCode}` : "";
  return [
    MEMORY_BEGIN_MARKER,
    "MarginFront counts finished outcomes, not only what your AI spends. The outcomes belong to the person you are helping, not to you.",
    "",
    `When they start a ${WORK_ITEM_NOUN_PLAIN}, run this in the terminal:`,
    `    ${invocation} work "<short name for the work>"`,
    "",
    // The names come BEFORE the done line: "one of those" with nothing listed
    // yet points at nothing.
    examples
      ? `The only things to count, exactly as written: ${examples}.`
      : "Count only what the person tells you is finished, with the name they use, and reuse that name next time.",
    "",
    "When the person tells you one of those is finished, record it right away, once per finished thing, with the name exactly as written. Their word is what counts, even when your edits were part of the work. Do not ask first.",
    `    ${invocation} done "<name>"${agentFlag}`,
    `Several at once: add the number, like ${invocation} done "<name>" 3${agentFlag}.`,
    "",
    "Never record something they did not tell you was finished. Never count your own edits, files, scripts, tests or answers on your own. Never invent a name. If they finish something that is not on the list, do not record it; say it is not on the list.",
    "",
    "Both commands need the network. If your shell runs in a sandbox that blocks it, ask for approval to run them outside the sandbox before running them, rather than letting them fail first.",
    "",
    "When the work changes, run the work command again with the new name.",
    "",
    roiFinishedWorkPointer("to see each one with its AI cost beside it"),
    MEMORY_END_MARKER,
  ].join("\n");
}

// Closing marker first, THEN the nearest opening one above it. The other way round
// pairs an opening marker the user left behind by hand with our real block's
// closing one, and everything between - their own lines included - reads as ours.
function findMemoryBlock(lines: string[]): { begin: number; end: number } {
  const end = lines.indexOf(MEMORY_END_MARKER);
  if (end < 1) return { begin: -1, end: -1 };
  for (let begin = end - 1; begin >= 0; begin -= 1) {
    if (isMemoryBeginMarker(lines[begin])) return { begin, end };
  }
  return { begin: -1, end: -1 };
}

// Put our block into a file we do not own, and be able to take it back out byte for
// byte. The whole trick: the block INHERITS the file's trailing-newline shape, so
// removal is "drop the marker lines and everything between them" with no newline
// bookkeeping and no way for a round trip to gain or lose a byte.
export function insertMemoryBlock(text: string, block: string): string {
  const lines = text.split("\n");
  const { begin, end } = findMemoryBlock(lines);
  if (begin !== -1) {
    return [
      ...lines.slice(0, begin),
      ...block.split("\n"),
      ...lines.slice(end + 1),
    ].join("\n");
  }
  // An opening marker with no closing one is still ours. Replace that ONE line and
  // nothing under it: those lines are the customer's, and appending a second block
  // instead would leave two opening markers for the next uninstall to sweep between.
  const orphan = lines.findIndex(isMemoryBeginMarker);
  if (orphan !== -1) {
    return [
      ...lines.slice(0, orphan),
      ...block.split("\n"),
      ...lines.slice(orphan + 1),
    ].join("\n");
  }
  if (text === "") return `${block}\n`;
  return text.endsWith("\n") ? `${text}${block}\n` : `${text}\n${block}`;
}

export function removeMemoryBlock(text: string): {
  text: string;
  found: boolean;
} {
  const lines = text.split("\n");
  const { begin, end } = findMemoryBlock(lines);
  if (begin === -1) return { text, found: false };
  return {
    text: [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n"),
    found: true,
  };
}
