// codex-toml.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES: proves the ~/.codex/config.toml writer and its surgical
// reverter are SAFE on a developer's real config. Like the Claude settings
// writer, this is a place we touch a file the user owns and a tool reads on every
// run - so every test runs against an ACTUAL temp file and asserts the ACTUAL
// bytes on disk. These tests are built to FAIL if we ever:
//   - rewrite a config the user wrote their own [otel] into,
//   - corrupt or fail to preserve unrelated tables on append,
//   - leave junk (or remove too much) on revert,
//   - or double-write our block on a re-run.
//
// We have NO TOML parser on purpose: we only ever add/remove our own fenced block
// and detect a foreign [otel] by its table header. So these tests also pin down
// that header detection (a near-miss like "[otelemetry]" must NOT count).
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  writeCodexOtelConfig,
  removeCodexOtelConfig,
  codexConfigHasCccBlock,
  renderCodexConfigInstructions,
  CODEX_CONFIG_PATH,
  CODEX_CCC_BEGIN_MARKER,
  CODEX_CCC_END_MARKER,
  CODEX_OTEL_TOML_BLOCK,
} from "../src/connector";

// Silence the progress logging; we assert on return values + file bytes.
const QUIET = { log: () => {} };

// A fresh throwaway config path whose ".codex" parent dir ALREADY EXISTS - so a
// test can pre-seed config.toml before exercising the writer/reverter.
function freshConfigPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ccc-codex-${label}-`));
  const configPath = join(dir, ".codex", "config.toml");
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

// A fresh path whose parent dirs do NOT exist yet - used to prove the "created"
// path makes ~/.codex for the user (mkdir recursive on a path two levels deep).
function freshMissingConfigPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ccc-codex-${label}-`));
  return join(dir, "nested", ".codex", "config.toml");
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// --- the exported canonical block is the verified, single-sourced one --------

test("CODEX_OTEL_TOML_BLOCK is the verified [otel] form pointed at /v1/logs", () => {
  expect(CODEX_OTEL_TOML_BLOCK).toContain("[otel]");
  expect(CODEX_OTEL_TOML_BLOCK).toContain(
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }',
  );
});

test("the paste-in instructions render the SAME canonical block (no drift)", () => {
  // The fallback printout and the auto-writer must never diverge: the instructions
  // are built FROM CODEX_OTEL_TOML_BLOCK, so every line of it must appear in them.
  const instructions = renderCodexConfigInstructions();
  for (const line of CODEX_OTEL_TOML_BLOCK.split("\n")) {
    expect(instructions).toContain(line);
  }
});

// --- case 1: no file -> created with the block + markers ---------------------

test("no config.toml -> creates the file (and parent dir) with our fenced block", () => {
  const configPath = freshMissingConfigPath("created");
  expect(existsSync(configPath)).toBe(false);
  expect(existsSync(dirname(configPath))).toBe(false);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("created");
  expect(result.backupPath).toBeNull();
  expect(existsSync(configPath)).toBe(true);

  const content = read(configPath);
  // Both fence posts, the table header, and the verified exporter line are present.
  expect(content).toContain(CODEX_CCC_BEGIN_MARKER);
  expect(content).toContain(CODEX_CCC_END_MARKER);
  expect(content).toContain("[otel]");
  expect(content).toContain(
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }',
  );
  // BEGIN must come before END (a well-formed fence).
  expect(content.indexOf(CODEX_CCC_BEGIN_MARKER)).toBeLessThan(
    content.indexOf(CODEX_CCC_END_MARKER),
  );
  // No backup file is left when we created a brand-new file.
  expect(existsSync(`${configPath}.ccc-bak`)).toBe(false);
});

test("created file never contains an API key (secrets stay out of config.toml)", () => {
  const configPath = freshConfigPath("nosecret");
  writeCodexOtelConfig({ configPath, ...QUIET });
  // The writer takes no key and must never bake one in - config.toml is not .env.
  expect(read(configPath)).not.toMatch(/mf_sk_|mf_pk_/);
});

// --- case 2: file without [otel] -> appended, other tables preserved ---------

