// connector.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES: proves the install-time plumbing is right - the collector
// download URL is built correctly for each platform, and the config templates
// carry the verified-correct values, including HTTP on 4318 as the transport.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { expectOwnerOnly } from "./helpers/owner-only";
import {
  resolveCollectorAsset,
  renderCollectorYaml,
  renderEnvFile,
  renderCodexConfigInstructions,
  loadEnvFile,
  writeApiKeyToEnv,
  OTELCOL_VERSION,
  resolveOtelcolVersion,
  verifyTarballChecksum,
  COLLECTOR_CHECKSUMS,
  COLLECTOR_OS_MAP,
  COLLECTOR_ARCH_MAP,
  collectorBinaryName,
  routeConsoleOutputToFiles,
  crashToConsoleError,
} from "../src/connector";

// --- collector asset resolution --------------------------------------------

test("builds the darwin/arm64 asset name and GitHub release URL", () => {
  const { asset, url, os, cpu } = resolveCollectorAsset(
    "darwin",
    "arm64",
    "v0.154.0",
  );
  expect(os).toBe("darwin");
  expect(cpu).toBe("arm64");
  expect(asset).toBe("otelcol-contrib_0.154.0_darwin_arm64.tar.gz");
  expect(url).toBe(
    "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.154.0/otelcol-contrib_0.154.0_darwin_arm64.tar.gz",
  );
});

test("maps Node arch x64 -> amd64 for linux", () => {
  const { asset, cpu } = resolveCollectorAsset("linux", "x64", "v0.154.0");
  expect(cpu).toBe("amd64");
  expect(asset).toBe("otelcol-contrib_0.154.0_linux_amd64.tar.gz");
});

test("drops the leading v from the asset filename but keeps it in the URL path", () => {
  const { asset, url } = resolveCollectorAsset("darwin", "arm64", "v0.155.0");
  expect(asset.includes("0.155.0")).toBeTruthy();
  expect(!asset.includes("v0.155.0")).toBeTruthy();
  expect(url.includes("/download/v0.155.0/")).toBeTruthy();
});

test("throws a clear error on an OS with no collector build, and on an unsupported CPU", () => {
  expect(() => resolveCollectorAsset("freebsd", "x64")).toThrow(
    /won't install on "freebsd"/,
  );
  expect(() => resolveCollectorAsset("linux", "ia32")).toThrow(
    /Unsupported CPU/,
  );
});

