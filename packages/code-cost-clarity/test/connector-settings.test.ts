// connector-settings.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES: proves the ~/.claude/settings.json telemetry writer and
// its surgical reverter are SAFE on a developer's real, global config. Every test
// runs against an actual temp file and asserts the actual bytes on disk - these
// are designed to FAIL if the merge clobbers a user value, if a malformed file
// gets corrupted, if uninstall removes something it didn't write, or if the
// secret API key ever leaks into the settings file.
//
// Why so paranoid: this is the one place the package touches a file the user
// owns and Claude Code reads on every run. A bad merge here is the difference
// between "telemetry turned on" and "a developer whose config is broken."
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeClaudeTelemetrySettings,
  removeClaudeTelemetrySettings,
  CCC_OWNED_TELEMETRY_KEYS,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SETTINGS_OWNERSHIP_PATH,
} from "../src/connector";

// The eight telemetry vars exactly as the connector would hand them in - the same
// values renderEnvFile() bakes into the .env. The API key is deliberately NOT
// here; it must never touch settings.json.
const TELEMETRY_VARS: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  OTEL_METRIC_EXPORT_INTERVAL: "300000",
  OTEL_LOGS_EXPORT_INTERVAL: "300000",
  OTEL_LOG_TOOL_DETAILS: "1",
};

// Silence the progress logging so test output stays readable; we assert on
// return values + file contents, not on log lines.
const QUIET = { log: () => {} };

// Fresh isolated temp paths for one test. Settings + ownership both live under
// the same throwaway dir so nothing leaks between tests or onto the real machine.
function freshPaths(label: string): {
  settingsPath: string;
  ownershipPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), `ccc-settings-${label}-`));
  return {
    settingsPath: join(dir, "settings.json"),
    ownershipPath: join(dir, "claude-settings-owned.json"),
  };
}

// Convenience: read + parse a settings file written by the code under test.
function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- the exported constants ---------------------------------------------------

test("CCC_OWNED_TELEMETRY_KEYS is the eight telemetry vars and never the API key", () => {
  // Exactly the OTLP / CLAUDE_CODE_ENABLE_TELEMETRY / OTEL_LOG_TOOL_DETAILS set -
  // no more, no less.
  expect([...CCC_OWNED_TELEMETRY_KEYS].sort()).toEqual(
    [
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "OTEL_LOGS_EXPORTER",
      "OTEL_LOGS_EXPORT_INTERVAL",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_METRICS_EXPORTER",
      "OTEL_METRIC_EXPORT_INTERVAL",
    ].sort(),
  );
  // The secret key must NOT be in the managed set.
  expect(CCC_OWNED_TELEMETRY_KEYS).not.toContain("MARGINFRONT_API_KEY");
});

test("CLAUDE_SETTINGS_PATH points at ~/.claude/settings.json and ownership lives under our own dir", () => {
  expect(CLAUDE_SETTINGS_PATH.endsWith(join(".claude", "settings.json"))).toBe(
    true,
  );
  // The ownership marker is under ~/.marginfront-ccc, NOT inside ~/.claude.
  expect(CLAUDE_SETTINGS_OWNERSHIP_PATH.includes(".marginfront-ccc")).toBe(
    true,
  );
  expect(CLAUDE_SETTINGS_OWNERSHIP_PATH.includes(".claude")).toBe(false);
});

// --- empty / missing file ----------------------------------------------------

