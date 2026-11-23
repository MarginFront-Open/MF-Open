// zshrc-migration.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: the helpers that find the redundant source line
// correctly DETECT the redundant `source ~/.marginfront-ccc/.env` line in a user's
// ~/.zshrc, and - only when asked - REMOVE exactly that line while leaving every
// other line byte-for-byte, with a safety backup.
//
// WHY IT MATTERS: ~/.zshrc is the user's own file and can hold anything. A detector
// that's too greedy would offer to delete unrelated `source` lines; a remover that
// rewrites more than the matched line would mangle a developer's shell config. So
// every test runs against a REAL temp file and asserts the ACTUAL bytes - these are
// designed to FAIL if the match is too broad/narrow or the rewrite touches a
// sibling line. Nothing here touches the real ~/.zshrc.
//
// It also pins the single-source telemetry-values constant to the owned-keys list,
// so the consent disclosure / settings writer / .env template can't silently desync.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lineSourcesCccEnv,
  findCccZshrcSourceLines,
  removeCccZshrcSourceLine,
  CCC_TELEMETRY_VALUES,
  CCC_OWNED_TELEMETRY_KEYS,
} from "../src/connector";

const QUIET = { log: () => {} };

function freshZshrc(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ccc-zshrc-${label}-`));
  return join(dir, ".zshrc");
}

// --- the single-line detector: matches OURS, ignores everything else ---------

test("lineSourcesCccEnv matches the real source forms and rejects look-alikes", () => {
  // The forms an earlier setup (or a careful user) could have written.
  expect(lineSourcesCccEnv("source ~/.marginfront-ccc/.env")).toBe(true);
  expect(lineSourcesCccEnv(". ~/.marginfront-ccc/.env")).toBe(true);
  expect(lineSourcesCccEnv('source "$HOME/.marginfront-ccc/.env"')).toBe(true);
  expect(lineSourcesCccEnv("   source ~/.marginfront-ccc/.env   ")).toBe(true);

  // These must NOT match - the whole point of being surgical.
  expect(lineSourcesCccEnv("# source ~/.marginfront-ccc/.env")).toBe(false); // commented out
  expect(lineSourcesCccEnv("source ~/.other-tool/.env")).toBe(false); // different tool
  expect(lineSourcesCccEnv("export PATH=$PATH:/usr/local/bin")).toBe(false); // unrelated
  expect(lineSourcesCccEnv("echo source ~/.marginfront-ccc/.env")).toBe(false); // not a source cmd
  expect(lineSourcesCccEnv("")).toBe(false);
});

// --- detection on a real file ------------------------------------------------

test("findCccZshrcSourceLines finds the line amid unrelated config", () => {
  const path = freshZshrc("found");
  writeFileSync(
    path,
    [
      "export EDITOR=vim",
      'alias ll="ls -la"',
      "source ~/.marginfront-ccc/.env",
      "# my own stuff",
      "source ~/.nvm/nvm.sh",
      "",
    ].join("\n"),
  );

  const result = findCccZshrcSourceLines(path);
  expect(result.found).toBe(true);
  expect(result.matchedLines).toEqual(["source ~/.marginfront-ccc/.env"]);
});

test("findCccZshrcSourceLines reports nothing when the line is absent", () => {
  const path = freshZshrc("absent");
  writeFileSync(
    path,
    ["export EDITOR=vim", "source ~/.nvm/nvm.sh", ""].join("\n"),
  );

  const result = findCccZshrcSourceLines(path);
  expect(result.found).toBe(false);
  expect(result.matchedLines).toEqual([]);
});

test("findCccZshrcSourceLines on a missing file is a soft 'found nothing' (never throws)", () => {
  const path = freshZshrc("missing");
  // Note: we never created the file.
  expect(existsSync(path)).toBe(false);
  expect(() => findCccZshrcSourceLines(path)).not.toThrow();
  expect(findCccZshrcSourceLines(path).found).toBe(false);
});

// --- removal: takes out ONLY our line, backs up, keeps the rest byte-for-byte -

test("removeCccZshrcSourceLine deletes only the matched line and preserves the rest", () => {
  const path = freshZshrc("remove");
  const original = [
    "export EDITOR=vim",
    'alias ll="ls -la"',
    "source ~/.marginfront-ccc/.env",
    "# keep this comment",
    "source ~/.nvm/nvm.sh",
    "",
  ].join("\n");
  writeFileSync(path, original);

  const result = removeCccZshrcSourceLine({ zshrcPath: path, ...QUIET });

  // It reported the one line it removed and where the backup landed.
  expect(result.removed).toEqual(["source ~/.marginfront-ccc/.env"]);
  expect(result.backupPath).toBe(`${path}.ccc-bak`);

  // The backup is the EXACT original bytes (the user's safety net).
  expect(readFileSync(`${path}.ccc-bak`, "utf8")).toBe(original);

  // The rewritten file is the original with EXACTLY the one line gone - every
  // sibling line (incl. the unrelated nvm source and the comment) is intact, and
  // the trailing newline is preserved.
  const expected = [
    "export EDITOR=vim",
    'alias ll="ls -la"',
    "# keep this comment",
    "source ~/.nvm/nvm.sh",
    "",
  ].join("\n");
  expect(readFileSync(path, "utf8")).toBe(expected);
});

test("removeCccZshrcSourceLine is a no-op (no backup, file untouched) when the line is absent", () => {
  const path = freshZshrc("remove-noop");
  const original = ["export EDITOR=vim", "source ~/.nvm/nvm.sh", ""].join("\n");
  writeFileSync(path, original);

  const result = removeCccZshrcSourceLine({ zshrcPath: path, ...QUIET });

  expect(result.removed).toEqual([]);
  expect(result.backupPath).toBeNull();
  // No backup was made, and the file is byte-for-byte unchanged.
  expect(existsSync(`${path}.ccc-bak`)).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(original);
});

// --- the telemetry-values constant can't drift from the owned-keys list ------

test("CCC_TELEMETRY_VALUES keys are EXACTLY the owned telemetry keys (no drift, no API key)", () => {
  expect(Object.keys(CCC_TELEMETRY_VALUES).sort()).toEqual(
    [...CCC_OWNED_TELEMETRY_KEYS].sort(),
  );
  // And the secret key is never part of the values written to settings.json.
  expect("MARGINFRONT_API_KEY" in CCC_TELEMETRY_VALUES).toBe(false);
});