// Windows is a supported platform, so leaving it out of the fix line would steer a
// Windows user away from a platform that works.
test("the unsupported-OS fix line names every platform that actually works", () => {
  let message = "";
  try {
    resolveCollectorAsset("freebsd", "x64");
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message).toContain("Fix: run this on macOS, Windows, or Linux.");
  expect(message).not.toMatch(/isn't finished yet/);
});

// Resolution answers one question: does a collector exist for this machine. It
// never decides whether the tool may run here.
test("resolves the Windows asset instead of throwing", () => {
  const { os, cpu, asset, url } = resolveCollectorAsset(
    "win32",
    "x64",
    "v0.154.0",
  );
  expect(os).toBe("windows");
  expect(cpu).toBe("amd64");
  // Upstream ships Windows as .tar.gz, not .zip - the .msi assets are installers.
  expect(asset).toBe("otelcol-contrib_0.154.0_windows_amd64.tar.gz");
  expect(url).toBe(
    "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.154.0/otelcol-contrib_0.154.0_windows_amd64.tar.gz",
  );
});

test("resolves the Windows arm64 asset", () => {
  const { asset } = resolveCollectorAsset("win32", "arm64", "v0.154.0");
  expect(asset).toBe("otelcol-contrib_0.154.0_windows_arm64.tar.gz");
});

// The suffix decides two things: whether Windows will run the file, and whether
// `tar` can find the member to extract.
test("the collector binary carries .exe on Windows and nowhere else", () => {
  expect(collectorBinaryName("win32")).toBe("otelcol-contrib.exe");
  expect(collectorBinaryName("darwin")).toBe("otelcol-contrib");
  expect(collectorBinaryName("linux")).toBe("otelcol-contrib");
  expect(resolveCollectorAsset("win32", "x64", "v0.154.0").binaryName).toBe(
    "otelcol-contrib.exe",
  );
  expect(resolveCollectorAsset("darwin", "arm64", "v0.154.0").binaryName).toBe(
    "otelcol-contrib",
  );
});

test("the pinned default version is a real vN.N.N tag, not 'latest'", () => {
  expect(OTELCOL_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
});

// --- collector YAML template ------------------------------------------------

test("collector YAML uses http/protobuf:4318 and the no-double-count processor", () => {
  const yaml = renderCollectorYaml("/tmp/live-otlp.jsonl");
  expect(yaml.includes("127.0.0.1:4318")).toBeTruthy();
  expect(yaml.includes("cumulativetodelta")).toBeTruthy();
  expect(yaml.includes("path: /tmp/live-otlp.jsonl")).toBeTruthy();
});

test("collector YAML names 4318 as the transport", () => {
  const yaml = renderCollectorYaml();
  expect(/4318/.test(yaml)).toBeTruthy();
});

// --- collector YAML logs pipeline (the Codex source) --------------

test("collector YAML wires a service.pipelines.logs pipeline for the Codex source", () => {
  const yaml = renderCollectorYaml("/tmp/live-otlp.jsonl");
  // A real DATA pipeline named `logs` (not only the telemetry.logs verbosity key).
  expect(
    /pipelines:[\s\S]*\blogs:\s*\n\s*receivers:\s*\[otlp\]/.test(yaml),
  ).toBeTruthy();
  // It writes to the SAME file the metrics pipeline does.
  expect(yaml.includes("path: /tmp/live-otlp.jsonl")).toBeTruthy();
});

// --- collector YAML: the capture file keeps no prompt, reply or tool input -----

// WHY THIS MATTERS AND WHY A PLAIN "contains" IS NOT ENOUGH: Claude Code puts the
// user's prompt, the model's reply and each tool call's input on its log records, and
// the file exporter writes every line to disk in the clear. A processor that is
// declared but left out of the logs pipeline's processors list does nothing at all, so
// both halves are asserted, and so is the pair of attributes the forwarder still needs.
test("collector YAML declares the drop-content processor and lists it on the logs pipeline", () => {
  const yaml = renderCollectorYaml("/tmp/live-otlp.jsonl");
  const processorsBlock = yaml.slice(
    yaml.indexOf("processors:"),
    yaml.indexOf("exporters:"),
  );
  expect(processorsBlock).toContain("attributes/drop-content:");
  for (const key of ["prompt", "response", "tool_input"]) {
    expect(processorsBlock).toMatch(
      new RegExp(`- key: ${key}\\s*\\n\\s*action: delete`),
    );
  }

  // Declared is not applied: it has to be in the logs pipeline's own list. It rides on
  // the metrics pipeline too - nothing puts a content key on a metric today, so that
  // one is a guard against a future release that does.
  const pipelines = yaml.slice(yaml.indexOf("  pipelines:"));
  const logsBlock = pipelines.slice(pipelines.indexOf("    logs:"));
  const metricsBlock = pipelines.slice(
    pipelines.indexOf("    metrics:"),
    pipelines.indexOf("    logs:"),
  );
  for (const block of [logsBlock, metricsBlock]) {
    expect(block).toMatch(
      /processors:\s*\[[^\]]*attributes\/drop-content[^\]]*\]/,
    );
  }
});