test("config.toml with no [otel] -> APPENDS our block and preserves existing tables", () => {
  const configPath = freshConfigPath("append");
  const original = '[profile]\nname = "alex"\nmodel = "gpt-5-codex"\n';
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("appended");
  expect(result.backupPath).toBe(`${configPath}.ccc-bak`);

  const content = read(configPath);
  // Every original byte is still there, untouched, at the front of the file.
  expect(content.startsWith(original)).toBe(true);
  // ...and our block was added after it.
  expect(content).toContain(CODEX_CCC_BEGIN_MARKER);
  expect(content).toContain("[otel]");
  expect(content).toContain(CODEX_CCC_END_MARKER);
  // The safety backup is an exact copy of the pre-write file.
  expect(read(`${configPath}.ccc-bak`)).toBe(original);
});

// --- case 3: file WITH a user [otel] -> skipped-existing, byte-identical ------

test("config.toml with the user's OWN [otel] -> SKIPPED and left byte-identical", () => {
  const configPath = freshConfigPath("userotel");
  const original =
    '[otel]\nexporter = "none"\nlog_user_prompt = true\n\n[profile]\nname = "alex"\n';
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("skipped-existing");
  expect(result.backupPath).toBeNull();
  // We must NOT have touched a single byte of their config.
  expect(read(configPath)).toBe(original);
  // And we must NOT have left a backup (we never wrote, so there's nothing to back up).
  expect(existsSync(`${configPath}.ccc-bak`)).toBe(false);
});

test("a [otel.sub-table] header also counts as the user owning [otel] (skipped)", () => {
  const configPath = freshConfigPath("subtable");
  const original = '[otel.exporter]\nkind = "custom"\n';
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("skipped-existing");
  expect(read(configPath)).toBe(original);
});

test('a near-miss like "[otelemetry]" is NOT [otel] -> we still append', () => {
  const configPath = freshConfigPath("nearmiss");
  // "otelemetry" must not be mistaken for the "otel" table.
  const original = "[otelemetry]\nfoo = 1\n";
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("appended");
  expect(read(configPath).startsWith(original)).toBe(true);
  expect(read(configPath)).toContain("[otel]");
});

// --- detect a HEADER-LESS otel the user defined with dotted keys / inline ----------
// A user can open the otel table WITHOUT an "[otel]" header - either with a root-level
// dotted key (otel.environment = "prod") or an inline table (otel = { ... }). Both are
// legal TOML. If we only watched for "[otel]" headers we'd APPEND a second "[otel]"
// block and produce a config that redefines a table - INVALID TOML that bricks Codex.
// These tests prove we leave such a config byte-identical.

test("a root-level dotted otel key (otel.environment) counts as the user owning otel -> SKIPPED, byte-identical", () => {
  const configPath = freshConfigPath("dottedotel");
  const original = 'otel.environment = "prod"\n\n[profile]\nname = "alex"\n';
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("skipped-existing");
  expect(result.backupPath).toBeNull();
  // Not one byte of their config may change, and no second [otel] may appear.
  expect(read(configPath)).toBe(original);
  expect(read(configPath)).not.toContain(CODEX_CCC_BEGIN_MARKER);
  // And we must NOT have left a backup (we never wrote, so there's nothing to back up).
  expect(existsSync(`${configPath}.ccc-bak`)).toBe(false);
});

test("an inline-table otel = { ... } counts as the user owning otel -> SKIPPED, byte-identical", () => {
  const configPath = freshConfigPath("inlineotel");
  const original =
    'otel = { environment = "prod" }\n[profile]\nname = "alex"\n';
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("skipped-existing");
  expect(read(configPath)).toBe(original);
  expect(read(configPath)).not.toContain(CODEX_CCC_BEGIN_MARKER);
});

test('a root-level "otelemetry" key (not "otel") is a near-miss -> we still append', () => {
  // The header-less detection must be as precise as the header one: a key whose first
  // bare token only STARTS with "otel" is not the otel table.
  const configPath = freshConfigPath("rootnearmiss");
  const original = "otelemetry = true\n[profile]\nx = 1\n";
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("appended");
  expect(read(configPath).startsWith(original)).toBe(true);
  expect(read(configPath)).toContain(CODEX_CCC_BEGIN_MARKER);
});

test('a key whose VALUE merely mentions otel (model = "otel-ish") does NOT count -> we append', () => {
  // We read the key NAME, never its value, so an otel-ish value can't block us.
  const configPath = freshConfigPath("valuementions");
  const original = 'model = "otel-ish"\n';
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("appended");
  expect(read(configPath)).toContain(CODEX_CCC_BEGIN_MARKER);
});