test("creates a valid settings.json from scratch when the file is missing", () => {
  const { settingsPath, ownershipPath } = freshPaths("missing");
  expect(existsSync(settingsPath)).toBe(false);

  const result = writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  // All eight landed; nothing skipped; no backup (there was no prior file).
  expect(result.written.sort()).toEqual([...CCC_OWNED_TELEMETRY_KEYS].sort());
  expect(result.skipped).toEqual([]);
  expect(result.backupPath).toBeNull();

  // The file is real, parseable, and carries every telemetry var verbatim.
  const settings = readSettings(settingsPath);
  expect(settings.env).toEqual(TELEMETRY_VARS);

  // Trailing newline + 2-space indent, matching Claude Code's own format.
  const raw = readFileSync(settingsPath, "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw).toBe(JSON.stringify({ env: TELEMETRY_VARS }, null, 2) + "\n");

  // The ownership receipt records all eight as ours.
  const ownership = readSettings(ownershipPath) as {
    ownedKeys: Record<string, string>;
  };
  expect(ownership.ownedKeys).toEqual(TELEMETRY_VARS);
});

test("merges into an existing empty {} settings file", () => {
  const { settingsPath, ownershipPath } = freshPaths("empty");
  writeFileSync(settingsPath, "{}\n");

  const result = writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  expect(result.written.length).toBe(8);
  // The file existed, so a backup of the original {} must have been made.
  expect(result.backupPath).toBe(`${settingsPath}.ccc-bak`);
  expect(readFileSync(`${settingsPath}.ccc-bak`, "utf8")).toBe("{}\n");

  expect(readSettings(settingsPath).env).toEqual(TELEMETRY_VARS);
});

// --- pre-existing UNRELATED env keys are preserved ---------------------------

test("preserves pre-existing unrelated env keys when merging", () => {
  const { settingsPath, ownershipPath } = freshPaths("env-keep");
  const original = {
    env: { EDITOR: "vim", MY_OWN_TOKEN: "do-not-touch" },
  };
  writeFileSync(settingsPath, JSON.stringify(original, null, 2) + "\n");

  writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  const env = readSettings(settingsPath).env as Record<string, string>;
  // The user's own env vars are untouched...
  expect(env.EDITOR).toBe("vim");
  expect(env.MY_OWN_TOKEN).toBe("do-not-touch");
  // ...and the eight telemetry vars are now present alongside them.
  for (const key of CCC_OWNED_TELEMETRY_KEYS) {
    expect(env[key]).toBe(TELEMETRY_VARS[key]);
  }
});

// --- unrelated TOP-LEVEL settings are preserved ------------------------------

test("preserves unrelated top-level settings when merging", () => {
  const { settingsPath, ownershipPath } = freshPaths("toplevel-keep");
  const original = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model: "claude-opus-4",
    permissions: { allow: ["Bash(npm:*)"], deny: [] },
    env: { FOO: "bar" },
  };
  writeFileSync(settingsPath, JSON.stringify(original, null, 2) + "\n");

  writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  const settings = readSettings(settingsPath);
  // Every unrelated top-level key survives, byte-for-byte in value.
  expect(settings.$schema).toBe(original.$schema);
  expect(settings.model).toBe("claude-opus-4");
  expect(settings.permissions).toEqual({ allow: ["Bash(npm:*)"], deny: [] });
  // The unrelated env key survives too, plus the telemetry vars.
  expect((settings.env as Record<string, string>).FOO).toBe("bar");
  expect((settings.env as Record<string, string>).OTEL_LOGS_EXPORTER).toBe(
    "otlp",
  );
});

// --- malformed JSON: back up + throw, NEVER corrupt --------------------------

test("malformed JSON is backed up and the write THROWS without corrupting the file", () => {
  const { settingsPath, ownershipPath } = freshPaths("malformed");
  // Deliberately broken JSON (trailing comma + unclosed brace).
  const broken = '{ "model": "opus", "env": { "FOO": "bar", }';
  writeFileSync(settingsPath, broken);

  expect(() =>
    writeClaudeTelemetrySettings(TELEMETRY_VARS, {
      settingsPath,
      ownershipPath,
      ...QUIET,
    }),
  ).toThrow(/valid JSON/);

  // A backup of the original broken bytes was made...
  expect(existsSync(`${settingsPath}.ccc-bak`)).toBe(true);
  expect(readFileSync(`${settingsPath}.ccc-bak`, "utf8")).toBe(broken);
  // ...and the original file is byte-for-byte untouched (NOT corrupted).
  expect(readFileSync(settingsPath, "utf8")).toBe(broken);
  // No ownership receipt is written when we refused to touch the file.
  expect(existsSync(ownershipPath)).toBe(false);
});

// --- non-object "env": back up + throw ---------------------------------------

test("a non-object env (array / null / string) is backed up and THROWS, never clobbered", () => {
  // Each of these is valid JSON but an "env" we must refuse to overwrite.
  for (const badEnv of [
    '{ "env": [1, 2, 3] }',
    '{ "env": null }',
    '{ "env": "nope" }',
  ]) {
    const { settingsPath, ownershipPath } = freshPaths("bad-env");
    writeFileSync(settingsPath, badEnv);

    expect(() =>
      writeClaudeTelemetrySettings(TELEMETRY_VARS, {
        settingsPath,
        ownershipPath,
        ...QUIET,
      }),
    ).toThrow(/Could not update/);

    // Backup made, original untouched, no ownership receipt.
    expect(readFileSync(`${settingsPath}.ccc-bak`, "utf8")).toBe(badEnv);
    expect(readFileSync(settingsPath, "utf8")).toBe(badEnv);
    expect(existsSync(ownershipPath)).toBe(false);
  }
});