// tool_parameters IS deleted: for a Bash call it carries a second copy of the
// command. It has to survive on one record - an MCP call, where it holds the only copy
// of the names the forwarder rebuilds "mcp__server__tool" from. Declared, excluded and
// listed are all asserted because a processor left off the pipeline does nothing.
test("collector YAML drops tool_parameters everywhere except on MCP tool records", () => {
  const yaml = renderCollectorYaml("/tmp/live-otlp.jsonl");
  const processorsBlock = yaml.slice(
    yaml.indexOf("processors:"),
    yaml.indexOf("exporters:"),
  );
  expect(processorsBlock).toContain("attributes/drop-tool-params-except-mcp:");
  expect(processorsBlock).toMatch(
    /- key: tool_parameters\s*\n\s*action: delete/,
  );
  // The carve-out, spelled exactly: skip the records whose tool_name is mcp_tool.
  const scopedBlock = processorsBlock.slice(
    processorsBlock.indexOf("attributes/drop-tool-params-except-mcp:"),
  );
  expect(scopedBlock).toMatch(
    /exclude:\s*\n\s*match_type: strict\s*\n\s*attributes:\s*\n\s*- key: tool_name\s*\n\s*value: mcp_tool/,
  );

  const pipelines = yaml.slice(yaml.indexOf("  pipelines:"));
  const logsBlock = pipelines.slice(pipelines.indexOf("    logs:"));
  const listed = logsBlock.match(/processors:\s*\[([^\]]*)\]/);
  expect(listed).not.toBeNull();
  const names = listed![1]!.split(",").map((name) => name.trim());
  expect(names).toContain("attributes/drop-tool-params-except-mcp");
  expect(
    names.indexOf("attributes/drop-tool-params-except-mcp"),
  ).toBeGreaterThan(names.indexOf("attributes/drop-content"));
});

test("collector YAML keeps the attribute the forwarder actually bills from", () => {
  const yaml = renderCollectorYaml();
  // Deleting this would stop tool calls being priced at all, so the drop list must
  // never grow to include it.
  expect(yaml).not.toMatch(/- key: tool_name\s*\n\s*action: delete/);
});

test("collector YAML logs pipeline does NOT use cumulativetodelta (a metrics-only processor)", () => {
  const yaml = renderCollectorYaml();
  // Scope to the data pipelines first - otherwise "    logs:" also matches the
  // service.telemetry.logs verbosity key that sits earlier in the document.
  const pipelines = yaml.slice(yaml.indexOf("  pipelines:"));
  const metricsBlock = pipelines.slice(
    pipelines.indexOf("    metrics:"),
    pipelines.indexOf("    logs:"),
  );
  const logsBlock = pipelines.slice(pipelines.indexOf("    logs:"));
  // The metrics pipeline HAS the de-dupe processor; the logs one must not.
  expect(metricsBlock.includes("cumulativetodelta")).toBeTruthy();
  expect(logsBlock.includes("cumulativetodelta")).toBeFalsy();
});

// --- Codex config instructions (printed by `init`) --------------------------

test("Codex config instructions carry the verified [otel] block for ~/.codex/config.toml", () => {
  const block = renderCodexConfigInstructions();
  expect(block.includes("[otel]")).toBeTruthy();
  // The exporter is a TABLE (not the string "otlp-http"), the endpoint is NESTED
  // inside it and carries the /v1/logs path, and protocol lives in the same table.
  // Verified against a real Codex: this exact form makes Codex export to the local
  // collector, and the flat form ("exporter = \"otlp-http\"" + a bare top-level
  // endpoint) silently exports nothing.
  expect(
    block.includes(
      'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }',
    ),
  ).toBeTruthy();
  expect(block.includes("/v1/logs")).toBeTruthy();
  // The flat form exports nothing, so it must not appear.
  expect(block.includes('exporter = "otlp-http"')).toBeFalsy();
  // Points at ~/.codex/config.toml (user-level) and never edits it for the user.
  expect(block.includes("~/.codex/config.toml")).toBeTruthy();
});

// --- env template -----------------------------------------------------------

test("env template carries the verified telemetry settings and an empty key", () => {
  const env = renderEnvFile();
  expect(env.includes("CLAUDE_CODE_ENABLE_TELEMETRY=1")).toBeTruthy();
  expect(
    env.includes("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf"),
  ).toBeTruthy();
  expect(
    env.includes("OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318"),
  ).toBeTruthy();
  expect(env.includes("OTEL_METRIC_EXPORT_INTERVAL=300000")).toBeTruthy();
  // The logs/EVENT stream batches at the same 5 minutes as metrics, so tool
  // events go out in batches, not one request each.
  expect(env.includes("OTEL_LOGS_EXPORT_INTERVAL=300000")).toBeTruthy();
  // Ships with the key blank - never a real secret in the template.
  expect(/MARGINFRONT_API_KEY=\s*$/m.test(env)).toBeTruthy();
});