test('an "[otel]" written only in a comment does NOT count (we still append)', () => {
  const configPath = freshConfigPath("comment");
  // A commented-out header is inert to Codex, so it must not block our append.
  const original =
    "# I was thinking about adding [otel] here someday\n[profile]\nx = 1\n";
  writeFileSync(configPath, original);

  const result = writeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("appended");
  expect(read(configPath)).toContain(CODEX_CCC_BEGIN_MARKER);
});

// --- idempotency: a re-run must not double-write ------------------------------

test("running the writer twice is idempotent (second run is skipped, ONE block)", () => {
  const configPath = freshConfigPath("idempotent");
  const original = '[profile]\nname = "alex"\n';
  writeFileSync(configPath, original);

  const first = writeCodexOtelConfig({ configPath, ...QUIET });
  expect(first.action).toBe("appended");
  const afterFirst = read(configPath);

  const second = writeCodexOtelConfig({ configPath, ...QUIET });
  expect(second.action).toBe("skipped-existing");
  expect(second.backupPath).toBeNull();
  // The file is unchanged on the second run...
  expect(read(configPath)).toBe(afterFirst);
  // ...and there is exactly ONE block (no double-append).
  const beginCount = read(configPath).split(CODEX_CCC_BEGIN_MARKER).length - 1;
  expect(beginCount).toBe(1);
});

// --- the marker helper cli.ts relies on --------------------------------------

test("codexConfigHasCccBlock is true after we write and false otherwise", () => {
  const configPath = freshConfigPath("hasblock");
  // Missing file -> false (no throw).
  expect(codexConfigHasCccBlock(configPath)).toBe(false);

  // A user's own [otel] is NOT our block -> still false.
  writeFileSync(configPath, '[otel]\nexporter = "none"\n');
  expect(codexConfigHasCccBlock(configPath)).toBe(false);

  // Their own [otel] means we skip - so our marker is still absent.
  writeCodexOtelConfig({ configPath, ...QUIET });
  expect(codexConfigHasCccBlock(configPath)).toBe(false);

  // A fresh file we create DOES carry our marker.
  const created = freshConfigPath("hasblock2");
  writeCodexOtelConfig({ configPath: created, ...QUIET });
  expect(codexConfigHasCccBlock(created)).toBe(true);
});

// --- revert: removes ONLY our block, byte-identical otherwise -----------------

test("write-then-revert leaves an appended-to config BYTE-IDENTICAL to the original", () => {
  const configPath = freshConfigPath("roundtrip");
  const original = '[profile]\nname = "alex"\nmodel = "gpt-5-codex"\n';
  writeFileSync(configPath, original);

  writeCodexOtelConfig({ configPath, ...QUIET });
  // Sanity: our block really is in there now.
  expect(read(configPath)).toContain(CODEX_CCC_BEGIN_MARKER);

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("removed");
  expect(result.backupPath).toBe(`${configPath}.ccc-bak`);
  // The headline guarantee: the file is exactly what it was before we touched it.
  expect(read(configPath)).toBe(original);
});

// --- byte-identical round-trip even with NO trailing newline -----------------------
// The writer inserts exactly ONE newline and the reverter strips exactly ONE, so the
// round-trip is exact even for a non-newline-terminated original. Adding a second,
// separator newline would leave a phantom trailing newline after the revert.

test("write-then-revert is BYTE-IDENTICAL even when the original has NO trailing newline", () => {
  const configPath = freshConfigPath("nonewline");
  // Deliberately NO trailing "\n".
  const original = '[profile]\nname = "alex"';
  writeFileSync(configPath, original);
  expect(read(configPath).endsWith("\n")).toBe(false);

  const writeResult = writeCodexOtelConfig({ configPath, ...QUIET });
  expect(writeResult.action).toBe("appended");
  // Sanity: we really did append our block (the original's bytes are still at the front).
  expect(read(configPath).startsWith(original)).toBe(true);
  expect(read(configPath)).toContain(CODEX_CCC_BEGIN_MARKER);

  const removeResult = removeCodexOtelConfig({ configPath, ...QUIET });
  expect(removeResult.action).toBe("removed");
  // The whole point: exactly the original bytes back, INCLUDING the absence of a
  // trailing newline - no phantom byte left behind.
  expect(read(configPath)).toBe(original);
  expect(read(configPath).endsWith("\n")).toBe(false);
});

