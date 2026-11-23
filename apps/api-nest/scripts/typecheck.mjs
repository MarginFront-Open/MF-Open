#!/usr/bin/env node
/**
 * Type-check gate for api-nest. Not a bare `tsc --noEmit`: the workspace
 * carries known type errors, listed in typecheck-baseline.json, and the gate
 * holds that list fixed.
 *
 * Fails on any error above baseline, AND on any error BELOW it — a baseline
 * left stale is the same silent pass this gate exists to stop.
 *
 * TWO THINGS THE OBVIOUS IMPLEMENTATION GETS WRONG, both of which give a check
 * that silently covers nothing and still reports green:
 *
 *   1. COUNTING ERRORS BUT NOT FILES. Narrow `tsconfig.spec.json`'s `include`
 *      and the error tally does not move — the dropped files had no errors —
 *      so the gate says "clean" over a shrunken set. Scoping it to
 *      `src/modules/**`, for example, drops the guard route sweeps out of
 *      coverage and leaves the tally unchanged. So the gate counts the spec
 *      files the project actually resolves and holds a floor, the same way
 *      the route sweeps pin `routes.length`.
 *
 *   2. KEYING THE BASELINE ON A COUNT. `<file> TS2339: 8` is satisfied by any
 *      eight TS2339s in that file, so fixing four and introducing four others
 *      passes. The baseline therefore stores the error MESSAGES and diffs them
 *      as multisets: a swap shows up as one addition plus one removal.
 *
 * Run `npm run typecheck:baseline` in this workspace to rewrite the baseline.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const README = [
  'Known type errors in api-nest that the type-check gate tolerates.',
  'Every entry is a real defect, not a false positive. Keys are "<file> TS<code>",',
  'values are the error messages that file is currently allowed to emit, with',
  'inline object types collapsed to "{ ... }" because tsc does not print their',
  'property order deterministically. Messages, not counts: a count-keyed baseline',
  'lets you fix one error and add a different one of the same code in the same',
  'file with the gate never moving.',
  'This list may only shrink. Adding to it means shipping a new type error.',
  '',
  'specFileFloor is the minimum number of *.spec.ts files tsconfig.spec.json must',
  'still resolve. It stops a later narrowing of that config from quietly dropping',
  'specs out of coverage while the error tally - and so the gate - stays green.',
];

/**
 * Slack under the count observed when the baseline was written. Deleting a few
 * specs is normal and must not fail the build; a scope collapse like the one
 * described above must.
 */
const FLOOR_RATIO = 0.95;

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(appDir, 'typecheck-baseline.json');
const update = process.argv.includes('--update');

// Resolved, never joined by hand: npm workspaces hoist typescript to the repo
// root, so apps/api-nest/node_modules/typescript does not exist.
let tscBin;
try {
  tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc');
} catch {
  console.error('Could not find the typescript compiler.');
  console.error('Fix: run `npm ci` at the repo root, then try again.');
  process.exit(1);
}

function runTsc(extraArgs) {
  const result = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.spec.json', ...extraArgs], {
    cwd: appDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`Could not run tsc: ${result.error.message}`);
    console.error('Fix: run `npm ci` at the repo root, then try again.');
    process.exit(1);
  }
  return result;
}

// ── Pass 1: how much does this project actually cover? ────────────────────────
// --listFilesOnly resolves the file graph and skips type checking, so it is
// about a second even on a cold cache.

const srcPrefix = `${join(appDir, 'src')}/`;

function countSpecFiles() {
  const listing = runTsc(['--listFilesOnly']);
  const lines = `${listing.stdout || ''}`.split('\n');
  const specs = lines
    .map((line) => line.trim().split('\\').join('/'))
    .filter((line) => line.startsWith(srcPrefix) && line.endsWith('.spec.ts'));

  if (specs.length === 0) {
    console.error('`tsc --listFilesOnly` resolved zero spec files under src/.');
    console.error('That means the type check would run over nothing. Raw output:\n');
    console.error(`${listing.stdout || ''}${listing.stderr || ''}`.trim() || '(no output)');
    process.exit(1);
  }
  return specs.length;
}

const specFileCount = countSpecFiles();

// ── Pass 2: the type check itself ─────────────────────────────────────────────

const tsc = runTsc([]);
const output = `${tsc.stdout || ''}${tsc.stderr || ''}`;

// tsc line shape: path/to/file.ts(12,34): error TS2339: message
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Collapse every inline object type in an error message to `{ ... }`.
 *
 * MEASURED, not defensive: most of these errors are about Prisma's generated
 * anonymous row types, which tsc prints member-by-member. Three cold runs print
 * them identically, but the property ORDER shifts the moment the incremental
 * tsBuildInfo was written under a different `include` — so a developer whose
 * cache is warm from any other config would see every baselined error report as
 * a swap. A gate that goes red on a no-op re-run is a gate people turn off.
 *
 * What survives collapsing is the part that identifies the defect: the missing
 * or unknown PROPERTY NAME for TS2339/TS2353, and the named target type for
 * TS2322. That is what makes a swap detectable, and it does not move.
 *
 * Innermost-out, because these types nest. `{ ... }` re-matches to itself, so
 * the loop terminates on the first pass that changes nothing.
 */