test("env template turns on the EVENT stream so tool calls are captured", () => {
  const env = renderEnvFile();
  // Tool calls ride the logs/events stream - without this line Claude Code
  // broadcasts no tool activity and tool spend can't be tracked.
  expect(env.includes("OTEL_LOGS_EXPORTER=otlp")).toBeTruthy();
  // Tool billing is catalog-driven on the server, so there is NO client allowlist
  // to configure.
  expect(env.includes("CCC_BILLABLE_TOOLS")).toBeFalsy();
});

test("env template names the SECRET key, the real dashboard route, and the publishable-key warning", () => {
  const env = renderEnvFile();
  // The guidance names the route inside the operator's own dashboard (Build ->
  // API keys) and no hosted address: every install runs against its own server.
  expect(env.includes("dashboard: Build -> API keys")).toBeTruthy();
  expect(/marginfront\.com/i.test(env)).toBeFalsy();
  // And it must disambiguate the two key types - only the secret one works.
  expect(env.includes("mf_sk_")).toBeTruthy();
  expect(env.includes("mf_pk_")).toBeTruthy();
  // No generic "get it from your dashboard" line that names no route.
  expect(env.includes("Get it from your MarginFront dashboard")).toBeFalsy();
});

// --- writeApiKeyToEnv: the interactive-init key saver ------------