// --- idempotent re-write: a second identical call changes nothing ------------

test("a second identical write is a true no-op (file unchanged, no new backup)", () => {
  const { settingsPath, ownershipPath } = freshPaths("idempotent");
  writeFileSync(settingsPath, "{}\n");

  writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });
  const afterFirst = readFileSync(settingsPath, "utf8");
  const ownershipAfterFirst = readFileSync(ownershipPath, "utf8");

  const second = writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  // The settings file is byte-identical to after the first write...
  expect(readFileSync(settingsPath, "utf8")).toBe(afterFirst);
  // ...the ownership receipt is unchanged...
  expect(readFileSync(ownershipPath, "utf8")).toBe(ownershipAfterFirst);
  // ...and the second call didn't even write (no backup made on a no-op).
  expect(second.backupPath).toBeNull();
  // The keys we already own are still reported as ours (carry-forward).
  expect(second.written.sort()).toEqual([...CCC_OWNED_TELEMETRY_KEYS].sort());
  expect(second.skipped).toEqual([]);
});

// --- clean revert leaves every sibling setting byte-identical ----------------

test("a clean revert restores the file byte-for-byte and deletes the ownership receipt", () => {
  const { settingsPath, ownershipPath } = freshPaths("revert");
  const original = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model: "claude-opus-4",
    env: { EDITOR: "vim", MY_OWN_TOKEN: "keep-me" },
    permissions: { allow: ["Bash"] },
  };
  // Exactly Claude Code's native format: 2-space indent + trailing newline.
  const originalBytes = JSON.stringify(original, null, 2) + "\n";
  writeFileSync(settingsPath, originalBytes);

  writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });
  // Sanity: the write really did add the telemetry keys.
  expect(
    (readSettings(settingsPath).env as Record<string, string>)
      .OTEL_LOGS_EXPORTER,
  ).toBe("otlp");

  const result = removeClaudeTelemetrySettings({
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  // All eight we wrote were removed; nothing of the user's was kept-as-changed.
  expect(result.removed.sort()).toEqual([...CCC_OWNED_TELEMETRY_KEYS].sort());
  expect(result.kept).toEqual([]);
  // THE BIG ONE: the file is byte-for-byte what it was before we ever touched it.
  expect(readFileSync(settingsPath, "utf8")).toBe(originalBytes);
  // The ownership receipt is gone after a clean uninstall.
  expect(existsSync(ownershipPath)).toBe(false);
});

test("revert removes an env block we created entirely, leaving no orphan {}", () => {
  const { settingsPath, ownershipPath } = freshPaths("revert-empty-env");
  // A file with NO env to start - write creates one, revert should remove it.
  const original = { model: "claude-opus-4" };
  const originalBytes = JSON.stringify(original, null, 2) + "\n";
  writeFileSync(settingsPath, originalBytes);

  writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });
  removeClaudeTelemetrySettings({ settingsPath, ownershipPath, ...QUIET });

  const settings = readSettings(settingsPath);
  // The env block we created is gone (no empty {} left behind)...
  expect("env" in settings).toBe(false);
  // ...and the file is identical to the original.
  expect(readFileSync(settingsPath, "utf8")).toBe(originalBytes);
});

test("revert deletes a settings.json that held nothing but our keys, and the empty ~/.claude with it", () => {
  // A Codex-only machine where init created the file: after our keys go there is
  // nothing left to keep, and a leftover `{}` would keep the folder reading as a
  // Claude Code install.
  const home = mkdtempSync(join(tmpdir(), "ccc-revert-ours-"));
  const settingsPath = join(home, ".claude", "settings.json");
  const ownershipPath = join(home, ".marginfront-ccc", "claude-owned.json");
  writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });
  expect(existsSync(settingsPath)).toBe(true);

  const result = removeClaudeTelemetrySettings({
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  expect(result.removed.sort()).toEqual([...CCC_OWNED_TELEMETRY_KEYS].sort());
  expect(result.backupPath).toBeNull();
  expect(existsSync(settingsPath)).toBe(false);
  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(existsSync(ownershipPath)).toBe(false);
});

// --- a user's pre-set CLAUDE_CODE_ENABLE_TELEMETRY=1 survives uninstall ------