function normalizeMessage(raw) {
  let message = raw.trim().replace(/\s+/g, ' ');
  let previous;
  do {
    previous = message;
    message = message.replace(/\{[^{}]*\}/g, '{ ... }');
  } while (message !== previous);
  return message;
}

/** key -> array of normalized messages, key being "<relative path> TS####". */
const found = new Map();
for (const line of output.split('\n')) {
  const m = ERROR_LINE.exec(line);
  if (!m) continue;
  const key = `${m[1]} ${m[4]}`;
  const messages = found.get(key) || [];
  messages.push(normalizeMessage(m[5]));
  found.set(key, messages);
}

const total = [...found.values()].reduce((n, messages) => n + messages.length, 0);

// tsc unhappy but zero parsed errors means the invocation itself broke, and
// staying quiet would report a clean type check over zero files.
if (tsc.status !== 0 && total === 0) {
  console.error(`tsc exited ${tsc.status} without emitting any parseable error line.`);
  console.error('That means the type check did not actually run. Raw output:\n');
  console.error(output.trim() || '(no output)');
  process.exit(1);
}

if (update) {
  const errors = {};
  for (const key of [...found.keys()].sort()) errors[key] = [...found.get(key)].sort();
  const specFileFloor = Math.floor(specFileCount * FLOOR_RATIO);
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ readme: README, specFileFloor, errors }, null, 2)}\n`,
  );
  console.log(
    `Baseline rewritten: ${Object.keys(errors).length} entries, ${total} error(s), ` +
      `${specFileCount} spec file(s) covered, floor ${specFileFloor}.`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`Missing ${baselinePath}.`);
  console.error('Fix: run `npm run typecheck:baseline --workspace=@marginfront/api-nest`.');
  process.exit(1);
}

const baselineFile = JSON.parse(readFileSync(baselinePath, 'utf8'));
const baseline = baselineFile.errors ?? {};
const specFileFloor = baselineFile.specFileFloor;

if (typeof specFileFloor !== 'number') {
  console.error(`${baselinePath} has no numeric specFileFloor.`);
  console.error('Fix: run `npm run typecheck:baseline --workspace=@marginfront/api-nest`.');
  process.exit(1);
}

for (const [key, value] of Object.entries(baseline)) {
  if (Array.isArray(value)) continue;
  console.error(`Baseline entry "${key}" is a count, not a list of messages.`);
  console.error('A count-keyed baseline lets a same-code error swap pass.');
  console.error('Fix: run `npm run typecheck:baseline --workspace=@marginfront/api-nest`.');
  process.exit(1);
}

/** Multiset of messages -> Map<message, occurrences>. */
function tally(messages) {
  const counts = new Map();
  for (const message of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
  return counts;
}

const regressions = [];
const improvements = [];

for (const key of new Set([...found.keys(), ...Object.keys(baseline)])) {
  const nowCounts = tally(found.get(key) ?? []);
  const wasCounts = tally(baseline[key] ?? []);

  for (const [message, count] of nowCounts) {
    const allowed = wasCounts.get(message) ?? 0;
    if (count > allowed) regressions.push({ key, message, count, allowed });
  }
  for (const [message, count] of wasCounts) {
    const now = nowCounts.get(message) ?? 0;
    if (now < count) improvements.push({ key, message, was: count, now });
  }
}

const coverageShortfall = specFileCount < specFileFloor;

if (regressions.length === 0 && improvements.length === 0 && !coverageShortfall) {
  console.log(
    `Type check clean. ${specFileCount} spec file(s) covered (floor ${specFileFloor}), ` +
      `${total} baselined error(s), unchanged.`,
  );
  process.exit(0);
}

if (coverageShortfall) {
  console.error(
    '\nTYPE-CHECK COVERAGE SHRANK. The gate is checking fewer files than it used to:\n',
  );
  console.error(`  ${specFileCount} spec file(s) resolved, floor is ${specFileFloor}.`);
  console.error(
    '\nA narrower tsconfig.spec.json passes the error tally while covering less, which is\n' +
      'exactly the silent-green failure this gate exists to stop. Either widen the config\n' +
      'back, or - if specs were deliberately deleted - re-run\n' +
      '`npm run typecheck:baseline --workspace=@marginfront/api-nest` and say so in the PR.',
  );
}

if (regressions.length > 0) {
  console.error('\nNEW TYPE ERRORS. Not in the baseline, so they have to be fixed:\n');
  for (const r of regressions) {
    console.error(`  ${r.key}`);
    console.error(`    ${r.message}`);
    console.error(`    seen ${r.count}x, baseline allows ${r.allowed}x`);
  }
  console.error('\nFull tsc output:\n');
  console.error(output.trim());
}

if (improvements.length > 0) {
  console.error('\nERRORS THE BASELINE STILL LISTS THAT TSC NO LONGER REPORTS:\n');
  for (const i of improvements) {
    console.error(`  ${i.key}`);
    console.error(`    ${i.message}`);
    console.error(`    baseline expects ${i.was}x, saw ${i.now}x`);
  }
  console.error('\nGood news, stale baseline. If a matching NEW TYPE ERROR is listed above,');
  console.error('the same error was swapped for a different one and the fix is incomplete.');
  console.error('\nFix: run `npm run typecheck:baseline --workspace=@marginfront/api-nest`');
  console.error('and commit the updated typecheck-baseline.json.');
}

process.exit(1);