test("writeApiKeyToEnv drops the pasted key onto the blank line and keeps the file 0600", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccc-write-"));
  const path = join(dir, ".env");
  // Start from the real template, written 0600 like ensureConfigFiles does.
  writeFileSync(path, renderEnvFile(), { mode: 0o600 });

  writeApiKeyToEnv("mf_sk_test_abc123", path);

  // The key reads back through the same parser `run` uses.
  const loaded = loadEnvFile(path);
  expect(loaded.MARGINFRONT_API_KEY).toBe("mf_sk_test_abc123");
  // The surrounding telemetry settings are untouched.
  expect(loaded.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  expect(loaded.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318");
  // The secret stays owner-only - permission bits on Unix, a real ACL on Windows.
  expectOwnerOnly(path);
  delete process.env.MARGINFRONT_API_KEY;
  delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

test("writeApiKeyToEnv replaces an existing key in place - no duplicate line on re-save", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccc-rewrite-"));
  const path = join(dir, ".env");
  writeFileSync(path, renderEnvFile(), { mode: 0o600 });

  writeApiKeyToEnv("mf_sk_first", path);
  writeApiKeyToEnv("mf_sk_second", path);

  const text = readFileSync(path, "utf8");
  // Exactly one MARGINFRONT_API_KEY= line, holding the latest value.
  const keyLines = text
    .split("\n")
    .filter((l) => l.startsWith("MARGINFRONT_API_KEY="));
  expect(keyLines).toHaveLength(1);
  expect(loadEnvFile(path).MARGINFRONT_API_KEY).toBe("mf_sk_second");
  delete process.env.MARGINFRONT_API_KEY;
});

test("writeApiKeyToEnv handles a `$` in the value without regex back-reference mangling", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccc-dollar-"));
  const path = join(dir, ".env");
  writeFileSync(path, renderEnvFile(), { mode: 0o600 });

  // A `$&`-looking value would be corrupted if we used string replacement.
  writeApiKeyToEnv("mf_sk_a$&b", path);
  expect(loadEnvFile(path).MARGINFRONT_API_KEY).toBe("mf_sk_a$&b");
  delete process.env.MARGINFRONT_API_KEY;
});

test("writeApiKeyToEnv appends the key line if a hand-edited file dropped it", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccc-append-"));
  const path = join(dir, ".env");
  // A file with no MARGINFRONT_API_KEY= line at all.
  writeFileSync(path, "CLAUDE_CODE_ENABLE_TELEMETRY=1\n", { mode: 0o600 });

  writeApiKeyToEnv("mf_sk_appended", path);
  const loaded = loadEnvFile(path);
  expect(loaded.MARGINFRONT_API_KEY).toBe("mf_sk_appended");
  // Didn't clobber the line that was already there.
  expect(loaded.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  delete process.env.MARGINFRONT_API_KEY;
  delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
});

// --- env loader -------------------------------------------------------------

// =============================================================================
// SECURITY TESTS - integrity gate
//
// These are adversarial. The goal is to BREAK the gate if it's wrong,
// not to give it an easy pass. Each test is designed so that a missing or
// broken implementation would produce a genuine test failure.
// =============================================================================

// --- TAMPER TEST (the important one) -----------------------------------------
//
// Writes a temp file with known bytes, computes its ACTUAL sha256 using the
// same node:crypto path the production code does, then:
//   1. Asserts verifyTarballChecksum RETURNS TRUE on the real hash.
//   2. Asserts it RETURNS FALSE on a one-char-off hash (what a swapped binary
//      would look like - the hash won't match).
//
// This test is genuinely failure-capable: if verifyTarballChecksum always
// returns true, or always returns false, or the comparison is broken in any
// way, at least one of the two assertions below will fail.
// -----------------------------------------------------------------------------
test("TAMPER: verifyTarballChecksum passes on correct sha256 and returns false on a tampered hash", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");

  // Write a small fake "tarball" - the actual bytes don't matter, what matters
  // is that we can compute the right hash and then deliberately break it.
  const dir = mkdtempSync(join(tmpdir(), "ccc-tamper-"));
  const fakeFile = join(dir, "fake.tar.gz");
  // Realistic-ish content: a 64-byte payload. The hash will be real.
  const payload = Buffer.from(
    "this is a fake collector tarball - not real bytes, but a real sha256 test",
  );
  writeFileSync(fakeFile, payload);

  const realHash = createHash("sha256").update(payload).digest("hex");

  // --- Pass case: the real hash matches the file's bytes ---
  // If this fails, verifyTarballChecksum is broken on correct input.
  expect(verifyTarballChecksum(fakeFile, realHash)).toBe(true);

  // --- Fail case: mutate the last character of the expected hash ---
  // A SHA-256 hex string is 64 chars. Flip the last char: if it's 'a' make it
  // 'b', otherwise make it 'a'. The odds that this accidental change happens to
  // be the same hash are astronomically zero for any real input.
  const lastChar = realHash[realHash.length - 1];
  const wrongLastChar = lastChar === "a" ? "b" : "a";
  const tamperedHash = realHash.slice(0, -1) + wrongLastChar;

  // Confirm we actually changed the hash (sanity check - can't be equal).
  expect(tamperedHash).not.toBe(realHash);

  // The function MUST return false for the tampered hash. If it returns true,
  // the gate is broken and a swapped binary would pass undetected.
  expect(verifyTarballChecksum(fakeFile, tamperedHash)).toBe(false);
});