// --- revert must NOT clobber the pristine append-time backup -----------------------
// The backup written at append time is the user's true original, from before our
// block went in. If the revert re-backed-up to the SAME path, it would overwrite
// that pristine copy with
// the with-our-block version - leaving the user with no way to recover their real
// original if anything ever went wrong. This test proves the append-time backup
// survives an init->uninstall cycle untouched.

test("revert does NOT clobber the pristine append-time backup (true original survives init->uninstall)", () => {
  const configPath = freshConfigPath("backupsurvives");
  const original = '[profile]\nname = "alex"\nmodel = "gpt-5-codex"\n';
  writeFileSync(configPath, original);

  writeCodexOtelConfig({ configPath, ...QUIET });
  const backupPath = `${configPath}.ccc-bak`;
  // After append, the backup is the pristine original.
  expect(read(backupPath)).toBe(original);

  const removeResult = removeCodexOtelConfig({ configPath, ...QUIET });
  // The revert points at the pristine backup it found (it did NOT make a new one).
  expect(removeResult.backupPath).toBe(backupPath);
  // After the revert, the backup is STILL the pristine original - not overwritten
  // with the with-our-block version - so the real file is always recoverable.
  expect(read(backupPath)).toBe(original);
  expect(read(backupPath)).not.toContain(CODEX_CCC_BEGIN_MARKER);
});

test("revert removes ONLY the fenced block when it sits BETWEEN other tables", () => {
  // Our writer always appends at the end, but a hand-edit could move the block. The
  // reverter must still cut precisely and rejoin the surrounding tables untouched.
  const configPath = freshConfigPath("middle");
  const before = "[a]\nx = 1\n";
  const after = "[b]\ny = 2\n";
  const block = [
    CODEX_CCC_BEGIN_MARKER,
    "[otel]",
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }',
    CODEX_CCC_END_MARKER,
  ].join("\n");
  // Mirror exactly how the writer fences a block: one blank line before it, a
  // trailing newline after it.
  writeFileSync(configPath, before + "\n" + block + "\n" + after);

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("removed");
  // Both surrounding tables survive, byte-for-byte, with nothing of ours left behind.
  expect(read(configPath)).toBe(before + after);
  expect(read(configPath)).not.toContain("[otel]");
  expect(read(configPath)).not.toContain(CODEX_CCC_BEGIN_MARKER);
});

test("revert on a file that is ONLY our block leaves it empty", () => {
  const configPath = freshConfigPath("onlyblock");
  writeCodexOtelConfig({ configPath, ...QUIET }); // 'created' -> file is only our block

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("removed");
  // Emptying the file is explicitly fine.
  expect(read(configPath)).toBe("");
});

// --- revert soft no-ops: never throw on uninstall -----------------------------

test("revert with NO marker present is a no-op (file left untouched)", () => {
  const configPath = freshConfigPath("nomarker");
  const original = '[profile]\nname = "alex"\n';
  writeFileSync(configPath, original);

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("no-marker");
  expect(result.backupPath).toBeNull();
  // Nothing of ours is here, so nothing changes - and no backup is made.
  expect(read(configPath)).toBe(original);
  expect(existsSync(`${configPath}.ccc-bak`)).toBe(false);
});

test("revert when config.toml doesn't exist is a soft no-op (no throw)", () => {
  const configPath = freshConfigPath("missing");
  expect(existsSync(configPath)).toBe(false);

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("missing");
  expect(result.backupPath).toBeNull();
  // Still doesn't exist - we didn't accidentally create it.
  expect(existsSync(configPath)).toBe(false);
});

// --- the default path is the real ~/.codex/config.toml ------------------------

test("CODEX_CONFIG_PATH points at the user's ~/.codex/config.toml", () => {
  expect(CODEX_CONFIG_PATH.endsWith(join(".codex", "config.toml"))).toBe(true);
});