test("a value the USER pre-set (same as ours) is never owned and SURVIVES uninstall", () => {
  const { settingsPath, ownershipPath } = freshPaths("user-preset");
  // The user had already turned telemetry on themselves.
  const original = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } };
  writeFileSync(settingsPath, JSON.stringify(original, null, 2) + "\n");

  const writeResult = writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  // We did NOT claim the user's pre-set key - it's reported as skipped...
  expect(writeResult.skipped).toContain("CLAUDE_CODE_ENABLE_TELEMETRY");
  // ...and the ownership receipt does not list it (so revert won't touch it).
  const ownedKeys = (
    readSettings(ownershipPath) as { ownedKeys: Record<string, string> }
  ).ownedKeys;
  expect("CLAUDE_CODE_ENABLE_TELEMETRY" in ownedKeys).toBe(false);
  // The other seven WERE added by us.
  expect(Object.keys(ownedKeys).sort()).toEqual(
    [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "OTEL_LOGS_EXPORTER",
      "OTEL_LOGS_EXPORT_INTERVAL",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_METRICS_EXPORTER",
      "OTEL_METRIC_EXPORT_INTERVAL",
    ].sort(),
  );

  const removeResult = removeClaudeTelemetrySettings({
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  // The user's pre-set telemetry flag is STILL THERE after uninstall.
  const env = readSettings(settingsPath).env as Record<string, string>;
  expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  // We removed only the seven we actually added.
  expect(removeResult.removed.length).toBe(7);
  expect(removeResult.removed).not.toContain("CLAUDE_CODE_ENABLE_TELEMETRY");
});

// --- a value we wrote but the user CHANGED afterward survives uninstall -------