// --- PINNED CHECKSUM MAP -----------------------------------------------------
//
// Asserts the EXACT authoritative sha256 for each platform asset, as sourced from
// OpenTelemetry's cosign-signed checksums for v0.154.0. A typo in the map means a
// legitimate download gets rejected; a wrong value means a tampered binary could
// pass. Both are bugs. This test catches both.
//
// The Windows pair comes from a DIFFERENT upstream file than the other four:
//   .../v0.154.0/opentelemetry-collector-releases_otelcol-contrib_checksums.txt
//   .../v0.154.0/opentelemetry-collector-releases_otelcol-contrib_windows_checksums.txt
// The first one contains no Windows line at all, so reading only it and concluding
// "upstream has no Windows build" is the trap here.
// -----------------------------------------------------------------------------
test("CHECKSUMS: pinned map contains the exact authoritative sha256 for every v0.154.0 asset", () => {
  // The values must be byte-for-byte exact. Any drift - even one character - means
  // we're pinning the wrong fingerprint.
  expect(
    COLLECTOR_CHECKSUMS["otelcol-contrib_0.154.0_darwin_amd64.tar.gz"],
  ).toBe("14f7f825a7ad7ee0799947ff70a42b9a5528a9c1411ab45f8fcc4caeb9346f7b");

  expect(
    COLLECTOR_CHECKSUMS["otelcol-contrib_0.154.0_darwin_arm64.tar.gz"],
  ).toBe("de3af70ef0b80af213911cc9ba8daf553348dd22ed1fb15db561d207fc2cb3d9");

  expect(
    COLLECTOR_CHECKSUMS["otelcol-contrib_0.154.0_linux_amd64.tar.gz"],
  ).toBe("f0fe6e7b1d81936d4e5a3aad7a678f3fc2f8ada2a9f8f37f37542813c12ed322");

  expect(
    COLLECTOR_CHECKSUMS["otelcol-contrib_0.154.0_linux_arm64.tar.gz"],
  ).toBe("52310bfcb5a952c072e8abff7f0f2940ee38cea36752a4a4e1a4e21c2088c3f9");

  expect(
    COLLECTOR_CHECKSUMS["otelcol-contrib_0.154.0_windows_amd64.tar.gz"],
  ).toBe("3f68a2f48da37da37e478b50814f2da408fb66593b288d4bb57bd3d832339e3b");

  expect(
    COLLECTOR_CHECKSUMS["otelcol-contrib_0.154.0_windows_arm64.tar.gz"],
  ).toBe("a4320c1954cde72ce77b8e52f88d89d7ff7fdf2ac2501526ca454c2b8856f687");
});

// -----------------------------------------------------------------------------
// CHECKSUM COVERAGE. The test above pins values it names; this one names nothing,
// so it survives the next platform and the next version bump. It walks every
// (platform, arch) pair resolveCollectorAsset can produce and demands a pinned,
// well-formed, non-shared fingerprint for each.
//
// A platform added to COLLECTOR_OS_MAP without its checksum resolves cleanly,
// downloads 360 MB, and only then dies at ensureCollectorBinary's integrity gate -
// on a user's machine. Deriving from the map catches that here instead.
//
// The distinctness check isn't about hash collisions. It catches an adapted
// checksum, which is how a wrong-but-plausible hash gets into a table like this.
// -----------------------------------------------------------------------------
test("CHECKSUMS: every platform the installer can resolve has a pinned, well-formed fingerprint", () => {
  const SHA256_HEX = /^[0-9a-f]{64}$/;
  const seen = new Map<string, string>();

  const platforms = Object.keys(COLLECTOR_OS_MAP);
  const arches = Object.keys(COLLECTOR_ARCH_MAP);
  // Guards the guard: if the maps were ever emptied, the loops below would pass
  // vacuously and this test would report success while checking nothing.
  expect(platforms).toContain("win32");
  expect(platforms.length * arches.length).toBeGreaterThanOrEqual(6);

  for (const nodePlatform of platforms) {
    for (const nodeArch of arches) {
      // No version argument: this checks the version this build will really
      // install, so bumping the pin without bumping the checksums goes red here.
      const { asset } = resolveCollectorAsset(nodePlatform, nodeArch);
      const pinned = COLLECTOR_CHECKSUMS[asset];

      expect(
        pinned,
        `no pinned checksum for ${asset} (${nodePlatform}/${nodeArch}) - ` +
          "copy it from upstream's signed checksums file, never derive one",
      ).toBeDefined();
      expect(
        pinned,
        `malformed checksum for ${asset}: expected 64 lowercase hex characters`,
      ).toMatch(SHA256_HEX);

      const already = seen.get(pinned);
      expect(
        already,
        `${asset} is pinned to the same fingerprint as ${already} - ` +
          "two different downloads cannot have the same sha256, so one was copied",
      ).toBeUndefined();
      seen.set(pinned, asset);
    }
  }
});