// ===========================================================================
// Codex writes its OWN state inside our fence
// ---------------------------------------------------------------------------
// Codex appends its own tables to the end of config.toml, and the end of the file
// is INSIDE our fence. So tables such as [tui.model_availability_nux] and
// [hooks.state] can sit between our BEGIN and END markers. [hooks.state] holds the
// record of which hooks the developer has REVIEWED AND APPROVED. A
// marker-to-marker delete on uninstall would throw that away silently, so after
// uninstalling and reinstalling, every hook they had trusted would be untrusted
// again with no explanation.
//
// The fixture below has a real file's shape. The expectation is exact bytes,
// and there is a negative control proving a marker-to-marker delete fails it.
// ===========================================================================

// The lines code-cost-clarity writes. Everything else in the fixture belongs to Codex or
// to the developer, and must survive.
const CCC_LINES = [
  CODEX_CCC_BEGIN_MARKER,
  "[otel]",
  'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }',
  CODEX_CCC_END_MARKER,
];

// A realistic config.toml: the developer's own settings, our fenced
// block, and Codex's self-written tables sitting INSIDE the fence.
function realisticConfig(): string {
  return [
    'model = "gpt-5.6-sol"',
    "",
    '[projects."/Users/alex/projects/sample-app"]',
    'trust_level = "trusted"',
    "",
    '[projects."/Users/alex/.marginfront-ccc-test/workspace"]',
    'trust_level = "trusted"',
    "",
    CODEX_CCC_BEGIN_MARKER,
    "[otel]",
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }',
    "",
    "[tui.model_availability_nux]",
    '"gpt-5.5" = 2',
    '"gpt-5.6-sol" = 1',
    "",
    "[hooks.state]",
    "",
    '[hooks.state."/Users/alex/.codex/hooks.json:pre_tool_use:0:0"]',
    'trusted_hash = "sha256:2ed1ac9629ddfb4d2634955ca16ad2c912302e8b10b13e59586b36c3d6ca9f8c"',
    CODEX_CCC_END_MARKER,
    "",
  ].join("\n");
}

// What the file MUST look like afterwards: the original, minus our lines, minus the
// one blank line we inserted above our block on append. Nothing else moves.
function realisticExpected(): string {
  const dropBlankBeforeBegin = true;
  const lines = realisticConfig().split("\n");
  const beginIdx = lines.indexOf(CODEX_CCC_BEGIN_MARKER);
  return lines
    .filter((_line, i) => {
      if (i === beginIdx - 1 && dropBlankBeforeBegin) return false;
      if (i === beginIdx) return false;
      if (i === lines.indexOf(CODEX_CCC_END_MARKER)) return false;
      if (i === beginIdx + 1 || i === beginIdx + 2) return false;
      return true;
    })
    .join("\n");
}

// The naive algorithm: cut BEGIN..END and everything between. Kept here on purpose
// so the negative control below runs the real failure, not a description of it.
function buggyMarkerToMarkerRemove(content: string): string {
  const beginIdx = content.indexOf(CODEX_CCC_BEGIN_MARKER);
  const endIdx = content.indexOf(CODEX_CCC_END_MARKER);
  let cutStart = beginIdx;
  let cutEnd = endIdx + CODEX_CCC_END_MARKER.length;
  if (content[cutEnd] === "\n") cutEnd += 1;
  if (content[cutStart - 1] === "\n") cutStart -= 1;
  return content.slice(0, cutStart) + content.slice(cutEnd);
}

test("a realistic config survives byte-identical, minus only code-cost-clarity's own lines", () => {
  const configPath = freshConfigPath("test-live");
  writeFileSync(configPath, realisticConfig());

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("removed");
  expect(read(configPath)).toBe(realisticExpected());

  // The same check, spelled out on the lines that matter.
  const after = read(configPath);
  expect(after).toContain(
    'trusted_hash = "sha256:2ed1ac9629ddfb4d2634955ca16ad2c912302e8b10b13e59586b36c3d6ca9f8c"',
  );
  expect(after).toContain("[hooks.state]");
  expect(after).toContain("[tui.model_availability_nux]");
  expect(after).toContain('"gpt-5.6-sol" = 1');
  expect(after).toContain(
    '[projects."/Users/alex/.marginfront-ccc-test/workspace"]',
  );
  // And our own lines really are gone.
  for (const line of CCC_LINES) expect(after).not.toContain(line);
});