test("a value we wrote but the user later CHANGED is left alone on uninstall", () => {
  const { settingsPath, ownershipPath } = freshPaths("user-changed");
  // Fresh install: we own all eight.
  writeClaudeTelemetrySettings(TELEMETRY_VARS, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  // The user then hand-edits ONE of our values (e.g. wants a slower flush).
  const edited = readSettings(settingsPath);
  (edited.env as Record<string, string>).OTEL_METRIC_EXPORT_INTERVAL = "60000";
  writeFileSync(settingsPath, JSON.stringify(edited, null, 2) + "\n");

  const removeResult = removeClaudeTelemetrySettings({
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  const env = readSettings(settingsPath).env as Record<string, string>;
  // The user's changed value is preserved (we only delete OUR exact value)...
  expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBe("60000");
  expect(removeResult.kept).toContain("OTEL_METRIC_EXPORT_INTERVAL");
  // ...the env block survives because the user's key is still in it...
  expect("env" in readSettings(settingsPath)).toBe(true);
  // ...and the other seven (untouched by the user) were removed.
  expect(removeResult.removed.length).toBe(7);
  expect(removeResult.removed).not.toContain("OTEL_METRIC_EXPORT_INTERVAL");
});

// --- the API key NEVER reaches the settings file -----------------------------

test("the MarginFront secret key is never written into settings.json, even if passed in", () => {
  const { settingsPath, ownershipPath } = freshPaths("no-secret");
  // A caller mistakenly hands us the secret alongside the telemetry vars.
  const varsWithSecret = {
    ...TELEMETRY_VARS,
    MARGINFRONT_API_KEY: "mf_sk_live_THIS_MUST_NEVER_LAND_HERE",
  };

  const result = writeClaudeTelemetrySettings(varsWithSecret, {
    settingsPath,
    ownershipPath,
    ...QUIET,
  });

  // The raw file text must not contain the secret value OR the key name.
  const raw = readFileSync(settingsPath, "utf8");
  expect(raw.includes("mf_sk_live_THIS_MUST_NEVER_LAND_HERE")).toBe(false);
  expect(raw.includes("MARGINFRONT_API_KEY")).toBe(false);
  // The parsed env carries the eight telemetry vars and nothing else.
  expect(readSettings(settingsPath).env).toEqual(TELEMETRY_VARS);
  // The secret never gets reported as written, nor recorded in the receipt.
  expect(result.written).not.toContain("MARGINFRONT_API_KEY");
  const ownedKeys = (
    readSettings(ownershipPath) as { ownedKeys: Record<string, string> }
  ).ownedKeys;
  expect("MARGINFRONT_API_KEY" in ownedKeys).toBe(false);
  const ownershipRaw = readFileSync(ownershipPath, "utf8");
  expect(ownershipRaw.includes("mf_sk_live_THIS_MUST_NEVER_LAND_HERE")).toBe(
    false,
  );
});

// --- uninstall is a soft no-op when there's nothing to undo ------------------

test("uninstall with no ownership receipt warns and does NOT throw", () => {
  const { settingsPath, ownershipPath } = freshPaths("no-receipt");
  // A settings file exists, but we never recorded ownership of anything.
  writeFileSync(
    settingsPath,
    JSON.stringify({ env: { FOO: "bar" } }, null, 2) + "\n",
  );

  let result!: ReturnType<typeof removeClaudeTelemetrySettings>;
  expect(() => {
    result = removeClaudeTelemetrySettings({
      settingsPath,
      ownershipPath,
      ...QUIET,
    });
  }).not.toThrow();

  // Nothing removed, and the user's file is untouched.
  expect(result.removed).toEqual([]);
  expect((readSettings(settingsPath).env as Record<string, string>).FOO).toBe(
    "bar",
  );
});

// ---------------------------------------------------------------------------
// PER-DEVELOPER ATTRIBUTION: the CCC_DEVELOPER_EMAIL .env writer + git default.
// ---------------------------------------------------------------------------
// WHAT THESE PROVE: writeDeveloperEmailToEnv drops the chosen developer onto the
// CCC_DEVELOPER_EMAIL= line WITHOUT disturbing anything else in the settings file
// (especially the secret API key), a blank value writes an empty line (the
// "auto-detect" sentinel), and the .env template ships the line so it's always
// present. gitGlobalUserEmail is best-effort and must never throw.

import {
  writeDeveloperEmailToEnv,
  gitGlobalUserEmail,
  renderEnvFile,
} from "../src/connector";

function freshEnvPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ccc-developer-${label}-`));
  return join(dir, ".env");
}

test("the .env template ships an empty CCC_DEVELOPER_EMAIL line (blank = auto-detect)", () => {
  expect(renderEnvFile()).toMatch(/^CCC_DEVELOPER_EMAIL=$/m);
});

test("writeDeveloperEmailToEnv sets the developer WITHOUT touching the API key", () => {
  const path = freshEnvPath("set");
  // Start from a realistic settings file that already holds a secret key.
  writeFileSync(
    path,
    "CCC_DEVELOPER_EMAIL=\nMARGINFRONT_API_KEY=mf_sk_secret_value\n",
  );
  writeDeveloperEmailToEnv("developer@example.com", path);
  const after = readFileSync(path, "utf8");
  expect(after).toMatch(/^CCC_DEVELOPER_EMAIL=developer@example\.com$/m);
  // The secret key line is byte-for-byte untouched.
  expect(after).toContain("MARGINFRONT_API_KEY=mf_sk_secret_value");
});

test("writeDeveloperEmailToEnv with a BLANK value writes an empty line (runtime = unset)", () => {
  const path = freshEnvPath("blank");
  writeFileSync(path, "CCC_DEVELOPER_EMAIL=old@example.com\n");
  writeDeveloperEmailToEnv("", path);
  const after = readFileSync(path, "utf8");
  // Overwritten to empty - the forwarder reads this as "no override, auto-detect."
  expect(after).toMatch(/^CCC_DEVELOPER_EMAIL=$/m);
  expect(after).not.toContain("old@example.com");
});

test("writeDeveloperEmailToEnv appends the line if it's missing (older .env)", () => {
  const path = freshEnvPath("append");
  // An .env with no CCC_DEVELOPER_EMAIL line at all.
  writeFileSync(path, "MARGINFRONT_API_KEY=mf_sk_old\n");
  writeDeveloperEmailToEnv("late@example.com", path);
  const after = readFileSync(path, "utf8");
  expect(after).toMatch(/^CCC_DEVELOPER_EMAIL=late@example\.com$/m);
  expect(after).toContain("MARGINFRONT_API_KEY=mf_sk_old");
});

test("writeDeveloperEmailToEnv creates a well-formed file from the template when none exists", () => {
  const path = freshEnvPath("create");
  // Path does not exist yet - the writer falls back to the template.
  writeDeveloperEmailToEnv("fresh@example.com", path);
  const after = readFileSync(path, "utf8");
  expect(after).toMatch(/^CCC_DEVELOPER_EMAIL=fresh@example\.com$/m);
  // The template's API-key line is still present (empty).
  expect(after).toMatch(/^MARGINFRONT_API_KEY=$/m);
});

test("gitGlobalUserEmail is best-effort: returns a string and never throws", () => {
  // Whatever this machine's git config is (set, unset, or git missing), the call is
  // safe and returns a string we can pre-fill the prompt with.
  expect(() => gitGlobalUserEmail()).not.toThrow();
  expect(typeof gitGlobalUserEmail()).toBe("string");
});