// --- VERSION VALIDATION (path traversal and URL steering) ---------------------
//
// The CCC_OTELCOL_VERSION env var flows into a download URL AND a tmpdir path.
// A malformed value is a hard error; a well-formed one passes.
//
// The pinned constant is read once at module load, so these tests cannot vary the
// env var mid-run. VERSION_PATTERN is not exported, so one test copies its regex
// and another calls the real resolveOtelcolVersion with each bad value.
// -----------------------------------------------------------------------------
test("VERSION: OTELCOL_VERSION (the pinned default) is a well-formed vN.N.N string", () => {
  // The real exported constant. If this is 'latest' or malformed, this fails.
  expect(OTELCOL_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  expect(OTELCOL_VERSION).toBe("v0.154.0");
});

test("VERSION: malformed CCC_OTELCOL_VERSION values are rejected by the validation pattern", () => {
  // A copy of the production VERSION_PATTERN, tried against path-traversal and
  // injection strings. This proves the pattern; the next test proves the function
  // that applies it, so a weaker pattern in the source fails there.
  const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

  // Path traversal
  expect(VERSION_PATTERN.test("../../../../tmp/evil")).toBe(false);
  // No leading v
  expect(VERSION_PATTERN.test("1.2.3")).toBe(false);
  // Only two parts
  expect(VERSION_PATTERN.test("v1.2")).toBe(false);
  // Shell-injection suffix
  expect(VERSION_PATTERN.test("v1.2.3; rm -rf /")).toBe(false);
  // Trailing newline (a common injection bypass)
  expect(VERSION_PATTERN.test("v1.2.3\n")).toBe(false);
  // Leading whitespace
  expect(VERSION_PATTERN.test(" v1.2.3")).toBe(false);
  // Empty string
  expect(VERSION_PATTERN.test("")).toBe(false);

  // Well-formed values MUST pass
  expect(VERSION_PATTERN.test("v0.154.0")).toBe(true);
  expect(VERSION_PATTERN.test("v1.2.3")).toBe(true);
  expect(VERSION_PATTERN.test("v10.200.3000")).toBe(true);
});

test("VERSION: resolveOtelcolVersion honors valid/unset and THROWS on every malformed override (direct, real)", () => {
  // Calls the REAL exported production function (not a copy of its regex), so a
  // fault in the function itself, not only in the pattern string, fails here.
  // Unset / empty -> the safe pinned default.
  expect(resolveOtelcolVersion(undefined)).toBe("v0.154.0");
  expect(resolveOtelcolVersion("")).toBe("v0.154.0");
  // A well-formed override is honored verbatim.
  expect(resolveOtelcolVersion("v0.154.0")).toBe("v0.154.0");
  expect(resolveOtelcolVersion("v1.2.3")).toBe("v1.2.3");
  expect(resolveOtelcolVersion("v10.200.3000")).toBe("v10.200.3000");
  // Every malformed override is a HARD ERROR: path traversal that would steer the
  // download URL and tmp filename, a shell-injection suffix, a trailing-newline
  // bypass, a leading space.
  for (const bad of [
    "../../../../tmp/evil",
    "1.2.3",
    "v1.2",
    "v1.2.3; rm -rf /",
    "v1.2.3\n",
    " v1.2.3",
    "latest",
  ]) {
    expect(() => resolveOtelcolVersion(bad)).toThrow(
      /Invalid CCC_OTELCOL_VERSION/,
    );
  }
});

// --- loadEnvFile parses KEY=value, strips quotes, and ignores comments/blanks ---

test("loadEnvFile parses KEY=value, strips quotes, and ignores comments/blanks", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccc-env-"));
  const path = join(dir, ".env");
  writeFileSync(
    path,
    [
      "# a comment",
      "",
      "MARGINFRONT_API_KEY=secret-123",
      'QUOTED="quoted-value"',
      "OTEL_METRIC_EXPORT_INTERVAL=600000",
    ].join("\n"),
  );
  // Make sure we don't override a value already in the environment.
  process.env.OTEL_METRIC_EXPORT_INTERVAL = "5000";
  const loaded = loadEnvFile(path);
  expect(loaded.MARGINFRONT_API_KEY).toBe("secret-123");
  expect(loaded.QUOTED).toBe("quoted-value");
  // Shell value wins over the file.
  expect(process.env.OTEL_METRIC_EXPORT_INTERVAL).toBe("5000");
  delete process.env.OTEL_METRIC_EXPORT_INTERVAL;
  delete process.env.MARGINFRONT_API_KEY;
});