test("NEGATIVE CONTROL: a marker-to-marker delete FAILS the test above", () => {
  const before = realisticConfig();
  const buggy = buggyMarkerToMarkerRemove(before);

  // If this ever passes, the test above has stopped proving anything.
  expect(buggy).not.toBe(realisticExpected());

  // What a marker-to-marker delete destroys.
  expect(buggy).not.toContain("trusted_hash");
  expect(buggy).not.toContain("[hooks.state]");
  expect(buggy).not.toContain("[tui.model_availability_nux]");
  // It did get our own lines out - that was never the problem.
  for (const line of CCC_LINES) expect(buggy).not.toContain(line);
});

test("it reports which lines it kept", () => {
  const configPath = freshConfigPath("test-report");
  writeFileSync(configPath, realisticConfig());

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.preservedLines).toEqual([
    "[tui.model_availability_nux]",
    '"gpt-5.5" = 2',
    '"gpt-5.6-sol" = 1',
    "[hooks.state]",
    '[hooks.state."/Users/alex/.codex/hooks.json:pre_tool_use:0:0"]',
    'trusted_hash = "sha256:2ed1ac9629ddfb4d2634955ca16ad2c912302e8b10b13e59586b36c3d6ca9f8c"',
  ]);
});

test("install -> Codex appends inside the fence -> uninstall keeps what Codex wrote", () => {
  const configPath = freshConfigPath("test-roundtrip");
  const original = 'model = "gpt-5.6-sol"\n';
  writeFileSync(configPath, original);
  writeCodexOtelConfig({ configPath, ...QUIET });

  // Codex then appends its own state, which lands before our END marker.
  const withCodexState = read(configPath).replace(
    CODEX_CCC_END_MARKER,
    ["[hooks.state]", 'trusted_hash = "sha256:abc"', CODEX_CCC_END_MARKER].join(
      "\n",
    ),
  );
  writeFileSync(configPath, withCodexState);

  removeCodexOtelConfig({ configPath, ...QUIET });

  expect(read(configPath)).toBe(
    original + '[hooks.state]\ntrusted_hash = "sha256:abc"\n',
  );
});

test("our exporter line edited by hand -> refuse and change nothing", () => {
  const configPath = freshConfigPath("test-edited");
  const edited = realisticConfig().replace("4318", "9999");
  writeFileSync(configPath, edited);

  const lines: string[] = [];
  const result = removeCodexOtelConfig({
    configPath,
    log: (m) => lines.push(m),
  });

  expect(result.action).toBe("refused");
  expect(read(configPath)).toBe(edited);
  expect(lines.join(" ")).toContain("aren't the ones we wrote any more");
  expect(lines.join(" ")).toContain("Fix by hand");
});

test("a key added to our [otel] table -> refuse and change nothing", () => {
  const configPath = freshConfigPath("test-extrakey");
  const withExtra = realisticConfig().replace(
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }\n',
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }\nlog_user_prompt = true\n',
  );
  writeFileSync(configPath, withExtra);

  const lines: string[] = [];
  const result = removeCodexOtelConfig({
    configPath,
    log: (m) => lines.push(m),
  });

  expect(result.action).toBe("refused");
  expect(read(configPath)).toBe(withExtra);
  expect(lines.join(" ")).toContain("log_user_prompt = true");
});

test("our [otel] block deleted by hand, markers left -> refuse and change nothing", () => {
  const configPath = freshConfigPath("test-gutted");
  const gutted = [
    'model = "gpt-5.6-sol"',
    "",
    CODEX_CCC_BEGIN_MARKER,
    "[hooks.state]",
    'trusted_hash = "sha256:abc"',
    CODEX_CCC_END_MARKER,
    "",
  ].join("\n");
  writeFileSync(configPath, gutted);

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("refused");
  expect(read(configPath)).toBe(gutted);
});

test("a comment inside our [otel] table is not treated as a foreign key", () => {
  const configPath = freshConfigPath("test-comment");
  const withComment = realisticConfig().replace(
    "\n[tui.model_availability_nux]",
    "\n# a note the developer left\n[tui.model_availability_nux]",
  );
  writeFileSync(configPath, withComment);

  const result = removeCodexOtelConfig({ configPath, ...QUIET });

  expect(result.action).toBe("removed");
  expect(read(configPath)).toContain("# a note the developer left");
});