// --- the meter's own output, redirected into files ---

// routeConsoleOutputToFiles puts a handler on this process that calls process.exit(1),
// which inside a test runner would take the whole worker down on the next stray
// rejection. Every test here takes it back off.
function stopCrashRouting(): void {
  process.off("uncaughtException", crashToConsoleError);
  process.off("unhandledRejection", crashToConsoleError);
}

// The split is the whole point: `status` prints one file under "Recent output" and
// the other under "Recent errors", and the crash check dates the error log alone. A
// helper that poured both into one file would make a healthy meter look like it was
// erroring every minute.
test("routeConsoleOutputToFiles sends log to the output file and error to the error file", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccc-daemon-log-"));
  const outPath = join(dir, "forwarder.out.log");
  const errPath = join(dir, "forwarder.err.log");
  const realLog = console.log;
  const realError = console.error;
  try {
    routeConsoleOutputToFiles(outPath, errPath);
    console.log("started the collector (pid %d)", 4242);
    console.error("no key saved");
    console.log("second line");
  } finally {
    console.log = realLog;
    console.error = realError;
    stopCrashRouting();
  }
  try {
    // Formatted the way console itself would, so a %d line reads the same in the file
    // as it did on screen.
    expect(readFileSync(outPath, "utf8")).toBe(
      "started the collector (pid 4242)\nsecond line\n",
    );
    expect(readFileSync(errPath, "utf8")).toBe("no key saved\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routeConsoleOutputToFiles appends to a log that is already there", async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ccc-daemon-log-"));
  const outPath = join(dir, "forwarder.out.log");
  const errPath = join(dir, "forwarder.err.log");
  writeFileSync(outPath, "from the run before\n");
  const realLog = console.log;
  const realError = console.error;
  try {
    routeConsoleOutputToFiles(outPath, errPath);
    console.log("from this run");
  } finally {
    console.log = realLog;
    console.error = realError;
    stopCrashRouting();
  }
  try {
    expect(readFileSync(outPath, "utf8")).toBe(
      "from the run before\nfrom this run\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The redirect alone could not catch a crash: Node prints an uncaught stack itself, to
// the real stderr, which behind the Windows console host is nowhere. A child process is
// the only place an uncaught exception can be observed without taking the runner down.
test.each([
  ["exception", "CRASH-CANARY from a timer"],
  ["rejection", "CRASH-CANARY from a rejected promise"],
])(
  "an uncaught %s lands its stack in the error log and exits 1",
  async (kind, canary) => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath, pathToFileURL } = await import("node:url");

    const here = dirname(fileURLToPath(import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "ccc-crash-log-"));
    const outPath = join(dir, "forwarder.out.log");
    const errPath = join(dir, "forwarder.err.log");
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(join(here, "helpers", "ts-import-hook.mjs")).href,
          join(here, "helpers", "crash-after-routing.ts"),
          outPath,
          errPath,
          kind,
        ],
        { encoding: "utf8" },
      );

      const written = readFileSync(errPath, "utf8");
      expect(written).toContain(canary);
      // A stack, not only the message: the frames are the whole point of logging it.
      expect(written).toContain("crash-after-routing.ts");
      // And nowhere else. On the Windows task the real stderr has no reader, and the
      // output log is what `status` prints as healthy activity.
      expect(run.stderr).not.toContain(canary);
      expect(readFileSync(outPath, "utf8")).not.toContain(canary);
      expect(run.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
