// connector.ts - CLI plumbing: on-disk config layout, the .env + collector YAML
// templates, fetch/launch of the OTel collector binary, and API-key loading.
// Command flows live in cli.ts.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  rmSync,
  chmodSync,
  copyFileSync,
  renameSync,
  statSync,
  truncateSync,
} from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { homedir, tmpdir, platform, arch, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import process from "node:process";
// The running package version, shown in the bootstrap-failure error so a stuck user
// can tell exactly which build produced it. Imported as a live binding and
// only read at call time inside installDaemon, so the forwarder<->connector import
// cycle is harmless (both bundle into one file anyway).
import {
  CCC_PACKAGE_VERSION,
  MATTER_NUMBER_ENV_KEY,
  WORK_ID_ENV_KEY,
  WORK_ITEM_NOUN,
  WORK_ITEM_NOUN_PLAIN,
} from "./forwarder";
import {
  FINISHED_WORK_NAMES_ENV_KEY,
  insertMemoryBlock,
  removeMemoryBlock,
  renderFinishedWorkMemoryBlock,
} from "./finished-work";
import type { CacheWriteTtl } from "./types";
import {
  CCC_OWNED_TELEMETRY_KEYS,
  deleteEmptiedClaudeSettings,
  isClaudeCodeInstalled,
  isCodexInstalled,
} from "./control";

export { CCC_OWNED_TELEMETRY_KEYS };

// Logging hook - lets callers/tests capture progress lines instead of printing.
type LogFn = (message: string) => void;

// Return shape of resolveCollectorAsset: platform-mapped names + asset + URL,
// plus the archive member name.
interface CollectorAsset {
  os: string;
  cpu: string;
  asset: string;
  url: string;
  version: string;
  binaryName: string;
}

// Doubles as the archive member name: upstream ships the Windows binary already
// suffixed, so this is what `tar` is asked to extract and what lands on disk.
export function collectorBinaryName(nodePlatform: string = platform()): string {
  return nodePlatform === "win32" ? "otelcol-contrib.exe" : "otelcol-contrib";
}

// WHERE EVERYTHING LIVES - one dir under $HOME holds the whole connector, kept
// out of project trees so nothing here can be committed to a repo by accident.
export const CONFIG_DIR = join(homedir(), ".marginfront-ccc");
export const ENV_PATH = join(CONFIG_DIR, ".env");
export const COLLECTOR_CONFIG_PATH = join(CONFIG_DIR, "otel-collector.yaml");
export const COLLECTOR_BIN_PATH = join(CONFIG_DIR, collectorBinaryName());
export const LIVE_JSONL_PATH = join(CONFIG_DIR, "live-otlp.jsonl");
export const COLLECTOR_PID_PATH = join(CONFIG_DIR, "collector.pid");
export const COLLECTOR_LOG_PATH = join(CONFIG_DIR, "collector.log");
// Forwarder's read offset into live-otlp.jsonl, so `run` resumes after a stop.
export const FORWARDER_CURSOR_PATH = join(CONFIG_DIR, "forwarder.cursor");

// Durable outbox for transiently-FAILED sends: on a failed
// POST the record is appended here BEFORE the cursor advances, so the turn isn't
// dropped. Drained first each poll; server idempotency makes a re-send harmless.
// One JSON record per line; removed on uninstall.
export const FORWARDER_QUEUE_PATH = join(CONFIG_DIR, "forwarder.queue.jsonl");

// Single-instance guard for the forwarder. watchAndForward writes its
// process.pid here on startup; cmdRun checks it before starting so two forwarders
// can't race on the cursor/queue files (double-counting or lost records). Stale
// pidfile (dead pid) is transparently overwritten. Removed on clean stop.
export const FORWARDER_PID_PATH = join(CONFIG_DIR, "forwarder.pid");

// WHICH ASSISTANT THE METER LAST SAW A RECORD FROM. One line,
// "claude-code" or "codex", rewritten by the watcher only when the answer CHANGES.
// `done` reads it to decide which assistant's column a finished thing belongs in
// on a machine that has both installed. Removed on uninstall.
export const LAST_AGENT_PATH = join(CONFIG_DIR, "last-agent");

// Auth-hold marker. Written by the forwarder the moment ingest
// rejects the key (HTTP 401/403), removed on probe recovery, on a validated init
// key save, and by uninstall. While it exists the daemon parks batches in the
// queue instead of POSTing, and `status` reads it to show the red Key row. It
// survives restarts ON PURPOSE: a launchd respawn must resume the hold, not
// resume hammering a dead key.
export const FORWARDER_AUTH_HOLD_PATH = join(
  CONFIG_DIR,
  "forwarder.auth-hold.json",
);

// THE POLITE-STOP MAILBOX (Windows). Node maps process.kill(pid, "SIGTERM") to
// TerminateProcess there - the polite rung IS the hard kill - so a stop lands
// mid-batch, the cursor never advances, the outbox is never written, and the last
// chunk of a customer's spend is gone with nothing logged. `stop` writes this file
// instead and the forwarder polls it. A file rather than a socket because the
// forwarder is detached and may be in another session entirely.
export const SHUTDOWN_REQUEST_PATH = join(CONFIG_DIR, "shutdown.request");

export const SHUTDOWN_REQUEST_POLL_MS = 200;

// Accepted version: "v" + three dotted numbers (e.g. v0.154.0), anchored ^…$ so
// the WHOLE string must match. SECURITY: CCC_OTELCOL_VERSION flows into the curl
// URL and a temp filename, so an unanchored pattern would allow URL steering or
// path traversal (e.g. ../../../tmp/evil). This shuts both at the source.
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

// Resolve the collector release to install. A function (not a const) so an
// override is VALIDATED on read and fails loudly if malformed. Param defaults to
// the env var so the security behavior is unit-testable without touching process.env.
export function resolveOtelcolVersion(
  override: string | undefined = process.env.CCC_OTELCOL_VERSION,
): string {
  // PINNED on purpose - "latest" could change under an existing install. Bump
  // deliberately, or override per-run with CCC_OTELCOL_VERSION. v0.154.0 assets +
  // checksums are pinned in COLLECTOR_CHECKSUMS below.
  const DEFAULT_VERSION = "v0.154.0";

  if (!override) return DEFAULT_VERSION;

  if (!VERSION_PATTERN.test(override)) {
    throw new Error(
      `Invalid CCC_OTELCOL_VERSION "${override}".\n` +
        "What happened: you set the collector version override, but it isn't a " +
        "valid version number.\n" +
        "Why this is strict: that value goes into a download URL and a filename, " +
        "so a malformed one could point the installer somewhere unsafe. We refuse " +
        "rather than guess.\n" +
        "Fix: use the form vMAJOR.MINOR.PATCH (for example CCC_OTELCOL_VERSION=v0.154.0), " +
        "or unset it to use the built-in pinned version.",
    );
  }
  return override;
}

export const OTELCOL_VERSION = resolveOtelcolVersion();

// PINNED COLLECTOR CHECKSUMS - the download's trust anchor. SHA-256 per tarball,
// from OpenTelemetry's cosign-signed checksums for v0.154.0. SECURITY: we
// download a ~360 MB program and RUN it, often through a customer's TLS-inspecting
// proxy that can swap bytes in transit - so we hash what landed and demand an EXACT
// match before chmod/exec. No fingerprint on file = no execution, full stop. Keyed
// by exact asset filename so a checksum can't match the wrong platform. Exported
// for direct test assertions.
//
// BUMPING THE VERSION TAKES TWO UPSTREAM FILES, NOT ONE - the main checksums.txt
// has no Windows line in it at all, so reading only that one reads as "no Windows
// build". Copy from both, verbatim:
//   .../download/vX.Y.Z/opentelemetry-collector-releases_otelcol-contrib_checksums.txt
//   .../download/vX.Y.Z/opentelemetry-collector-releases_otelcol-contrib_windows_checksums.txt
export const COLLECTOR_CHECKSUMS: Record<string, string> = {
  "otelcol-contrib_0.154.0_darwin_amd64.tar.gz":
    "14f7f825a7ad7ee0799947ff70a42b9a5528a9c1411ab45f8fcc4caeb9346f7b",
  "otelcol-contrib_0.154.0_darwin_arm64.tar.gz":
    "de3af70ef0b80af213911cc9ba8daf553348dd22ed1fb15db561d207fc2cb3d9",
  "otelcol-contrib_0.154.0_linux_amd64.tar.gz":
    "f0fe6e7b1d81936d4e5a3aad7a678f3fc2f8ada2a9f8f37f37542813c12ed322",
  "otelcol-contrib_0.154.0_linux_arm64.tar.gz":
    "52310bfcb5a952c072e8abff7f0f2940ee38cea36752a4a4e1a4e21c2088c3f9",
  "otelcol-contrib_0.154.0_windows_amd64.tar.gz":
    "3f68a2f48da37da37e478b50814f2da408fb66593b288d4bb57bd3d832339e3b",
  "otelcol-contrib_0.154.0_windows_arm64.tar.gz":
    "a4320c1954cde72ce77b8e52f88d89d7ff7fdf2ac2501526ca454c2b8856f687",
};

// Verify a downloaded tarball against its pinned SHA-256. Plain lowercased string
// equality is fine here (not constant-time): the expected hash is public and
// fixed-length, so there's nothing secret to leak or guess. Exported for testing.
export function verifyTarballChecksum(
  tarballPath: string,
  expectedSha256: string,
): boolean {
  const actual = createHash("sha256")
    .update(readFileSync(tarballPath))
    .digest("hex")
    .toLowerCase();
  return actual === expectedSha256.toLowerCase();
}

// THE TWO CONFIG FILES WE WRITE - in-code templates so nothing extra ships in the
// npm tarball and there's no separate file to keep in sync.

// The telemetry .env you `source` before `claude`: turns on usage broadcast and
// holds MARGINFRONT_API_KEY for the forwarder. Stays on your machine.
export function renderEnvFile(): string {
  return `# ============================================================
# Claude Code -> MarginFront connector: environment settings
# ============================================================
# MAIN JOB of this file: hold your MARGINFRONT_API_KEY (below) so the background
# meter can read it - fill that in (init usually does it for you).
#
# You do NOT need to 'source' this before running Claude Code:
# 'init' wires the telemetry settings into ~/.claude/settings.json for you, so
# every 'claude'/'codex' session (and the desktop apps) broadcast on their own.
# Sourcing this is only useful for the manual, foreground 'run' path.
#
# This file stays on your machine; it is never published or committed.
# ============================================================

# Turns on Claude Code's usage broadcasting. Leave as 1.
CLAUDE_CODE_ENABLE_TELEMETRY=1

# Send usage as OpenTelemetry metrics. Leave as otlp.
OTEL_METRICS_EXPORTER=otlp

# Send Claude Code's EVENTS (the per-tool-call records) too. Leave as otlp.
# Tokens come in as metrics (above); a paid tool call (Google Maps, Browserbase,
# a paid MCP server) only shows up on this EVENT stream - without this line Claude
# Code broadcasts no tool activity and tool spend can't be tracked.
OTEL_LOGS_EXPORTER=otlp

# Use HTTP/protobuf. Leave as is: gRPC on 4317 drops data without an error.
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Where the local collector listens. Must match the collector YAML.
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318

# How often Claude Code flushes usage (token METRICS), in milliseconds.
#   300000 = 5 minutes - batches usage so you get roughly one event per turn
#   without a long wait. Raise to 600000 (10 min) to batch harder; lower to
#   60000 (1 min) or 5000 (5 s) for a more live drip.
OTEL_METRIC_EXPORT_INTERVAL=300000

# Same batching for the EVENT stream (the per-tool-call records above). Keep it
# equal to OTEL_METRIC_EXPORT_INTERVAL so tool activity flushes on the same
# 5-minute beat as tokens; lower both together if you want a livelier drip.
OTEL_LOGS_EXPORT_INTERVAL=300000

# Labels each MCP tool call with its server + tool name so a paid MCP tool (a metered
# API behind an MCP server) can be told apart from a free one - without this line every
# MCP call is the indistinguishable bucket "mcp_tool". Names-only leaves your machine:
# this flag also makes Claude Code write tool ARGUMENTS into the local telemetry file,
# but the meter forwards only the two names, never the arguments. Set to 0 (or delete)
# to keep MCP calls in the single unnamed bucket.
OTEL_LOG_TOOL_DETAILS=1

# Tool-call costs need NOTHING configured here. EVERY tool your agents fire is
# forwarded automatically - free built-ins like Read/Bash included (they're priced
# $0 by MarginFront's catalog). The catalog decides what's billable and at what
# rate. Add price rows for your paid tools in MarginFront - there's no client-side
# list to maintain.

# WHO this machine's AI cost belongs to (per-developer attribution).
# WHY THIS EXISTS, plainly: lots of teams share ONE Claude/Codex login, so every
# developer's usage carries the SAME login email and all the cost piles onto one
# person. CCC runs locally on each laptop, so naming the developer here splits that
# shared-login cost back out per developer. This is INTERNAL cost visibility only -
# it does NOT change anyone's bill.
#
# HOW IT'S USED at send time (precedence, highest wins):
#   1. This CCC_DEVELOPER_EMAIL, when set - it wins for EVERY record from this machine.
#   2. Otherwise the email the coding-agent login reports (user.email).
#   3. Otherwise a clearly-labeled no-identity placeholder.
# Leave it BLANK to keep today's behavior (auto-detect from the login). init fills
# this in for you, defaulting to your global git user.email - change it anytime.
CCC_DEVELOPER_EMAIL=

# WHICH ${WORK_ITEM_NOUN.toUpperCase()} this machine's spend belongs to.
# WHAT IT DOES, plainly: without it, the meter can only say "this machine spent $18
# this week." With it, it can say "$18 went to the Q3 pricing model."
# The name you put here is stamped on every record this machine sends - tokens AND
# tool calls, Claude Code AND Codex - so your spend adds up by job, not by clock.
#
# DO THIS:
#   1. Pick a short name for the ${WORK_ITEM_NOUN_PLAIN}: a ticket number, or plain words.
#   2. Type that name after the = below and save this file. There's nothing to
#      restart: the meter reads this line again on the next usage it sends.
#
# USE THE SAME SPELLING EVERY TIME, capital letters included. PROJ-123 and
# proj-123 are two different things here, and they add up as two separate jobs.
#
# This line is about spend. Counting what you FINISH is a separate switch, off until
# you run ${CCC_COMMAND_INVOCATION} done --setup, and that command says
# where to go and look once it is on.
#
# Leave it BLANK for no ${WORK_ITEM_NOUN} on the records - nothing breaks. Anything past 255 characters is trimmed.
CCC_WORK_ID=

# An older name for the line above. It still works: if CCC_WORK_ID is blank, this
# one is used. New machines should use CCC_WORK_ID.
CCC_MATTER_ID=

# WHICH REPOS THIS MACHINE NEVER SENDS SPEND FROM.
# WHAT IT DOES, plainly: name a repo here and the meter sends nothing from it at all.
# No record is built, nothing is posted, nothing waits in the outbox. Every other repo
# on this machine keeps being metered as it is today.
#
# Write one owner/repo per entry, comma-separated, spelled the way the repo's remote
# spells it:
#   CCC_IGNORE_REPOS=acme-corp/billing,acme-corp/website
# Capital letters make no difference here.
#
# A session the meter can't place in a repo is still sent. That is on purpose: the
# meter comes up empty-handed for plenty of ordinary reasons, and going quiet on all
# of them would stop metering this machine with nothing to show you why.
#
# There's nothing to restart. Add a repo, save the file, and the next record obeys it.
#
# Leave it BLANK to meter every repo on this machine.
CCC_IGNORE_REPOS=

# THE NAMES OF THE THINGS YOU FINISH, comma-separated.
# WHAT IT DOES, plainly: spend counting needs nothing here and never will. This line
# is the other half - what your team FINISHES - so your MarginFront page can say "a
# contract summary cost $4.10" instead of only "this machine spent $18 this week".
# \`init\` asks for these once (the question defaults to No), writes them here, and
# adds a short note to your coding assistant's memory file telling it to run
# \`done "<name>"\` when it finishes one of them.
#
# Use the words YOUR team uses, a few each: contract summarized, slide deck, bug fixed.
# Reuse the same name every time - the page groups by name, ignoring capitals.
#
# Leave it BLANK to keep spend-only counting. Turn it on later with
# \`node ~/.marginfront-ccc/cli.js done --setup\`, which asks both questions again.
CCC_FINISHED_WORK=

# WHICH prompt-cache WRITE rate this machine's Claude Code sessions get billed at.
# Anthropic bills "cache writes" (saving your prompt for reuse) at two rates,
# depending on how Claude Code signs in:
#   5m = 5-minute cache (API key / Bedrock / Vertex sign-ins) - 1.25x input rate
#   1h = 1-hour cache (Claude subscription sign-ins: Pro/Max/Team) - 2x input rate
# init detects this (or asks one question) and fills it in. Leave BLANK if unsure:
# MarginFront then prices cache writes at the 1-hour ceiling, which can overstate
# but never understate. Change it anytime if this machine's sign-in changes.
CCC_CACHE_WRITE_TTL=

# WHICH MarginFront server this machine sends to: your server's API address,
# including /v1. Example: https://billing.example.com/v1
# REQUIRED - there is no built-in server, and nothing is sent until this is set.
# It must be https, or http to this machine (localhost, 127.0.0.1, [::1]).
# init fills it in. Change it here, then \`stop\` and \`start\`.
MARGINFRONT_API_URL=

# Leave this OFF unless your server is plain http on a private network you trust.
# Set to 1 to allow http to another machine; your key then travels unencrypted.
MARGINFRONT_ALLOW_INSECURE_HTTP=

# YOUR MarginFront SECRET key (mf_sk_*). Create or copy one in your MarginFront
# dashboard: Build -> API keys -> "Create key pair".
# Use the SECRET key (mf_sk_*) - a publishable key (mf_pk_*) is rejected on send.
# The forwarder reads this from the environment only; it is never hardcoded.
# Leave blank to run in no-identity preview mode: nothing is sent, and \`preview\`
# still shows what would be.
MARGINFRONT_API_KEY=
`;
}

// The collector ("catcher") config: OTLP in on localhost, cumulative->delta to
// avoid double-counting, one JSON line out to the file the forwarder tails. The
// absolute JSONL path is injected so it's independent of the launch directory.
export function renderCollectorYaml(
  jsonlPath: string = LIVE_JSONL_PATH,
): string {
  return `# OpenTelemetry Collector config - Claude Code -> MarginFront
# ---------------------------------------------------------------------------
# WHAT THIS DOES, plainly: it's the "catcher." Claude Code broadcasts its token
# usage here; this collector batches what it hears and writes it to a file,
# which the forwarder tails and turns into MarginFront usage rows.
# ---------------------------------------------------------------------------

receivers:
  # The door Claude Code knocks on. It listens for OpenTelemetry (OTLP) on the
  # two standard local ports. Claude Code sends HTTP/protobuf to 4318, because
  # gRPC on 4317 drops data without an error. Bound to localhost only.
  otlp:
    protocols:
      grpc:
        endpoint: 127.0.0.1:4317
      http:
        endpoint: 127.0.0.1:4318

processors:
  # THE NO-DOUBLE-COUNT PROCESSOR. Claude Code emits CUMULATIVE counters (each
  # export is the running total since the session started), and it ignores the
  # "give me deltas" env var. Without this, the forwarder would record the
  # running total every export - re-counting everything before it. This turns
  # each cumulative total into the increment since the last export.
  cumulativetodelta: {}

  # THE THREE THINGS A COST METER HAS NO BUSINESS STORING. Claude Code reports your
  # prompt, the model's reply and each tool call's input on its log records, and the
  # exporter below writes every attribute to your disk. tool_input arrives in the
  # clear and can be the contents of a file the agent edited; prompt and response
  # usually arrive as "<REDACTED>", but that depends on a Claude Code setting we do
  # not control, so all three are deleted here rather than trusting it.
  # NOT in this list: tool_name, which is how a tool call gets priced at all.
  attributes/drop-content:
    actions:
      - key: prompt
        action: delete
      - key: response
        action: delete
      - key: tool_input
        action: delete

  # THE SHELL COMMAND'S SECOND COPY. Dropping tool_input above is not enough on its
  # own: for a Bash call Claude Code repeats the same command inside tool_parameters,
  # so the whole command line was still landing on your disk. So tool_parameters goes
  # too - everywhere EXCEPT on an MCP record, which the exclude rule below spares.
  # Claude Code labels every MCP call "mcp_tool" and puts the server and tool it
  # really called in tool_parameters, and that is the only place either name appears,
  # so dropping it there would turn every MCP tool on the bill into one unnamed line.
  attributes/drop-tool-params-except-mcp:
    exclude:
      match_type: strict
      attributes:
        - key: tool_name
          value: mcp_tool
    actions:
      - key: tool_parameters
        action: delete

  # Group what arrives into small batches and flush quickly, so the live view
  # feels near-real-time rather than trickling one datapoint at a time.
  batch:
    timeout: 1s

exporters:
  # Write each batch as one line of OTLP/JSON (JSON Lines). The forwarder
  # watches this file and records each new line. Both pipelines below share this
  # one exporter, so Claude Code's metrics and Codex's logs land in the SAME file
  # (each as its own line) and the one forwarder reads both.
  file:
    path: ${jsonlPath}

service:
  telemetry:
    logs:
      # The collector's OWN log verbosity (how chatty otelcol itself is). This is
      # NOT a data pipeline - it does not catch Codex's usage logs. The pipeline
      # that does is service.pipelines.logs below. Keep this quiet.
      level: warn
  pipelines:
    # Claude Code source: token + cost COUNTERS arrive as metrics.
    # Receive -> de-dupe (cumulative->delta) -> drop content -> batch -> file. No
    # content key rides on a metric today; the drop is here so that a new one would
    # not quietly start landing on disk.
    metrics:
      receivers: [otlp]
      processors: [cumulativetodelta, attributes/drop-content, batch]
      exporters: [file]
    # Codex source: Codex reports usage on the LOG stream, not as
    # metrics, so it needs its own pipeline. No cumulativetodelta here - that's a
    # METRICS processor and doesn't apply to logs; each Codex log record is one
    # turn's usage on its own. Claude Code's tool and prompt events arrive here, which
    # is the pipeline the two content drops are actually for.
    # Receive -> drop content -> drop tool parameters (except MCP) -> batch -> file
    # (the same file).
    logs:
      receivers: [otlp]
      processors: [attributes/drop-content, attributes/drop-tool-params-except-mcp, batch]
      exporters: [file]
`;
}

// WHERE CODEX KEEPS ITS CONFIG. As Claude Code reads ~/.claude/settings.json,
// Codex reads ~/.codex/config.toml on every run. We point Codex at the SAME local
// collector by adding one small [otel] block here.
export const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

// WHERE EACH ASSISTANT KEEPS THE INSTRUCTIONS IT READS EVERY SESSION. `init` writes
// ONE fenced note here when the customer turns finished-work counting on, and
// `uninstall` takes it back out. homedir() reads USERPROFILE on Windows, so these
// are the %USERPROFILE% paths there without a second spelling.
export const CLAUDE_MEMORY_PATH = join(homedir(), ".claude", "CLAUDE.md");
export const CODEX_MEMORY_PATH = join(homedir(), ".codex", "AGENTS.md");

// OUR FENCE POSTS inside the user's config.toml. We only ever add - and later
// remove - the lines BETWEEN these two comment markers, so a hand-written config
// is never touched outside the fence. (TOML treats a leading "#" as a comment, so
// these lines are inert to Codex itself.) Changing these strings would orphan a
// block written by an older version, so treat them as a stable contract.
export const CODEX_CCC_BEGIN_MARKER =
  "# >>> MarginFront code-cost-clarity - auto-added; the meter's `uninstall` command removes this block >>>";
// A second accepted opening marker, the one that names the npx command. A re-run of
// `init` sees a block that starts with it as already wired, and `uninstall` removes it.
export const LEGACY_CODEX_CCC_BEGIN_MARKER =
  "# >>> MarginFront code-cost-clarity - auto-added; `npx @marginfront/code-cost-clarity uninstall` removes this block >>>";

function isCodexBeginMarker(line: string): boolean {
  return (
    line === CODEX_CCC_BEGIN_MARKER || line === LEGACY_CODEX_CCC_BEGIN_MARKER
  );
}

function hasCodexBeginMarker(content: string): boolean {
  return content.split("\n").some(isCodexBeginMarker);
}
export const CODEX_CCC_END_MARKER =
  "# <<< MarginFront code-cost-clarity - end of auto-added block <<<";

// THE CODEX TELEMETRY BLOCK - makes Codex stream its usage to the
// local collector. This is the single source of truth:
// both the paste-in instructions and the auto-writer below render from it, so the
// two can never drift apart. The nested "otlp-http" form is the shape Codex's
// config parser expects; the /v1/logs endpoint is where Codex sends its usage logs.
export const CODEX_OTEL_TOML_BLOCK = [
  "[otel]",
  'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }',
].join("\n");

// The exact bytes we write into config.toml: the telemetry block, fenced by our
// BEGIN/END markers so the reverter can find and remove ONLY what we added.
function renderCodexCccBlock(): string {
  return [
    CODEX_CCC_BEGIN_MARKER,
    CODEX_OTEL_TOML_BLOCK,
    CODEX_CCC_END_MARKER,
  ].join("\n");
}

// CODEX ONBOARDING: config block the developer pastes into their own
// ~/.codex/config.toml to point Codex at the same collector. We PRINT this only as
// a FALLBACK - when the user already has their own [otel] section and we won't
// rewrite it for them (see writeCodexOtelConfig). Returned as a string so it's
// testable and cli.ts owns when to print.
export function renderCodexConfigInstructions(): string {
  return [
    "Optional - also capture Codex (in addition to, or instead of, Claude Code):",
    "",
    "  Codex reports its usage to the SAME local collector, so there's nothing",
    "  extra to install. Add this block to your ~/.codex/config.toml:",
    "",
    // Single-sourced from CODEX_OTEL_TOML_BLOCK above, indented for the printout,
    // so the pasted block always matches what the auto-writer would write.
    ...CODEX_OTEL_TOML_BLOCK.split("\n").map((line) => "    " + line),
    "",
    "  Then run Codex normally. `run` already watches both sources - Claude Code,",
    "  Codex, or both - from the one collector file; there's no extra flag.",
    "",
    "  Note: exact [otel] key names can vary by Codex version, and whether your",
    "  developer email shows up depends on how you sign in (org API key vs ChatGPT",
    "  login). If the email doesn't surface, usage still lands under the no-identity",
    "  placeholder. Full details:",
    '  packages/code-cost-clarity/README.md, "Also capture Codex"',
  ].join("\n");
}

// Result of a Codex config write: WHICH of the three safe outcomes happened, and
// where the safety backup landed (null when we created a brand-new file or didn't
// touch an existing one).
export interface WriteCodexConfigResult {
  // "created"          - there was no config.toml, so we made one with our block.
  // "appended"         - config.toml existed with no [otel], so we added our block
  //                      to the end (every existing byte left intact).
  // "skipped-existing" - either our block is already there (a re-run), OR the user
  //                      has their OWN [otel] we must not rewrite. We changed nothing.
  action: "created" | "appended" | "skipped-existing";
  backupPath: string | null;
}

// Result of a Codex config revert.
export interface RemoveCodexConfigResult {
  // "removed"   - we cut out the lines we wrote.
  // "no-marker" - the file exists but has no MarginFront block (nothing to undo).
  // "missing"   - there's no config.toml at all (nothing to undo).
  // "refused"   - our markers are there but the settings between them aren't the ones
  //               we wrote any more, so we changed nothing and said what to do by hand.
  action: "removed" | "no-marker" | "missing" | "refused";
  backupPath: string | null;
  // On "removed": the lines Codex itself had written inside our markers that we kept.
  // Empty on every other outcome. This is the receipt.
  preservedLines?: string[];
}

// Does this config text already DEFINE the "otel" thing the user wrote - in ANY of
// the legal TOML forms? We have no TOML parser and don't want one, so we read each
// non-comment line and ask: is its FIRST bare token (the bit before a ".", an "=",
// or inside a "[...]" header) the word "otel"? That single rule covers every way
// TOML lets you open the otel table:
//   - a table HEADER:            "[otel]", "[otel.exporter]", "[[otel]]"
//   - a root-level dotted key:   otel.environment = "prod"
//   - a root-level inline table: otel = { exporter = "none" }
// WHY ALL THREE MATTER: if the user defined "otel"
// with dotted keys or an inline table and we only watched for "[otel]" HEADERS, we'd
// happily APPEND our own "[otel]" block - and a config that defines the same table
// twice is INVALID TOML, which silently bricks the user's Codex on its very next
// run. So we treat ANY of these forms as "the user already owns otel" and never
// write. We ignore comment lines and only ever read a key's NAME (never its value),
// so "[otel]" inside a comment, or a value like model = "otel-ish", can't fool us -
// and a near-miss like "[otelemetry]" or "otelemetry = true" correctly does NOT count.
function lineDeclaresOtelTable(rawLine: string): boolean {
  // Anything after a "#" is a comment - drop it first so a commented-out line is inert.
  const beforeComment = rawLine.split("#")[0].trim();
  if (!beforeComment) return false;

  let firstToken: string;
  if (beforeComment.startsWith("[")) {
    // A table HEADER. Peel the opening "[" (or "[[" for an array-of-tables), then
    // read the dotted table path up to its closing "]". The FIRST dotted key is the
    // table name.
    const inner = beforeComment.replace(/^\[+/, "").trim();
    const path = inner.split("]")[0].trim();
    firstToken = path.split(".")[0].trim();
  } else {
    // A root-level key line: either a dotted key ("otel.environment = ...") or an
    // inline table ("otel = { ... }"). The first bare token is everything up to the
    // first ".", "=", or whitespace.
    firstToken = beforeComment.split(/[.=\s]/)[0].trim();
  }
  // Strip a single pair of surrounding quotes a TOML key may carry, then compare.
  firstToken = firstToken.replace(/^["']|["']$/g, "");
  return firstToken === "otel";
}

function codexConfigHasOtelTable(content: string): boolean {
  return content.split(/\r?\n/).some(lineDeclaresOtelTable);
}

// True when config.toml already contains OUR marker-wrapped block (i.e. we wrote it
// on a previous run). cli.ts uses this to decide whether to fall back to printing
// the paste-in instructions. Never throws - an unreadable file reads as "no".
export function codexConfigHasCccBlock(
  configPath: string = CODEX_CONFIG_PATH,
): boolean {
  if (!existsSync(configPath)) return false;
  try {
    return hasCodexBeginMarker(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
}

// WIRE CODEX TO THE LOCAL COLLECTOR - the Codex twin of writeClaudeTelemetrySettings,
// and as conservative, so Codex needs no hand-editing. The rules, in order:
//   - No config.toml yet            -> create ~/.codex and the file, with our block.
//   - Our block is already present  -> a re-run; do nothing (idempotent).
//   - The user has their OWN otel    -> NEVER rewrite their TOML, in ANY form they
//                                       wrote it ([otel] header, otel.x dotted key,
//                                       or otel = {…} inline table). Leave it byte-for-
//                                       byte untouched; the caller prints the paste-in
//                                       block so they can merge it by hand.
//   - File exists, no otel at all   -> back it up, then APPEND our block after a
//                                       single newline (append-only - existing bytes
//                                       are never edited).
// We never parse or rewrite arbitrary TOML; we only ever add or remove our own fenced
// block. That's the whole safety story.
export function writeCodexOtelConfig({
  configPath = CODEX_CONFIG_PATH,
  log = console.log,
}: { configPath?: string; log?: LogFn } = {}): WriteCodexConfigResult {
  // 1) No file yet -> make ~/.codex (if needed) and drop in our fenced block.
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, renderCodexCccBlock() + "\n");
    log(
      `Created ${configPath} and wired Codex to the local collector for you.`,
    );
    return { action: "created", backupPath: null };
  }

  const content = readFileSync(configPath, "utf8");

  // 2) Our block is already there (this is a re-run) -> nothing to do.
  if (hasCodexBeginMarker(content)) {
    log(`Codex is already wired up in ${configPath} - nothing to do.`);
    return { action: "skipped-existing", backupPath: null };
  }

  // 3) The user already has their OWN [otel] table. We will not rewrite arbitrary
  //    TOML - leave the file byte-for-byte untouched. The caller prints the paste-in
  //    block so they can merge it themselves.
  if (codexConfigHasOtelTable(content)) {
    log(
      `Left your existing [otel] settings in ${configPath} untouched - ` +
        "add the MarginFront block by hand if you want Codex captured too.",
    );
    return { action: "skipped-existing", backupPath: null };
  }

  // 4) File exists with other tables but no [otel] -> back it up first, then APPEND
  //    our block. We insert EXACTLY ONE newline between the user's content and our
  //    block - the SAME single byte the reverter removes - and nothing else. That one
  //    byte is the whole trick behind a byte-identical init->uninstall round-trip:
  //      - if the file already ended in a newline, that one + ours reads as a blank
  //        line separating their config from ours;
  //      - if it did NOT end in a newline, our one newline simply moves our block onto
  //        its own line (no blank line, but still valid TOML).
  //    Either way the reverter later removes precisely one newline and the file goes
  //    back to its EXACT pre-append bytes - no phantom trailing newline left behind.
  const backupPath = `${configPath}.ccc-bak`;
  copyFileSync(configPath, backupPath);
  // No leading newline if the file was empty; otherwise exactly one.
  const separator = content.length > 0 ? "\n" : "";
  writeFileSync(configPath, content + separator + renderCodexCccBlock() + "\n");
  log(
    `Added the MarginFront telemetry block to ${configPath} (backup at ${backupPath}).`,
  );
  return { action: "appended", backupPath };
}

// REVERSE THE WRITE ABOVE - surgically, LINE BY LINE.
//
// NEVER delete BEGIN-marker-to-END-marker. Codex appends its own tables to the end of
// config.toml, and the end of the file is INSIDE our fence, where it can hold
// [hooks.state], the record of which hooks the developer has approved. So we remove
// only the exact lines we wrote and keep every line we don't recognise. If the
// settings between the markers aren't ours any more, we change nothing and print the
// manual fix.
//
// SAFETY NOTE on backups: this revert does NOT make a fresh backup. The pristine,
// pre-install original was already copied to "<config>.ccc-bak" at append time; copying
// the CURRENT (with-our-block) file over it here would destroy the user's only true
// original. So we leave that backup untouched and merely point at it if it still
// exists - an init->uninstall cycle always leaves the real original recoverable.
export function removeCodexOtelConfig({
  configPath = CODEX_CONFIG_PATH,
  log = console.log,
}: { configPath?: string; log?: LogFn } = {}): RemoveCodexConfigResult {
  if (!existsSync(configPath)) {
    log(
      `Nothing to undo: ${configPath} doesn't exist (Codex was never wired up here).`,
    );
    return { action: "missing", backupPath: null };
  }

  const content = readFileSync(configPath, "utf8");
  const lines = content.split("\n");
  const beginIdx = lines.findIndex(isCodexBeginMarker);
  const endIdx = lines.indexOf(CODEX_CCC_END_MARKER, beginIdx + 1);
  // No usable marker pair -> we never wrote here (or someone edited the markers
  // out). Leave the whole file untouched.
  if (beginIdx === -1 || endIdx === -1) {
    log(
      `Nothing to undo: ${configPath} has no MarginFront block ` +
        "(left every other setting untouched).",
    );
    return { action: "no-marker", backupPath: null };
  }

  const manualFix =
    `Fix by hand: open ${configPath}, delete the two "MarginFront ` +
    'code-cost-clarity" comment lines and the [otel] block between them, and leave ' +
    "everything else exactly as it is.";

  const ourLines = CODEX_OTEL_TOML_BLOCK.split("\n");
  let ourStart = -1;
  for (let i = beginIdx + 1; i + ourLines.length - 1 < endIdx; i += 1) {
    if (ourLines.every((line, offset) => lines[i + offset] === line)) {
      ourStart = i;
      break;
    }
  }
  if (ourStart === -1) {
    log(
      `Left ${configPath} untouched: the MarginFront settings between our two ` +
        "comment lines aren't the ones we wrote any more, so we won't guess at what " +
        `to delete. ${manualFix}`,
    );
    return { action: "refused", backupPath: null };
  }

  // Did anyone add their own keys to OUR [otel] table? Everything from just after our
  // exporter line up to the next table header (or the END marker) still belongs to
  // [otel], so a real setting there is not ours to delete.
  const ourEnd = ourStart + ourLines.length - 1;
  for (let i = ourEnd + 1; i < endIdx; i += 1) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    log(
      `Left ${configPath} untouched: someone added their own setting to the ` +
        `MarginFront [otel] block ("${line}"), and deleting it could break how ` +
        `Codex reports. ${manualFix}`,
    );
    return { action: "refused", backupPath: null };
  }

  const drop = new Set<number>([beginIdx, endIdx]);
  for (let i = ourStart; i <= ourEnd; i += 1) drop.add(i);
  // GIVE BACK THE ONE NEWLINE WE ADDED. On append we wrote exactly one newline before
  // our block and one after it, so an init -> uninstall round trip has to return
  // exactly one - and which one depends on how the user's file ended:
  //   - it ended in a newline  -> ours shows up as a blank line above BEGIN.
  //   - it did NOT end in one  -> there is no blank above BEGIN, and the newline we
  //                               added is the one that now ends the file.
  if (beginIdx > 0 && lines[beginIdx - 1] === "") {
    drop.add(beginIdx - 1);
  } else if (endIdx === lines.length - 2 && lines[lines.length - 1] === "") {
    drop.add(lines.length - 1);
  }

  const preservedLines = lines
    .slice(beginIdx + 1, endIdx)
    .filter((_, offset) => !drop.has(beginIdx + 1 + offset))
    .filter((line) => line.trim() !== "");

  // Do NOT re-back-up here (see the SAFETY NOTE above). Point at the pristine
  // append-time backup if it's still around so the user knows where their original is.
  const backupPath = existsSync(`${configPath}.ccc-bak`)
    ? `${configPath}.ccc-bak`
    : null;
  writeFileSync(configPath, lines.filter((_, i) => !drop.has(i)).join("\n"));
  log(
    `Removed the MarginFront block from ${configPath}` +
      (preservedLines.length > 0
        ? ` and kept the ${preservedLines.length} setting line(s) Codex had written there`
        : "") +
      (backupPath ? ` (your original is preserved at ${backupPath}).` : "."),
  );
  return { action: "removed", backupPath, preservedLines };
}

// ===========================================================================
// THE FINISHED-WORK NOTE in the assistant's own memory file
// ---------------------------------------------------------------------------
// `init` asks once (default No) and, on a yes, writes ONE fenced block here;
// `uninstall` takes it back out. Why a memory file: see finished-work.ts.

// How every printed line in this package spells a command, so the note the assistant
// reads and the README a human reads never drift. It is the copy `init` installs,
// so it works wherever the source checkout lives. The dashboard's install page
// spells it the same way (apps/dashboard/lib/meter-command.ts).
export const CCC_COMMAND_INVOCATION = "node ~/.marginfront-ccc/cli.js";

// The first run, before `init` has copied the built program to its stable home.
// Run from the root of a MarginFront source checkout after building this package.
export const CCC_SOURCE_INIT_COMMAND =
  "node packages/code-cost-clarity/dist/cli.js init";

export type MemoryBlockAction =
  | "written"
  | "removed"
  | "missing"
  | "no-marker"
  | "no-directory";

export interface MemoryBlockResult {
  path: string;
  action: MemoryBlockAction;
}

// We create the FILE but never the DIRECTORY: a ~/.codex that is not there means
// Codex keeps its home somewhere else, and making one would hand the customer an
// empty directory their assistant never reads.
function writeMemoryBlockAt(path: string, block: string): MemoryBlockResult {
  if (!existsSync(dirname(path))) return { path, action: "no-directory" };
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, insertMemoryBlock(current, block));
  return { path, action: "written" };
}

function removeMemoryBlockAt(path: string): MemoryBlockResult {
  if (!existsSync(path)) return { path, action: "missing" };
  const removed = removeMemoryBlock(readFileSync(path, "utf8"));
  if (!removed.found) return { path, action: "no-marker" };
  // Nothing but our block was ever in it, so the file itself was ours: taking the
  // block out and leaving an empty file behind is litter, not a clean uninstall.
  if (removed.text.trim() === "") rmSync(path, { force: true });
  else writeFileSync(path, removed.text);
  return { path, action: "removed" };
}

export function writeFinishedWorkMemoryBlocks({
  names = [],
  claudePath = CLAUDE_MEMORY_PATH,
  codexPath = CODEX_MEMORY_PATH,
  claudeInstalled = isClaudeCodeInstalled(),
  codexInstalled = isCodexInstalled(),
}: {
  names?: readonly string[];
  claudePath?: string;
  codexPath?: string;
  claudeInstalled?: boolean;
  codexInstalled?: boolean;
} = {}): MemoryBlockResult[] {
  // The flag only appears when BOTH are here: with one installed `done` resolves the
  // assistant on its own, and a flag in that file is one more thing to get wrong.
  const both = claudeInstalled && codexInstalled;
  const blockFor = (agentCode: string): string =>
    renderFinishedWorkMemoryBlock(
      names,
      CCC_COMMAND_INVOCATION,
      both ? agentCode : undefined,
    );
  const results: MemoryBlockResult[] = [];
  if (claudeInstalled) {
    results.push(writeMemoryBlockAt(claudePath, blockFor("claude-code")));
  }
  if (codexInstalled) {
    results.push(writeMemoryBlockAt(codexPath, blockFor("codex")));
  }
  return results;
}

// NOT gated on the assistant still being installed: `uninstall` runs long after
// someone may have removed Codex, and our block would outlive it.
export function removeFinishedWorkMemoryBlocks({
  claudePath = CLAUDE_MEMORY_PATH,
  codexPath = CODEX_MEMORY_PATH,
}: { claudePath?: string; codexPath?: string } = {}): MemoryBlockResult[] {
  return [removeMemoryBlockAt(claudePath), removeMemoryBlockAt(codexPath)];
}

// PLATFORM DETECTION - map Node's platform/arch to the OTel release-asset names
// (e.g. "x64" -> "amd64"). Exported so the checksum-coverage test derives the set
// of resolvable platforms instead of restating a list that would go stale.
export const COLLECTOR_OS_MAP: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
export const COLLECTOR_ARCH_MAP: Record<string, string> = {
  arm64: "arm64",
  x64: "amd64",
};

export function resolveCollectorAsset(
  nodePlatform: string = platform(),
  nodeArch: string = arch(),
  version: string = OTELCOL_VERSION,
): CollectorAsset {
  const os: string | undefined = COLLECTOR_OS_MAP[nodePlatform];
  const cpu: string | undefined = COLLECTOR_ARCH_MAP[nodeArch];

  if (!os) {
    throw new Error(
      `What happened: this tool won't install on "${nodePlatform}".\n` +
        "Why: it measures your usage with a program called the OpenTelemetry " +
        "collector, and that program is only published for macOS, Linux, and " +
        "Windows. We stop here rather than download something this machine " +
        "can't run.\n" +
        "Fix: run this on macOS, Windows, or Linux.",
    );
  }
  if (!cpu) {
    throw new Error(
      `Unsupported CPU architecture "${nodeArch}". The bundled collector ` +
        "supports arm64 and x64 (amd64).",
    );
  }

  // Asset filenames drop the leading "v": v0.154.0 -> otelcol-contrib_0.154.0_...
  // Upstream ships Windows as a .tar.gz too, not a .zip - the only Windows-shaped
  // assets in the release are .msi installers, which we don't want.
  const versionNoV = version.replace(/^v/, "");
  const asset = `otelcol-contrib_${versionNoV}_${os}_${cpu}.tar.gz`;
  const url =
    "https://github.com/open-telemetry/opentelemetry-collector-releases/" +
    `releases/download/${version}/${asset}`;

  return {
    os,
    cpu,
    asset,
    url,
    version,
    binaryName: collectorBinaryName(nodePlatform),
  };
}

// EXPORTED SO THEY CAN BE TESTED, not for reuse. Both shell-outs are reachable only
// through init, which refuses on Windows, so a wrong argument shape there would first
// surface on a customer's machine mid-download. Named, a test drives the exact
// invocation; a copy of the arguments in a test would drift and keep passing.

// -f: fail on 404 rather than saving the error page. -L: follow GitHub's CDN redirect.
// Throws whatever execFileSync throws; the caller owns the friendly message.
export function downloadToFile(url: string, destPath: string): void {
  execFileSync("curl", ["-fSL", "-o", destPath, url], { stdio: "inherit" });
}

// Naming one member rather than unpacking everything is what keeps a 360 MB archive
// from landing whole in the user's config dir.
export function extractTarGzMember(
  tgzPath: string,
  destDir: string,
  member: string,
): void {
  execFileSync("tar", ["xzf", tgzPath, "-C", destDir, member], {
    stdio: "inherit",
  });
}

// FETCH THE COLLECTOR BINARY (~360 MB) if absent - too big for the npm tarball and
// not in Homebrew core, so we curl + tar it from OTel's GitHub releases (streaming,
// to avoid holding the whole archive in memory).
export function ensureCollectorBinary({
  force = false,
  log = console.log,
}: { force?: boolean; log?: LogFn } = {}): string {
  if (existsSync(COLLECTOR_BIN_PATH) && !force) {
    log(
      `Collector already present at ${COLLECTOR_BIN_PATH} - skipping download.`,
    );
    return COLLECTOR_BIN_PATH;
  }

  const { asset, url, version, binaryName } = resolveCollectorAsset();
  const tgzPath = join(tmpdir(), asset);

  log(
    `Downloading the collector (${asset}, ~360 MB) - this can take a minute…`,
  );
  try {
    downloadToFile(url, tgzPath);
  } catch {
    throw new Error(
      `Could not download the collector from ${url}\n` +
        `What happened: the download failed (network issue, or version ${version} ` +
        "has no asset for your platform).\n" +
        "Fix: check your internet connection, or pin a different version with " +
        "CCC_OTELCOL_VERSION=v0.155.0 (see the OpenTelemetry collector releases page).",
    );
  }

  // THE INTEGRITY GATE (security). Before chmod/exec, hash the bytes that landed
  // and demand an exact match to the pinned fingerprint. No fingerprint = refuse
  // (leave the temp file to inspect); mismatch = delete it, then fail loudly. Only
  // an exact match reaches the tar/chmod/spawn steps below.
  const expectedSha256 = COLLECTOR_CHECKSUMS[asset];
  if (!expectedSha256) {
    // Don't delete: no proof it's bad, and an operator pinning a new version will
    // want it to checksum before adding to COLLECTOR_CHECKSUMS.
    throw new Error(
      `Refusing to run an unverified collector.\n` +
        `What happened: there is no pinned, known-good fingerprint on file for ` +
        `"${asset}" (version ${version}).\n` +
        "Why: this tool refuses to make ANY downloaded program executable unless " +
        "we can first confirm it's exactly the release we trust.\n" +
        "Fix: install the built-in pinned version (unset CCC_OTELCOL_VERSION), or " +
        "add this release's official signed SHA-256 to the package's pinned " +
        `checksums before installing it. The download is left at ${tgzPath} so you ` +
        "can verify it yourself.",
    );
  }

  log("Verifying the downloaded collector's fingerprint…");
  if (!verifyTarballChecksum(tgzPath, expectedSha256)) {
    // Bytes don't match: treat as hostile - delete so nothing can pick it up, then fail.
    try {
      rmSync(tgzPath, { force: true });
    } catch {
      /* best effort - the throw below still stops the install either way */
    }
    throw new Error(
      `Collector integrity check FAILED - refusing to install.\n` +
        `What happened: the collector we downloaded for "${asset}" does NOT match ` +
        "its known-good fingerprint, so we deleted it and stopped.\n" +
        "Why this probably happened: the file was altered between GitHub and your " +
        "machine - most often a corporate TLS-inspecting proxy rewriting the " +
        "download, a corrupted transfer, or (worst case) a tampered release.\n" +
        "Fix: re-run the install on a network without a man-in-the-middle proxy. " +
        "If it keeps failing on a clean network, do NOT bypass this - report it, " +
        "because a persistent mismatch can mean the download is being tampered with.",
    );
  }
  log("Fingerprint verified - the collector is exactly the trusted release.");

  log(`Unpacking the collector into ${CONFIG_DIR}…`);
  try {
    extractTarGzMember(tgzPath, CONFIG_DIR, binaryName);
  } catch {
    throw new Error(
      `Could not unpack ${tgzPath}.\n` +
        "What happened: the downloaded archive didn't contain the expected " +
        `${binaryName} binary, or tar isn't available.\n` +
        "Fix: delete the file above and re-run `node ~/.marginfront-ccc/cli.js init`.",
    );
  } finally {
    // Clean up the downloaded archive either way; the binary is what we keep.
    try {
      rmSync(tgzPath, { force: true });
    } catch {
      /* best effort; a leftover temp file is harmless */
    }
  }

  // Make sure it's executable (tar usually preserves the bit, but be safe).
  // Skipped on Windows rather than called-and-ignored: NTFS answers a chmod by
  // reporting a mode it never applied, so the call would prove nothing. The .exe
  // suffix is what makes the file runnable there.
  if (platform() !== "win32") {
    try {
      execFileSync("chmod", ["755", COLLECTOR_BIN_PATH]);
    } catch {
      /* on a filesystem that ignores the bit this is a no-op; ignore */
    }
  }

  log(`Collector installed at ${COLLECTOR_BIN_PATH}.`);
  return COLLECTOR_BIN_PATH;
}

// The account the file should belong to. USERDOMAIN is the machine name on a
// standalone box and the domain on a joined one; either way "DOMAIN\user" is the
// form Windows resolves without ambiguity when two accounts share a short name.
function windowsAccountName(): string {
  const user = process.env["USERNAME"] || userInfo().username;
  const domain = process.env["USERDOMAIN"];
  return domain ? `${domain}\\${user}` : user;
}

// WRITE A FILE THAT HOLDS A SECRET, and actually keep other accounts out of it.
//
// 0600 plus a chmod is the whole story on macOS and Linux. On Windows it is theatre:
// NTFS has no mode bits and Node's chmod writes no ACL, so a real Windows run measures this
// .env coming back 0o666 on a real runner. Windows therefore also gets its access
// list replaced. Best effort: a volume that holds no ACLs must not take setup down,
// so it warns instead of throwing.
export interface OwnerOnlyOutcome {
  ok: boolean;
  account: string;
  // Diagnostics: "it did not work" alone cannot tell an unresolvable account name
  // from a volume that holds no ACLs, and those need opposite fixes.
  status: number | null;
  output: string;
}

// REPLACE the file's access list with a single entry, rather than editing it.
//
// NOT icacls: `icacls f /inheritance:r /grant:r user:F` exits 0 on windows-latest
// and leaves SYSTEM and Administrators in place, because the entries it printed back
// carry no (I) marker - they are explicit, and /inheritance:r only removes inherited
// ones. Measured, not assumed.
//
// BUILT, not edited, and through .NET rather than the Get-Acl / Set-Acl cmdlets.
// Those live in Microsoft.PowerShell.Security, which on windows-latest refuses to
// autoload - "the module could not be loaded", CouldNotAutoloadMatchingModule, with
// or without an execution-policy override. The static calls below carry no module
// dependency. A fresh FileSecurity starts with an empty list, so protecting it and
// adding one rule IS the finished access list; nothing has to be subtracted.
//
// The path and account travel as environment variables, not inside the script text:
// a Windows account name may contain an apostrophe (O'Brien), and that quoting bug
// would silently leave the API key readable.
const OWNER_ONLY_POWERSHELL = [
  "$ErrorActionPreference='Stop'",
  "$acl=[System.Security.AccessControl.FileSecurity]::new()",
  "$acl.SetAccessRuleProtection($true,$false)",
  "$id=[System.Security.Principal.NTAccount]::new($env:MF_CCC_ACL_ACCOUNT)",
  "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','Allow')",
  "$acl.AddAccessRule($rule)",
  "[System.IO.File]::SetAccessControl($env:MF_CCC_ACL_PATH,$acl)",
].join("; ");

// Split out from the write so a test can drive it against a file it made itself and
// read the failure text, rather than inferring from a silent no-op.
export function restrictToOwnerOnWindows(path: string): OwnerOnlyOutcome {
  const account = windowsAccountName();
  const applied = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      // Get-Acl lives in Microsoft.PowerShell.Security, and loading a module runs
      // script, so a Restricted execution policy fails this with
      // CouldNotAutoloadMatchingModule rather than anything about permissions.
      // Measured on windows-latest. This flag is process-scoped; it changes no
      // machine setting.
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      OWNER_ONLY_POWERSHELL,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        MF_CCC_ACL_PATH: path,
        MF_CCC_ACL_ACCOUNT: account,
      },
    },
  );
  return {
    ok: applied.status === 0,
    account,
    status: applied.status,
    output: `${applied.stdout ?? ""}${applied.stderr ?? ""}${
      applied.error ? ` (${applied.error.message})` : ""
    }`,
  };
}

export function writeSecretFile(
  path: string,
  contents: string,
  {
    warn = console.error,
    nodePlatform = platform(),
  }: { warn?: LogFn; nodePlatform?: string } = {},
): void {
  // `mode` only applies when writeFileSync CREATES the file; the chmod is what
  // covers an .env that was already sitting there.
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  if (nodePlatform !== "win32") return;

  const { ok, account, status, output } = restrictToOwnerOnWindows(path);
  if (ok) return;

  // Deliberately NOT an icacls one-liner: per the OWNER_ONLY_POWERSHELL note
  // above, that command exits 0 and fixes nothing.
  const reason = output.trim().split("\n")[0] ?? `exit code ${status}`;
  warn(
    [
      `Heads up: I couldn't lock ${path} down to your account only.`,
      "",
      "What happened: your key is saved, but that file is still readable by the",
      "other accounts on this PC.",
      "Why: Windows decides who can open a file with an access list, and the",
      "PowerShell command that rebuilds this file's list failed.",
      `Windows said: ${reason}`,
      "",
      "Fix, three steps in File Explorer:",
      `  1. Right-click ${path}, choose Properties, then the Security tab.`,
      "  2. Click Advanced, then Disable inheritance, then Remove all inherited",
      "     permissions from this object.",
      `  3. Click Add, enter ${account}, tick Full control, then OK your way out.`,
      "",
      "Rather not? Delete the key line from that file and set MARGINFRONT_API_KEY",
      "as an environment variable instead. Nothing's left on disk that way.",
    ].join("\n"),
  );
}

// CREATE THE CONFIG DIR + WRITE THE TWO CONFIG FILES. Never clobber an existing
// .env (holds your API key); the YAML is always re-written from template (no secret).
export function ensureConfigFiles({
  log = console.log,
}: { log?: LogFn } = {}): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    log(`Created ${CONFIG_DIR}.`);
  }

  if (existsSync(ENV_PATH)) {
    log(`Kept your existing settings file at ${ENV_PATH} (API key preserved).`);
  } else {
    writeSecretFile(ENV_PATH, renderEnvFile());
    log(`Wrote settings template to ${ENV_PATH} - add your API key there.`);
  }

  writeFileSync(COLLECTOR_CONFIG_PATH, renderCollectorYaml());
  log(`Wrote collector config to ${COLLECTOR_CONFIG_PATH}.`);
}

// LOAD SAVED SETTINGS into process.env - KEY=value lines, WITHOUT overriding
// anything already set (a shell export wins). Lets `run` work after `init`
// without a manual `source`.
export function loadEnvFile(path: string = ENV_PATH): Record<string, string> {
  if (!existsSync(path)) return {};
  const loaded: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single pair of surrounding quotes if present.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    loaded[key] = value;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return loaded;
}

// SAVE A PASTED API KEY into the .env in place: drop the value onto the existing
// MARGINFRONT_API_KEY= line (surrounding settings/comments untouched), file kept
// at 0600. Secret is written ONLY to this file, never logged/returned. Replace via
// a function (not a string) so a `$` in the key isn't read as a back-reference;
// append the line if it's missing so a pasted key is never lost.
export function writeApiKeyToEnv(value: string, path: string = ENV_PATH): void {
  setEnvLine(path, "MARGINFRONT_API_KEY", value);
}

// READ the developer's GLOBAL git email, used ONLY to pre-fill the init prompt.
// WHY git: when a team shares one coding-agent login, the laptop's git user.email is
// the best local guess at "who actually sits here." Best-effort and never throws: if
// git isn't installed, or no global user.email is set, we return "" and the prompt
// starts blank (which means "auto-detect from the login"). Pure read - it
// feeds the init DEFAULT only. (The live watcher does read git plumbing,
// repo/branch/SHA for cost-per-PR attribution via git-coordinates.ts, but
// only per-flush, never file contents and never at per-record frequency;
// this init-email read stays independent of that path.)
export function gitGlobalUserEmail(): string {
  try {
    const out = execFileSync("git", ["config", "--global", "user.email"], {
      encoding: "utf8",
      // Swallow git's own stderr so a "key not set" message can't leak to the user.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    // git missing, or the key isn't set (git exits non-zero) - no default, that's fine.
    return "";
  }
}

// SAVE the per-developer attribution email into the .env in place - the exact mirror
// of writeApiKeyToEnv, for the CCC_DEVELOPER_EMAIL line. Everything else in the
// file is left byte-for-byte untouched, and the file stays at 0600.
//
// A BLANK value is allowed and meaningful: it writes an empty `CCC_DEVELOPER_EMAIL=`
// line, which the forwarder reads as "unset" and falls back to the coding-agent
// login's own email. Replace via a function (not a string) so a
// `$` in the value can't be read as a regex back-reference; append the line if it's
// somehow missing so the chosen value is never lost.
export function writeDeveloperEmailToEnv(
  value: string,
  path: string = ENV_PATH,
): void {
  setEnvLine(path, "CCC_DEVELOPER_EMAIL", value);
}

// SAVE the cache-write TTL answer into the .env in place - the exact mirror of
// writeDeveloperEmailToEnv, for the CCC_CACHE_WRITE_TTL line.
// Everything else in the file is left byte-for-byte untouched, mode stays 0600.
export function writeCacheWriteTtlToEnv(
  value: CacheWriteTtl,
  path: string = ENV_PATH,
): void {
  setEnvLine(path, "CCC_CACHE_WRITE_TTL", value);
}

// Set one KEY=value line in the settings file, leaving every other byte alone and
// the file at 0600. Replace via a function (not a string) so a "$" in the value
// can't be read as a regex back-reference; append the line if the file lacks it,
// so the chosen value is never lost.
function setEnvLines(path: string, entries: Record<string, string>): void {
  let next = existsSync(path) ? readFileSync(path, "utf8") : renderEnvFile();
  for (const [key, value] of Object.entries(entries)) {
    const line = new RegExp(`^${key}=.*$`, "m");
    next = line.test(next)
      ? next.replace(line, () => `${key}=${value}`)
      : `${next}${next.endsWith("\n") || next === "" ? "" : "\n"}${key}=${value}\n`;
  }
  writeSecretFile(path, next);
}

function setEnvLine(path: string, key: string, value: string): void {
  setEnvLines(path, { [key]: value });
}

// SAVE this machine's work-item label. `work <name>` writes
// CCC_WORK_ID only: it outranks CCC_MATTER_ID, so a user with a CCC_MATTER_ID line
// gets the label they just typed without that line being rewritten.
export function writeWorkIdToEnv(value: string, path: string = ENV_PATH): void {
  setEnvLine(path, WORK_ID_ENV_KEY, value);
}

// CLEAR the label. Both keys, deliberately: blanking only CCC_WORK_ID would leave a
// CCC_MATTER_ID value still in effect, so `work --clear` would print
// success and change nothing they can see.
export function clearWorkIdsInEnv(path: string = ENV_PATH): void {
  // One write, not two: on Windows every write rebuilds the file's access list
  // through PowerShell, and a half-applied clear would leave CCC_MATTER_ID winning.
  setEnvLines(path, { [WORK_ID_ENV_KEY]: "", [MATTER_NUMBER_ENV_KEY]: "" });
}

// SAVE the names of the things this team finishes. A blank value is
// meaningful: it is how finished-work counting reads as off, which is what `status`
// prints and what `done --setup` writes when the answer is No.
export function writeFinishedWorkNamesToEnv(
  value: string,
  path: string = ENV_PATH,
): void {
  setEnvLine(path, FINISHED_WORK_NAMES_ENV_KEY, value);
}

export function writeServerUrlToEnv(
  value: string,
  path: string = ENV_PATH,
): void {
  setEnvLine(path, "MARGINFRONT_API_URL", value);
}

// ===========================================================================
// CLAUDE CODE settings.json TELEMETRY WIRING
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, in plain English: the `.env` above only works if the
// developer remembers to `source` it in the terminal before running Claude
// Code. The Claude Code CLI reads ~/.claude/settings.json on every run and
// honors an "env" block inside it, so adding our telemetry variables to THAT
// file turns telemetry on with no shell step. The Claude DESKTOP app reads no
// shell and does not apply this env block; it gets the same variables through
// setDesktopGuiEnv below. This is the user's own global config, though, so
// every operation here is paranoid: we never clobber a value the user set, we
// back the file up before we touch it, and we keep a private record of exactly
// what we added so uninstall can put things back the way they were.
//
// HARD RULE, repeated here because it matters: the MarginFront secret key
// (mf_sk_*) NEVER goes in this file. Only the telemetry vars below. The
// loop that writes them only ever considers CCC_OWNED_TELEMETRY_KEYS, so even
// if a caller accidentally hands us the API key it cannot land here.
// ===========================================================================

// WHERE CLAUDE CODE'S GLOBAL SETTINGS LIVE. The CLI reads this file on every run,
// whatever shell it was started from.
export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// --- CACHE-WRITE TTL DETECTION ---------------------------------
// Claude Code exposes two documented env vars that decide the prompt-cache
// write flavor outright: FORCE_PROMPT_CACHING_5M forces the 5-minute cache
// regardless of sign-in AND overrides ENABLE_PROMPT_CACHING_1H, which opts an
// API-key machine into the 1-hour cache. When either is set we know the
// answer and init never has to ask. Users set these in the shell OR in
// ~/.claude/settings.json's "env" block, so detection peeks at both.

// "Set" means explicitly truthy ("1"/"true"), the documented usage. Stricter
// on purpose: a false POSITIVE silently records the wrong rate and never asks
// the human; a false negative means one extra question at init.
function envFlagIsSet(value: unknown): boolean {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

// Read-only peek at the settings.json "env" block. These are the USER'S keys,
// not ours - never add them to CCC_OWNED_TELEMETRY_KEYS. Unreadable/
// malformed file => {} (and never echo the contents: settings may hold values
// that don't belong in a terminal or log).
function readClaudeSettingsEnvBlock(
  settingsPath: string,
): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    const envBlock = (parsed as { env?: unknown })?.env;
    return envBlock && typeof envBlock === "object"
      ? (envBlock as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// The detect half of init's detect-or-ask flow. Order matters: FORCE_5M wins
// over ENABLE_1H across BOTH sources (that's the vendor-documented override),
// so a machine with ENABLE_1H in the shell but FORCE_5M in settings.json is
// correctly a 5m machine. Null = ambiguous, ask the one question.
export function detectCacheWriteTtl(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = CLAUDE_SETTINGS_PATH,
): CacheWriteTtl | null {
  const settingsEnv = readClaudeSettingsEnvBlock(settingsPath);
  const isSet = (key: string): boolean =>
    envFlagIsSet(env[key]) || envFlagIsSet(settingsEnv[key]);
  if (isSet("FORCE_PROMPT_CACHING_5M")) return "5m";
  if (isSet("ENABLE_PROMPT_CACHING_1H")) return "1h";
  return null;
}

// OUR PRIVATE "receipt" of what we added to the settings file above. The
// reverter reads this so it knows EXACTLY which keys (and which values) are
// safe to remove - it never guesses. Lives under our own config dir, never in
// the user's ~/.claude tree.
export const CLAUDE_SETTINGS_OWNERSHIP_PATH = join(
  CONFIG_DIR,
  "claude-settings-owned.json",
);

// THE EXACT VALUES we write for those eight keys, in ONE place so the consent
// disclosure, the settings writer, and the .env template can't drift apart.
// These are the same values renderEnvFile() bakes into ~/.marginfront-ccc/.env;
// `init` hands this map to writeClaudeTelemetrySettings so the Claude Code CLI turns
// telemetry on with no shell `source`. (The Desktop app does NOT read this settings env
// block; it picks the same vars up from the launchd GUI session env instead - see
// setDesktopGuiEnv.) Keys here MUST be exactly CCC_OWNED_TELEMETRY_KEYS - a
// unit test asserts that so a future edit to one can't silently desync the other.
export const CCC_TELEMETRY_VALUES: Record<string, string> = {
  // Turns on Claude Code's usage broadcasting.
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  // Send token usage as OpenTelemetry metrics.
  OTEL_METRICS_EXPORTER: "otlp",
  // Send the per-tool-call EVENT stream too (needed for tool-call line items).
  OTEL_LOGS_EXPORTER: "otlp",
  // HTTP/protobuf: gRPC on 4317 drops data without an error.
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  // Point Claude Code at the local collector (must match the collector YAML).
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  // Flush token metrics every 5 minutes (batched ~one event per turn).
  OTEL_METRIC_EXPORT_INTERVAL: "300000",
  // Flush the EVENT stream on the same 5-minute beat: built-in tool
  // events ride this stream too, and matching the metrics interval keeps them batched, not a per-second drip.
  OTEL_LOGS_EXPORT_INTERVAL: "300000",
  // Attach the MCP server + tool name to each tool event so paid MCP
  // tools can be told apart from the free ones - without it every MCP call is the
  // indistinguishable bucket "mcp_tool". Names-only leaves the machine: the flag
  // also writes tool ARGUMENTS into the local telemetry file, but the forwarder
  // reads only the two names, never the arguments.
  OTEL_LOG_TOOL_DETAILS: "1",
};

// The on-disk shape of the ownership receipt. `ownedKeys` maps each key we
// wrote to the EXACT value we wrote - the reverter only removes a key if the
// live value still equals what we recorded here (so a value the user changed
// afterward is left alone).
interface ClaudeSettingsOwnership {
  ownedKeys: Record<string, string>;
}

// Result of a settings write: what we put in, what we left alone (because the
// user already had a different value), and where the safety backup landed
// (null when there was nothing to back up / nothing changed).
export interface WriteClaudeSettingsResult {
  written: string[];
  skipped: string[];
  backupPath: string | null;
  // Did this run actually edit the file? `written` lists the keys we OWN, which on an
  // idempotent re-run is the full list even though nothing changed - so a caller that
  // needs to say "already wired" instead of "wired it now" has to read this.
  // Optional so an injected test stub can leave it out.
  changed?: boolean;
}

// Result of a settings revert: what we removed, what we kept (because the user
// changed it or it was already gone), and the safety backup path.
export interface RemoveClaudeSettingsResult {
  removed: string[];
  kept: string[];
  backupPath: string | null;
}

// True only for a real `{...}` object - NOT null, NOT an array. JSON.parse can
// hand back null/arrays/strings/numbers, and an "env" that isn't a plain object
// would be unsafe to merge into, so we gate on this everywhere.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Copy the settings file to "<path>.ccc-bak" so there's always an untouched
// snapshot to fall back to before we modify the user's global config.
function backupClaudeSettings(settingsPath: string): string {
  const backupPath = `${settingsPath}.ccc-bak`;
  copyFileSync(settingsPath, backupPath);
  return backupPath;
}

// Read our private ownership receipt. Returns the recorded key->value map, or
// null if the receipt is missing or unreadable (a corrupt receipt is treated
// as "we don't know what we own" rather than throwing - the reverter degrades
// to a warning, never a crash on the user's machine).
function readClaudeSettingsOwnership(
  ownershipPath: string,
): Record<string, string> | null {
  if (!existsSync(ownershipPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownershipPath, "utf8"));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.ownedKeys)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.ownedKeys)) {
      out[key] = String(value);
    }
    return out;
  } catch {
    // Malformed receipt - don't trust it, don't throw. Caller warns.
    return null;
  }
}

// Persist the ownership receipt (creating its parent dir if needed). We write
// it with the same 2-space + trailing-newline style as everything else so a
// human can read it.
function writeClaudeSettingsOwnership(
  ownershipPath: string,
  ownedKeys: Record<string, string>,
): void {
  mkdirSync(dirname(ownershipPath), { recursive: true });
  const payload: ClaudeSettingsOwnership & { _comment: string } = {
    _comment:
      "MarginFront code-cost-clarity wrote these telemetry keys into your " +
      "Claude Code settings.json. Uninstall removes ONLY the keys below, and " +
      "only if their value still matches. Safe to delete by hand if you've " +
      "already cleaned up settings.json yourself.",
    ownedKeys,
  };
  writeFileSync(ownershipPath, JSON.stringify(payload, null, 2) + "\n");
}

// MERGE OUR TELEMETRY VARS into ~/.claude/settings.json - safely.
//
// `vars` maps telemetry key -> the value we want it to have. We only ever look
// at CCC_OWNED_TELEMETRY_KEYS, so nothing else in `vars` (a stray API
// key, say) can ever be written.
//
// The rules, in order:
//   - Missing file        -> start from an empty {} (we'll create it).
//   - Malformed JSON       -> back it up to .ccc-bak and THROW. We never
//                             overwrite a file we can't parse; corrupting
//                             the user's global config is the worst outcome.
//   - "env" exists but is
//     not a plain object   -> back up + THROW. Same reasoning: don't clobber.
//   - For each owned key:
//       * absent in env            -> add it, and record it as ours.
//       * already equals our value -> leave it; only claim ownership if WE
//                                     already owned it on a prior run (so an
//                                     identical value the USER set survives an
//                                     uninstall).
//       * set to a DIFFERENT value -> SKIP it (never overwrite the user) and
//                                     report it in `skipped`.
//   - The file is backed up before any write, and re-serialized with 2-space
//     indent + a trailing newline to match Claude Code's own format (so the
//     diff a curious developer sees stays minimal).
export function writeClaudeTelemetrySettings(
  vars: Record<string, string>,
  {
    settingsPath = CLAUDE_SETTINGS_PATH,
    ownershipPath = CLAUDE_SETTINGS_OWNERSHIP_PATH,
    log = console.log,
  }: { settingsPath?: string; ownershipPath?: string; log?: LogFn } = {},
): WriteClaudeSettingsResult {
  // 1) Load the current settings. Missing file is fine - we treat it as {}.
  let settings: Record<string, unknown> = {};
  const fileExists = existsSync(settingsPath);
  if (fileExists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      // Malformed JSON: keep a copy, then refuse. We do NOT write.
      const backupPath = backupClaudeSettings(settingsPath);
      throw new Error(
        `Could not update ${settingsPath}.\n` +
          "What happened: your Claude Code settings file isn't valid JSON, so " +
          "we stopped instead of risking your settings.\n" +
          `What we did: saved an untouched copy at ${backupPath}.\n` +
          "Fix: open the file and repair the JSON (a common cause is a trailing " +
          "comma or a missing quote), then run init again. We will not modify a " +
          "file we can't read.",
      );
    }
    if (!isPlainObject(parsed)) {
      // Valid JSON, but not an object at the top level (e.g. an array or a
      // bare value). We can't merge an "env" block into that safely.
      const backupPath = backupClaudeSettings(settingsPath);
      throw new Error(
        `Could not update ${settingsPath}.\n` +
          "What happened: the top level of your Claude Code settings file isn't " +
          "a JSON object (it looks like an array or a single value), so there's " +
          "nowhere safe to add the telemetry settings.\n" +
          `What we did: saved an untouched copy at ${backupPath}.\n` +
          'Fix: make the file a normal JSON object like { "env": { ... } }, then ' +
          "run init again.",
      );
    }
    settings = parsed;
  }

  // 2) Validate any existing "env". If it's present but not a plain object,
  //    refuse rather than clobber it.
  if ("env" in settings && !isPlainObject(settings.env)) {
    const backupPath = backupClaudeSettings(settingsPath);
    throw new Error(
      `Could not update ${settingsPath}.\n` +
        'What happened: your settings file has an "env" entry that isn\'t a ' +
        "block of key/value settings (it's null, a list, or a single value), " +
        "so we stopped instead of overwriting it.\n" +
        `What we did: saved an untouched copy at ${backupPath}.\n` +
        'Fix: change "env" to a normal object like { "KEY": "value" } (or remove ' +
        "it), then run init again.",
    );
  }

  // 3) Merge. Work on the existing env if there is one, otherwise a fresh {}
  //    we only attach if we actually add something.
  const hadEnv = isPlainObject(settings.env);
  const env: Record<string, unknown> = hadEnv
    ? (settings.env as Record<string, unknown>)
    : {};

  // What we owned BEFORE this run, so an identical value WE set on a prior run
  // stays ours (idempotent re-install) while an identical value the USER set
  // does not (it must survive uninstall).
  const priorOwned = readClaudeSettingsOwnership(ownershipPath) ?? {};

  const ownedKeys: Record<string, string> = {};
  const written: string[] = [];
  const skipped: string[] = [];
  let mutated = false;

  for (const key of CCC_OWNED_TELEMETRY_KEYS) {
    // Only manage keys the caller actually asked us to set. (And only these
    // ever - the API key can never reach this loop.)
    if (!(key in vars)) continue;
    const canonical = String(vars[key]);
    const current = env[key];

    if (current === undefined) {
      // Not there yet - add it and claim ownership.
      env[key] = canonical;
      ownedKeys[key] = canonical;
      written.push(key);
      mutated = true;
    } else if (current === canonical) {
      // Already the value we want. Only keep ownership if it was already ours;
      // otherwise it's the user's own setting and we must not touch it later.
      if (priorOwned[key] === canonical) {
        ownedKeys[key] = canonical;
        written.push(key);
      } else {
        skipped.push(key);
      }
    } else {
      // The user set a different value. Never overwrite it.
      skipped.push(key);
    }
  }

  // 4) Write the settings file ONLY if we actually changed it. Leaving an
  //    unchanged file completely untouched keeps re-runs truly no-op (and
  //    avoids reformatting a file we didn't need to edit).
  let backupPath: string | null = null;
  if (mutated) {
    if (!hadEnv) settings.env = env;
    if (fileExists) backupPath = backupClaudeSettings(settingsPath);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    log(
      `Wrote ${written.length} telemetry setting(s) into ${settingsPath}` +
        (backupPath ? ` (backup at ${backupPath}).` : "."),
    );
  } else {
    log(`No changes needed in ${settingsPath} - telemetry already in place.`);
  }

  // 5) Record the receipt of what we own. Always written so the reverter has
  //    an accurate, current picture (even across idempotent re-installs).
  writeClaudeSettingsOwnership(ownershipPath, ownedKeys);

  if (skipped.length) {
    log(
      `Left ${skipped.length} setting(s) you already had in place untouched: ` +
        skipped.join(", "),
    );
  }

  return { written, skipped, backupPath, changed: mutated };
}

// READ-ONLY companion to the writer above: is Claude Code telemetry pointed at our
// local collector right now? `status` needs the answer and must never write, so this
// shares no code path with the writer. Unreadable / malformed / missing file all mean
// "not wired" - status reports, it never repairs.
export function claudeTelemetryIsWired({
  settingsPath = CLAUDE_SETTINGS_PATH,
  values = CCC_TELEMETRY_VALUES,
}: { settingsPath?: string; values?: Record<string, string> } = {}): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.env)) return false;
    const env = parsed.env as Record<string, unknown>;
    return (
      env["CLAUDE_CODE_ENABLE_TELEMETRY"] ===
        values["CLAUDE_CODE_ENABLE_TELEMETRY"] &&
      env["OTEL_EXPORTER_OTLP_ENDPOINT"] ===
        values["OTEL_EXPORTER_OTLP_ENDPOINT"]
    );
  } catch {
    return false;
  }
}

// REVERSE THE WRITE ABOVE - surgically. Reads the ownership receipt and, for
// each key WE recorded, deletes it from env ONLY IF the live value still equals
// the value we wrote. That means:
//   - a key the user changed after we wrote it      -> kept (we don't clobber).
//   - a key the user set themselves (never ours)    -> kept (never in receipt).
//   - a key we wrote and the user left alone         -> removed cleanly.
// If we empty the env block entirely, we remove the empty "env" too. Everything
// else in the file is left byte-identical. A missing or malformed receipt /
// settings file is a WARNING, never a throw - uninstall must not crash.
export function removeClaudeTelemetrySettings({
  settingsPath = CLAUDE_SETTINGS_PATH,
  ownershipPath = CLAUDE_SETTINGS_OWNERSHIP_PATH,
  log = console.log,
}: {
  settingsPath?: string;
  ownershipPath?: string;
  log?: LogFn;
} = {}): RemoveClaudeSettingsResult {
  const removed: string[] = [];
  const kept: string[] = [];

  // No receipt -> we never wrote anything (or it's already cleaned). Warn softly.
  const owned = readClaudeSettingsOwnership(ownershipPath);
  if (owned === null) {
    log(
      `Nothing to undo: no MarginFront ownership record found at ${ownershipPath} ` +
        "(either it was never written, or it's already been removed).",
    );
    return { removed, kept, backupPath: null };
  }

  // No settings file -> nothing to clean. Drop our now-stale receipt and warn.
  if (!existsSync(settingsPath)) {
    log(
      `Nothing to undo: ${settingsPath} doesn't exist. Removing the stale ownership record.`,
    );
    rmSync(ownershipPath, { force: true });
    return { removed, kept, backupPath: null };
  }

  // Parse the settings file. If it's unreadable, warn and leave it ALONE - we
  // won't risk editing a file we can't parse, and we won't throw on uninstall.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    log(
      `Couldn't undo cleanly: ${settingsPath} isn't valid JSON right now, so ` +
        "we left it untouched. Fix the JSON and re-run uninstall, or remove the " +
        "telemetry keys by hand.",
    );
    return { removed, kept, backupPath: null };
  }
  if (!isPlainObject(parsed)) {
    log(
      `Couldn't undo cleanly: ${settingsPath} isn't a JSON object, so we left ` +
        "it untouched.",
    );
    return { removed, kept, backupPath: null };
  }
  const settings = parsed;

  const env = isPlainObject(settings.env)
    ? (settings.env as Record<string, unknown>)
    : null;

  let mutated = false;
  for (const [key, canonical] of Object.entries(owned)) {
    if (env && env[key] === canonical) {
      // Still exactly what we wrote -> safe to remove.
      delete env[key];
      removed.push(key);
      mutated = true;
    } else {
      // Gone already, or the user changed it -> leave it be.
      kept.push(key);
    }
  }

  // If we emptied the env block, remove the now-empty "env" key too so we don't
  // leave an orphan `{}` behind.
  if (env && Object.keys(env).length === 0) {
    delete settings.env;
    mutated = true;
  }

  // Only rewrite (and back up) if we actually removed something - an untouched
  // file stays byte-identical.
  let backupPath: string | null = null;
  if (mutated && Object.keys(settings).length === 0) {
    deleteEmptiedClaudeSettings(settingsPath);
    log(
      `Removed ${removed.length} MarginFront telemetry setting(s) from ` +
        `${settingsPath}. Nothing else was in that file, so I deleted it.`,
    );
  } else if (mutated) {
    backupPath = backupClaudeSettings(settingsPath);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    log(
      `Removed ${removed.length} MarginFront telemetry setting(s) from ` +
        `${settingsPath} (backup at ${backupPath}).`,
    );
  } else {
    log(
      `Nothing to remove from ${settingsPath} - the telemetry keys were already ` +
        "gone or you'd changed them (left untouched).",
    );
  }

  // We're done with our receipt either way - uninstall means forgetting what
  // we owned.
  rmSync(ownershipPath, { force: true });

  return { removed, kept, backupPath };
}

export type ForwarderStopSignal = "SIGTERM" | "SIGKILL";

// Injected so a test can drive the real dispatch decision for either platform without
// a real process or a real config dir.
export interface StopSignalOptions {
  platform?: string;
  shutdownRequestPath?: string;
  kill?: (pid: number, signal: ForwarderStopSignal) => void;
}

// The two-rung stop ladder, per platform. POSIX sends both signals as named. Windows
// turns "SIGTERM" into a write to the mailbox above; "SIGKILL" stays a real
// TerminateProcess, which is what that rung is for. Never throws - a pid that died
// between the liveness check and here is the expected case, not an error.
export function signalForwarderStop(
  pid: number,
  signal: ForwarderStopSignal,
  options: StopSignalOptions = {},
): void {
  const platformName = options.platform ?? platform();
  const kill =
    options.kill ??
    ((targetPid: number, targetSignal: ForwarderStopSignal) => {
      process.kill(targetPid, targetSignal);
    });

  if (platformName === "win32" && signal === "SIGTERM") {
    const requestPath = options.shutdownRequestPath ?? SHUTDOWN_REQUEST_PATH;
    try {
      mkdirSync(dirname(requestPath), { recursive: true });
      // The pid is written for the reader's benefit only: a forwarder that finds a
      // request naming a DIFFERENT pid knows it is a leftover from an older run and
      // ignores it, so a stale mailbox can never shut down a fresh meter.
      writeFileSync(requestPath, String(pid));
    } catch {
      // Unwritable config dir: the caller's escalation rung still takes it down.
    }
    return;
  }

  try {
    kill(pid, signal);
  } catch {
    // The process died between checks - already gone, nothing to do.
  }
}

// Obeys only a request addressed to THIS pid, and sweeps anything else: without that,
// a mailbox left by a forced `stop` would shut down every future meter seconds after
// sign-in.
export function readShutdownRequest(
  selfPid: number,
  requestPath: string = SHUTDOWN_REQUEST_PATH,
): boolean {
  if (!existsSync(requestPath)) return false;
  let addressedPid: number | null = null;
  try {
    const parsed = parseInt(readFileSync(requestPath, "utf8").trim(), 10);
    addressedPid = Number.isInteger(parsed) ? parsed : null;
  } catch {
    addressedPid = null;
  }
  if (addressedPid === selfPid) return true;
  clearShutdownRequest(requestPath);
  return false;
}

// Swept by the forwarder at startup as well as shutdown: a request left by a previous
// run must not stop the new one.
export function clearShutdownRequest(
  requestPath: string = SHUTDOWN_REQUEST_PATH,
): void {
  try {
    rmSync(requestPath, { force: true });
  } catch {
    /* best effort - a leftover file is swept by the pid check above */
  }
}

// COLLECTOR PROCESS BOOKKEEPING - start / check / stop via a tiny pidfile.

// Is this pid alive? signal 0 doesn't kill - it just probes whether the pid exists.
export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means it exists but we can't signal it (still "alive" for us).
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function readCollectorPid(): number | null {
  if (!existsSync(COLLECTOR_PID_PATH)) return null;
  try {
    const pid = parseInt(readFileSync(COLLECTOR_PID_PATH, "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Start the collector detached so it catches usage independently of the forwarder.
// Returns the pid; if one's already running, returns it without starting a second.
export function startCollector({ log = console.log }: { log?: LogFn } = {}): {
  pid: number | null | undefined;
  startedByUs: boolean;
} {
  const existing = readCollectorPid();
  if (isPidAlive(existing)) {
    log(`Collector already running (pid ${existing}).`);
    return { pid: existing, startedByUs: false };
  }

  if (!existsSync(COLLECTOR_BIN_PATH)) {
    throw new Error(
      `Collector binary is missing. From the root of your MarginFront source checkout, run \`${CCC_SOURCE_INIT_COMMAND}\` first.`,
    );
  }

  const logFd = openSync(COLLECTOR_LOG_PATH, "a");
  const child = spawn(COLLECTOR_BIN_PATH, ["--config", COLLECTOR_CONFIG_PATH], {
    cwd: CONFIG_DIR,
    // Own process group, so a Ctrl-C aimed at the forwarder's terminal doesn't take
    // the collector with it. libuv spells this DETACHED_PROCESS |
    // CREATE_NEW_PROCESS_GROUP on Windows, which keeps the same promise.
    detached: true,
    // Without it a detached child with no console of its own flashes up a console
    // window - at every sign-in, which reads as malware.
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  writeFileSync(COLLECTOR_PID_PATH, String(child.pid));
  log(`Started collector (pid ${child.pid}); logs at ${COLLECTOR_LOG_PATH}.`);
  return { pid: child.pid, startedByUs: true };
}

// How long to give the collector to close itself before we take it down, and how often
// to look. It exits promptly once asked, so this deadline only matters if it is wedged.
export const COLLECTOR_STOP_POLL_MS = 100;
export const COLLECTOR_STOP_TIMEOUT_MS = 3_000;

export type CollectorStopRung = "polite" | "forced";

// Injected so both platforms' ladders are driven in a test with no real collector.
export interface CollectorStopOptions {
  platform?: string;
  // win32 only: run `taskkill <args>`. Status 0 means Windows accepted the request.
  runTaskkill?: (args: string[]) => { status: number | null };
  kill?: (pid: number, signal: ForwarderStopSignal) => void;
  isAlive?: (pid: number) => boolean;
  // Blocking on purpose: cmdRun's shutdown handler is synchronous and exits the
  // process on the next line, so an awaited sleep would never resume.
  sleep?: (ms: number) => void;
  pollMs?: number;
  timeoutMs?: number;
}

// THE COLLECTOR'S STOP LADDER, and its honest limit. The collector is a third-party
// binary that will never poll our shutdown mailbox, so its polite rung has to be the
// one Windows provides: `taskkill` WITHOUT /F asks a process to close, `/F` is
// TerminateProcess - a distinction process.kill cannot express on Windows, where it
// maps to TerminateProcess whatever signal you name.
//
// WHAT WINDOWS ACTUALLY ANSWERS, measured on the Windows lane rather than assumed:
// taskkill REFUSES the polite rung for the collector as we spawn it - detached and
// windowsHide, so it has no console and no window to close - and exits 1. This
// escalates every time, so it does NOT make a Windows stop graceful. It makes the
// attempt, reports which rung actually took the collector down, and works once the
// collector has a console. A persistent queue in the collector would make the kill
// survivable; this code does not provide one.
// The live test in graceful-shutdown.test.ts is what holds this paragraph to the truth.
//
// POSIX needs no ladder: SIGTERM already IS the polite rung there.
export function stopCollectorProcess(
  pid: number,
  options: CollectorStopOptions = {},
): CollectorStopRung[] {
  const platformName = options.platform ?? platform();
  const kill =
    options.kill ??
    ((targetPid: number, signal: ForwarderStopSignal) => {
      process.kill(targetPid, signal);
    });

  if (platformName !== "win32") {
    try {
      kill(pid, "SIGTERM");
    } catch {
      // Died between the liveness check and here - the expected race, not an error.
    }
    return ["polite"];
  }

  const runTaskkill =
    options.runTaskkill ??
    ((args: string[]) => spawnSync("taskkill", args, { windowsHide: true }));
  const isAlive =
    options.isAlive ?? ((targetPid: number) => isPidAlive(targetPid));
  const sleep = options.sleep ?? blockingSleep;
  const pollMs = options.pollMs ?? COLLECTOR_STOP_POLL_MS;
  const timeoutMs = options.timeoutMs ?? COLLECTOR_STOP_TIMEOUT_MS;

  const rungs: CollectorStopRung[] = [];
  // A null status means taskkill.exe never ran at all; there is nothing to wait for.
  const asked = runTaskkill(["/PID", String(pid)]).status === 0;
  if (asked) {
    rungs.push("polite");
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid) && Date.now() < deadline) sleep(pollMs);
    if (!isAlive(pid)) return rungs;
  }

  rungs.push("forced");
  try {
    kill(pid, "SIGKILL");
  } catch {
    // Already gone, or unsignalable. The pidfile is removed by the caller either way.
  }
  return rungs;
}

// Stop the collector if it's running. Safe to call when nothing is running.
export function stopCollector({
  log = console.log,
  ...stopOptions
}: { log?: LogFn } & CollectorStopOptions = {}): boolean {
  const pid = readCollectorPid();
  if (!isPidAlive(pid)) {
    if (existsSync(COLLECTOR_PID_PATH))
      rmSync(COLLECTOR_PID_PATH, { force: true });
    log("No running collector found.");
    return false;
  }
  // pid is non-null here: isPidAlive(pid) above is only true for a real integer.
  // The rung is deliberately NOT in this line: on Windows it is always "forced" for the
  // collector as we spawn it, so reporting it would put a scary sentence in front of the user on every single
  // stop, about something they cannot act on. It stays in the return value, where the
  // tests read it.
  stopCollectorProcess(pid!, stopOptions);
  log(`Stopped collector (pid ${pid}).`);
  rmSync(COLLECTOR_PID_PATH, { force: true });
  return true;
}

// ===========================================================================
// LAUNCHD BACKGROUND DAEMON
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, in plain English: without it you have to keep a terminal window
// open running `run` for your spend to be captured. Close the laptop lid, log
// out, or reboot and the meter quietly stops - and you won't know until your
// numbers look wrong. This wires the forwarder into macOS's own background-job
// manager (launchd) so it starts itself at login, restarts itself if it ever
// crashes, and needs no second terminal. `start` turns it on; `status` tells you
// if it's alive; `stop` pauses it; `uninstall` removes it.
//
// HARD RULE we bake in below: the background job must point at a REAL, stable copy
// of our program - process.execPath (the actual node binary) running a cli.js we
// copied into ~/.marginfront-ccc. We must NEVER write "npx" into the launchd job:
// npx re-downloads into a throwaway cache that npm later cleans up, so a daemon
// told to run "npx ..." would one day find its program gone and crash-loop forever.
// ===========================================================================

// The launchd job's name ("label"). Reverse-DNS by convention; this is the single
// id launchctl uses to find, load, and unload our background job.
export const PLIST_LABEL = "ai.marginfront.ccc";

// Where macOS expects a per-user LaunchAgent definition to live. Dropping our
// .plist here (named after the label) is what makes login auto-start work.
export const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  PLIST_LABEL + ".plist",
);

// The STABLE copy of our CLI the daemon actually runs. `start` copies the package's
// built dist/cli.js here so the background job never depends on the npx cache
// (which npm cleans up out from under it). Lives in our own config dir.
export const DAEMON_CLI_PATH = join(CONFIG_DIR, "cli.js");

// Where the background forwarder's normal output and errors are written. launchd
// redirects the job's stdout/stderr to these files; `status` tails them so a stuck
// user can read the last few lines and self-diagnose without hunting for files.
export const DAEMON_STDOUT_LOG_PATH = join(CONFIG_DIR, "forwarder.out.log");
export const DAEMON_STDERR_LOG_PATH = join(CONFIG_DIR, "forwarder.err.log");

// THE WINDOWS HALF OF THOSE TWO FILES. launchd redirects the macOS job's stdout and
// stderr into them; Task Scheduler has no equivalent, and the Windows task's node runs
// behind a headless console host, so everything the meter prints there goes nowhere and
// `status` tails two files that never get written. The task's action passes this flag
// and `run` does the redirect itself.
export const LOG_TO_FILES_FLAG = "--log-to-files";

// THE LAST THING A DYING METER SAYS. Node prints an uncaught stack itself, straight to
// the real stderr, which behind the headless console host is nowhere at all - so the
// crash goes through the replaced console.error instead, into the error log `status`
// tails. Exported only so the unit tests can take it back off `process`: a handler left
// installed would exit the whole run on the next stray rejection.
export function crashToConsoleError(error: unknown): void {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
}

// No rotation here on purpose: `run` rotates both files at startup, which is all the
// launchd path gets too.
export function routeConsoleOutputToFiles(
  outPath: string = DAEMON_STDOUT_LOG_PATH,
  errPath: string = DAEMON_STDERR_LOG_PATH,
): void {
  const appendTo =
    (path: string) =>
    (...args: unknown[]): void => {
      try {
        appendFileSync(path, format(...args) + "\n");
      } catch {
        // A meter that cannot write its own log still meters, and the job this runs as
        // has no console to complain to.
      }
    };
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    mkdirSync(dirname(errPath), { recursive: true });
  } catch {
    // Same: the appends above fail the same way and stay as silent.
  }
  console.log = appendTo(outPath);
  console.error = appendTo(errPath);
  // Same handler on both, and only ever one of each: `run` calls this once, but the
  // unit tests call it per test.
  if (!process.listeners("uncaughtException").includes(crashToConsoleError)) {
    process.on("uncaughtException", crashToConsoleError);
    process.on("unhandledRejection", crashToConsoleError);
  }
}

// Result of one launchctl invocation, normalized so callers (and tests) read the
// same shape no matter how it ran.
export interface LaunchctlResult {
  status: number;
  stdout: string;
  stderr: string;
}

// A function that runs `launchctl <args...>` and reports the result. Injected
// everywhere below so the install/uninstall/status logic can be unit-tested
// WITHOUT touching the real launchd - a fake runner just records the calls.
export type LaunchctlRunner = (args: string[]) => LaunchctlResult;

// The production runner: actually shell out to launchctl. spawnSync (not exec) so
// args pass as a list - no shell, no quoting pitfalls with spaces in a home path.
export function defaultLaunchctlRunner(args: string[]): LaunchctlResult {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    // A spawn error (e.g. launchctl missing on a non-mac) leaves status null; we
    // treat that as a failure so callers don't read it as "succeeded."
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// DESKTOP COVERAGE via the launchd GUI-session environment.
// The Claude *desktop* app runs its own bundled Claude Code, and unlike the CLI it does
// NOT apply the `env` block from ~/.claude/settings.json - and a Dock-launched GUI app
// never inherits your shell either. The one environment it DOES inherit is the launchd
// GUI session env, set with `launchctl setenv`. So we put the same eight telemetry vars
// there too. With these set (and the desktop app relaunched so it reads
// them at startup), the desktop's bundled Claude Code ships usage to the local collector.
// The daemon calls this on startup, so it re-applies at every login; `uninstall` clears it.
export function setDesktopGuiEnv(
  runLaunchctl: LaunchctlRunner = defaultLaunchctlRunner,
): void {
  for (const key of CCC_OWNED_TELEMETRY_KEYS) {
    runLaunchctl(["setenv", key, CCC_TELEMETRY_VALUES[key]]);
  }
}

// Clear those eight vars from the GUI-session env (the uninstall counterpart). Idempotent:
// `launchctl unsetenv` on a key that isn't set is a harmless no-op.
export function unsetDesktopGuiEnv(
  runLaunchctl: LaunchctlRunner = defaultLaunchctlRunner,
): void {
  for (const key of CCC_OWNED_TELEMETRY_KEYS) {
    runLaunchctl(["unsetenv", key]);
  }
}

// The current user's numeric id, used to build launchd's "gui/<uid>" domain
// target. process.getuid exists on macOS/Linux; the ?? 0 is an unreachable
// fallback that keeps TypeScript happy on platforms that lack it.
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

// Escape the five XML-significant characters so a path with a stray & or < can't
// produce a malformed plist. Paths under $HOME rarely contain these, but a plist
// macOS silently refuses to parse is a miserable thing to debug - so we're careful.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// BUILD THE LAUNCHD JOB DEFINITION (the .plist) - the XML macOS reads to know what
// to run in the background and how to babysit it.
//   - ProgramArguments: [the real node binary, our stable cli.js, "run"]. nodePath
//     MUST be a real path (process.execPath at install time), NEVER "npx" - see the
//     section header for why npx here is a crash-loop trap. installDaemon enforces it.
//   - RunAtLoad=true: start it as soon as it's loaded AND at every login.
//   - KeepAlive=true: if it ever exits, bring it back (that's the whole point - the
//     meter must not silently stay dead). The crash-loop guard for a MISSING KEY
//     lives in `start` (it refuses to install without a key), so KeepAlive can't
//     spin on a config error it could never fix on its own.
//   - StandardOutPath/StandardErrorPath: capture output to files `status` can tail.
export function renderDaemonPlist({
  nodePath,
  cliPath,
}: {
  nodePath: string;
  cliPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliPath)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(CONFIG_DIR)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(DAEMON_STDOUT_LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(DAEMON_STDERR_LOG_PATH)}</string>
</dict>
</plist>
`;
}

// Options shared by every launchd lifecycle call. Everything is injectable so the
// logic is unit-testable against temp paths + a fake runner, never the real machine.
export interface DaemonLifecycleOptions {
  runLaunchctl?: LaunchctlRunner;
  log?: LogFn;
  // Test overrides; production uses the real exported constants above.
  plistPath?: string;
  daemonCliPath?: string;
  uid?: number;
}

// Extra knobs only `install` needs.
export interface InstallDaemonOptions extends DaemonLifecycleOptions {
  // The real node binary to bake into the plist. Defaults to process.execPath (the
  // node currently running this command). A caller must never pass "npx" - refused below.
  nodePath?: string;
  // Where to copy the built cli.js FROM. Defaults to this bundle's own path, which
  // in the published package IS dist/cli.js (cli.ts + connector.ts bundle to one
  // file). Tests pass a throwaway temp file.
  sourceCliPath?: string;
  // How install waits between launchctl polls. Production uses a blocking sleep so
  // installDaemon can stay synchronous (cmdStart calls it without await); tests pass
  // a no-op so the bootstrap-reliability logic runs WITHOUT really waiting.
  sleep?: (ms: number) => void;
}

// How patiently install waits for an already-loaded job to finish booting out before
// it bootstraps the replacement. bootout is ASYNCHRONOUS - launchctl returns before
// the old job is fully torn down - and bootstrapping too early fails with
// "Bootstrap failed: 5: Input/output error" (errno 5). So we poll `print` until the
// job is gone (nonzero status), up to this many short attempts. In practice the job
// is gone on the first poll; the bound just stops us waiting forever on a wedged job.
const INSTALL_BOOTOUT_WAIT_ATTEMPTS = 20;
const INSTALL_BOOTOUT_WAIT_MS = 100;
// If bootstrap still fails (most often the errno-5 race above lost), wait this long
// and retry it exactly once before giving up with a real error.
const INSTALL_BOOTSTRAP_RETRY_MS = 250;

// A BLOCKING sleep for install's synchronous poll loop. Install runs as a one-shot
// CLI command, so briefly parking the thread between launchctl polls is fine - and it
// lets installDaemon stay synchronous (cmdStart calls install() without await).
// Atomics.wait parks for `ms` without spinning the CPU. A zero/negative wait is a
// no-op. Exported so the same primitive can be reused and so tests can reference it.
export function blockingSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface InstallDaemonResult {
  reloaded: boolean;
  plistPath: string;
  daemonCliPath: string;
}

// Stage the built cli.js to its stable home behind a syntax gate, so a file node
// cannot parse NEVER replaces a working daemon program (raw TypeScript staged here
// would crash-loop the daemon). Shared by every backend because the trap is the file, not the
// service manager.
export function stageDaemonCli({
  sourceCliPath,
  daemonCliPath,
  nodePath,
  log,
}: {
  sourceCliPath: string;
  daemonCliPath: string;
  nodePath: string;
  log: LogFn;
}): void {
  mkdirSync(dirname(daemonCliPath), { recursive: true });
  const stagedCliPath = `${daemonCliPath}.next.js`;
  copyFileSync(sourceCliPath, stagedCliPath);
  // Validate the way node itself will judge the file at daemon runtime. NOT
  // `node --check <file>`: for input node detects as ESM, --check exits 0
  // WITHOUT checking (probed on node 25: a TS-source cli.js passes it).
  // So: try the CommonJS grammar in-process (the published bundle is CJS), and
  // only if that fails, ask node to really check it as an ES module via stdin
  // (--input-type=module --check, which does validate).
  const stagedSource = readFileSync(stagedCliPath, "utf8");
  let syntaxError: string | null = null;
  try {
    new Script(stagedSource, { filename: stagedCliPath });
  } catch {
    const esmCheck = spawnSync(nodePath, ["--input-type=module", "--check"], {
      input: stagedSource,
      encoding: "utf8",
    });
    if (esmCheck.status !== 0) {
      syntaxError =
        esmCheck.stderr
          ?.trim()
          .split("\n")
          .find((line) => line.includes("Error")) ?? "syntax check failed";
    }
  }
  if (syntaxError !== null) {
    try {
      rmSync(stagedCliPath);
    } catch {
      // the staged file is inert either way; never mask the real error below
    }
    throw new Error(
      [
        "Refusing to install a meter program node cannot run.",
        `What happened: the file to install (${sourceCliPath}) failed node's own`,
        "  syntax check, so installing it would crash-loop the background job.",
        "Why: this usually means a source-mode (TypeScript) build was copied where",
        "  the compiled program belongs - e.g. running from a source checkout.",
        "Fix: build the package first, then run the built program. From the root of",
        "  your MarginFront source checkout:",
        "    npx turbo run build --filter=@marginfront/code-cost-clarity",
        `    ${CCC_SOURCE_INIT_COMMAND}`,
        `node said: ${syntaxError}`,
      ].join("\n"),
    );
  }
  renameSync(stagedCliPath, daemonCliPath);
  log(
    `Copied the meter program to ${daemonCliPath} (a stable copy, so the source checkout can move or be rebuilt).`,
  );
}

// npx runs from a cache npm later cleans up, so a background job pointed at it
// eventually points at nothing and crash-loops forever.
export function assertNotNpx(nodePath: string): void {
  if (nodePath === "npx" || /(^|[\\/])npx(\.\w+)?$/.test(nodePath)) {
    throw new Error(
      "Refusing to install the background daemon with 'npx' as its program.\n" +
        "What happened: the daemon must be pinned to the real node binary " +
        "(process.execPath), because npx runs from a temporary cache that gets " +
        "cleaned up - a daemon pointed at npx would crash-loop once that cache is gone.\n" +
        "Fix: this is an internal error; the daemon should always be installed with " +
        "process.execPath. Re-run `start` with node and the built cli.js.",
    );
  }
}

// INSTALL + START THE BACKGROUND DAEMON.
//   1) Copy the built cli.js to a stable path (survives npx cache cleanup).
//   2) Write the launchd .plist.
//   3) Load it with `launchctl bootstrap gui/<uid> <plist>` (the modern API).
// IDEMPOTENT: if a job with our label is already loaded, bootout (unload) FIRST,
// then bootstrap again - a clean reload that picks up the freshly-written plist.
export function installDaemon(
  options: InstallDaemonOptions = {},
): InstallDaemonResult {
  const runLaunchctl = options.runLaunchctl ?? defaultLaunchctlRunner;
  const log = options.log ?? console.log;
  const nodePath = options.nodePath ?? process.execPath;
  const sourceCliPath = options.sourceCliPath ?? fileURLToPath(import.meta.url);
  const daemonCliPath = options.daemonCliPath ?? DAEMON_CLI_PATH;
  const plistPath = options.plistPath ?? PLIST_PATH;
  const uid = options.uid ?? currentUid();
  const sleep = options.sleep ?? blockingSleep;

  assertNotNpx(nodePath);

  // 1) Copy the built cli.js to its stable home, behind the syntax gate.
  stageDaemonCli({ sourceCliPath, daemonCliPath, nodePath, log });

  // 2) Write the launchd job definition.
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(
    plistPath,
    renderDaemonPlist({ nodePath, cliPath: daemonCliPath }),
  );
  log(`Wrote the background-job definition to ${plistPath}.`);

  // 3) Load it. `print` returning 0 means a job with our label is already loaded,
  //    so we bootout then bootstrap (reload). bootout/bootstrap are the modern
  //    launchctl verbs (load/unload are the deprecated ones).
  //    Domain is gui/<uid> (the GUI login session), not the per-user domain:
  //    `bootstrap` into the per-user domain fails with errno 5 (I/O error) from
  //    some session contexts, while gui/<uid> loads cleanly. This is the right
  //    domain anyway for a meter that runs while the developer is logged in and coding.
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `gui/${uid}/${PLIST_LABEL}`;

  const alreadyLoaded = runLaunchctl(["print", serviceTarget]).status === 0;
  let reloaded = false;
  if (alreadyLoaded) {
    log(
      "A background meter is already loaded - reloading it with the new settings.",
    );
    runLaunchctl(["bootout", serviceTarget]);
    reloaded = true;

    // WAIT FOR THE OLD JOB TO ACTUALLY BE GONE. bootout returns immediately but the
    // teardown is asynchronous - if we bootstrap while the old job is still dying,
    // launchd rejects it with "Bootstrap failed: 5: Input/output error" (errno 5).
    // Poll `print` until it reports the job is gone (nonzero status), then proceed.
    for (let attempt = 0; attempt < INSTALL_BOOTOUT_WAIT_ATTEMPTS; attempt++) {
      if (runLaunchctl(["print", serviceTarget]).status !== 0) break;
      sleep(INSTALL_BOOTOUT_WAIT_MS);
    }
  }

  // CLEAR ANY DISABLED/WEDGED STATE before loading. A service left "disabled" by a
  // prior failed teardown makes bootstrap silently refuse. `enable` is idempotent -
  // a harmless no-op when the label was never disabled - so we always run it first.
  runLaunchctl(["enable", serviceTarget]);

  let bootstrap = runLaunchctl(["bootstrap", domainTarget, plistPath]);
  if (bootstrap.status !== 0) {
    // RETRY ONCE. The usual cause of a first-try failure is the errno-5 race above
    // (the old job not fully gone yet). Wait a beat and try a single more time before
    // surfacing a real error - this is what turns a flaky install into a reliable one.
    sleep(INSTALL_BOOTSTRAP_RETRY_MS);
    bootstrap = runLaunchctl(["bootstrap", domainTarget, plistPath]);
  }
  if (bootstrap.status !== 0) {
    throw new Error(
      "Could not start the background meter (launchctl bootstrap failed).\n" +
        `What happened: macOS refused to load the job at ${plistPath}.\n` +
        (bootstrap.stderr
          ? `launchctl said: ${bootstrap.stderr.trim()}\n`
          : "") +
        `Running CCC version: ${CCC_PACKAGE_VERSION}.\n` +
        "Fix: run `node ~/.marginfront-ccc/cli.js status` to see the " +
        "current state, or `stop` then `start` again. If it keeps failing, confirm " +
        `you're on macOS and that ${plistPath} looks like valid XML.`,
    );
  }

  log("The background meter is loaded and will start at login from now on.");
  return { reloaded, plistPath, daemonCliPath };
}

// A function that lists every launchd label currently known for a user, so uninstall
// can find and sweep orphan jobs (e.g. a leftover ai.marginfront.ccc.example) - not
// just our one main label. Injected so it's testable without a real launchctl.
export type LaunchdLabelLister = (
  runLaunchctl: LaunchctlRunner,
  uid: number,
) => string[];

// Matches our main label AND any namespaced child (ai.marginfront.ccc, .example,
// etc.) - but NOT an unrelated label that merely starts with the same letters.
const CCC_LABEL_PATTERN = /^ai\.marginfront\.ccc(\.|$)/;

// The production label lister. Unions two launchctl sources so an orphan can't hide:
//   - `launchctl list`                 : loaded jobs, one per line as "PID  Status  Label"
//   - `launchctl print-disabled gui/N` : labels disabled in the gui domain, as `"label" => true`
// Returns the FULL label strings; uninstallDaemon filters them to ours. A nonzero
// status from either source is treated as "nothing to add" (never throws).
export function defaultLaunchdLabelLister(
  runLaunchctl: LaunchctlRunner,
  uid: number,
): string[] {
  const labels = new Set<string>();

  const list = runLaunchctl(["list"]);
  if (list.status === 0) {
    for (const line of list.stdout.split("\n")) {
      // "PID\tStatus\tLabel" - the label is the third tab-separated column.
      const label = (line.split("\t")[2] ?? "").trim();
      if (label) labels.add(label);
    }
  }

  const disabled = runLaunchctl(["print-disabled", `gui/${uid}`]);
  if (disabled.status === 0) {
    // Lines look like:  "ai.marginfront.ccc.example" => disabled
    const quoted = /"([^"]+)"\s*=>/g;
    let match: RegExpExecArray | null;
    while ((match = quoted.exec(disabled.stdout)) !== null) {
      labels.add(match[1]);
    }
  }

  return [...labels];
}

// Extra knobs only uninstall needs.
export interface UninstallDaemonOptions extends DaemonLifecycleOptions {
  // How to discover orphan labels to sweep (default: defaultLaunchdLabelLister).
  labelLister?: LaunchdLabelLister;
}

// FULLY REMOVE THE DAEMON: bootout (unload) EVERY ai.marginfront.ccc* label - the
// main job AND any orphan like ai.marginfront.ccc.example a prior run left loaded -
// then delete the plist AND the stable cli.js copy. Each bootout result is IGNORED on
// purpose - it fails with a "not loaded" error when a label was never installed (or
// already stopped), and uninstall must succeed cleanly either way.
export function uninstallDaemon(options: UninstallDaemonOptions = {}): void {
  const runLaunchctl = options.runLaunchctl ?? defaultLaunchctlRunner;
  const log = options.log ?? console.log;
  const daemonCliPath = options.daemonCliPath ?? DAEMON_CLI_PATH;
  const plistPath = options.plistPath ?? PLIST_PATH;
  const uid = options.uid ?? currentUid();
  const listLabels = options.labelLister ?? defaultLaunchdLabelLister;

  // Build the set to boot out: our main label is ALWAYS included (even if the lister
  // can't see it), plus every discovered label that belongs to us. The Set dedupes so
  // the main label isn't booted out twice.
  const toBootOut = new Set<string>([PLIST_LABEL]);
  for (const label of listLabels(runLaunchctl, uid)) {
    if (CCC_LABEL_PATTERN.test(label)) toBootOut.add(label);
  }
  for (const label of toBootOut) {
    // Unload from launchd (ignore "not loaded").
    runLaunchctl(["bootout", `gui/${uid}/${label}`]);
  }

  // Remove the job definition so it can't auto-start at the next login.
  if (existsSync(plistPath)) {
    rmSync(plistPath, { force: true });
    log(`Removed the background-job definition at ${plistPath}.`);
  }

  // Remove the stable cli.js copy we made on install.
  if (existsSync(daemonCliPath)) {
    rmSync(daemonCliPath, { force: true });
    log(`Removed the meter program copy at ${daemonCliPath}.`);
  }
}

// PAUSE the daemon without removing its definition - bootout only, leaving the plist
// + cli.js in place so `start` (or the next login) brings it back. Used by `stop`.
// Returns whether it was actually loaded, for a friendlier message; a "not loaded"
// bootout (nonzero status) means there was nothing to pause, which is fine.
export function bootoutDaemon(options: DaemonLifecycleOptions = {}): boolean {
  const runLaunchctl = options.runLaunchctl ?? defaultLaunchctlRunner;
  const uid = options.uid ?? currentUid();
  const result = runLaunchctl(["bootout", `gui/${uid}/${PLIST_LABEL}`]);
  return result.status === 0;
}

// A plain-English read of the daemon's state, for `status`.
export interface DaemonStatus {
  loaded: boolean; // is the job known to launchd at all?
  running: boolean; // is it actually executing right now?
  pid: number | null; // its process id when running
  // launchd's "last exit code" for the job: nonzero after a crash, and it
  // PERSISTS across the KeepAlive respawn, which is what lets `status` see an
  // established crash-loop the moment-in-time pid can't. Null when the job has
  // never exited (or the line is absent).
  lastExitCode: number | null;
}

// Parse `launchctl print gui/<uid>/<label>` output into the status above. A
// NONZERO exit means launchd has no such job (not loaded). When loaded, the dump
// includes a "state = running" line and (while running) a "pid = N" line. Pure +
// exported so it can be unit-tested against captured launchctl output.
export function parseDaemonPrint(result: LaunchctlResult): DaemonStatus {
  if (result.status !== 0) {
    return { loaded: false, running: false, pid: null, lastExitCode: null };
  }
  const out = result.stdout;
  const running = /\bstate\s*=\s*running\b/.test(out);
  const pidMatch = out.match(/\bpid\s*=\s*(\d+)/);
  const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
  const exitMatch = out.match(/\blast exit code\s*=\s*(\d+)/);
  const lastExitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
  return { loaded: true, running, pid, lastExitCode };
}

// Ask launchd whether our daemon is loaded/running. Injectable runner so it's
// testable; production uses the real launchctl.
export function queryDaemonStatus(
  options: { runLaunchctl?: LaunchctlRunner; uid?: number } = {},
): DaemonStatus {
  const runLaunchctl = options.runLaunchctl ?? defaultLaunchctlRunner;
  const uid = options.uid ?? currentUid();
  return parseDaemonPrint(runLaunchctl(["print", `gui/${uid}/${PLIST_LABEL}`]));
}

// Return the last `maxLines` lines of a text file (for `status` to show recent
// daemon output/errors). Missing/unreadable file -> [] (nothing to show, never a
// crash). Drops a single trailing blank from a final newline so we don't print "".
export function readLastLines(path: string, maxLines: number): string[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines);
}

// Cap a daemon log in place. launchd holds the log's file descriptor open in
// append mode, so ROTATE-BY-RENAME would silently redirect the daemon's writes
// into the renamed file. Instead we keep the last chunk in `<path>.1` and
// truncate the live file to zero (append fds keep working after truncate). Runs
// at daemon startup; a crash-loop respawns often enough that the cap holds. Any
// error is swallowed by the caller: log hygiene must never stop the meter.
export function rotateLogIfHuge(path: string, maxBytes: number): void {
  if (!existsSync(path)) return;
  if (statSync(path).size <= maxBytes) return;
  const KEEP_TAIL_BYTES = 256 * 1024;
  let tail = "";
  try {
    const text = readFileSync(path, "utf8");
    tail = text.slice(-KEEP_TAIL_BYTES);
  } catch {
    // unreadable tail: still truncate, because capping the disk is the job
  }
  writeFileSync(`${path}.1`, tail);
  truncateSync(path, 0);
}

// ===========================================================================
// THE REDUNDANT ~/.zshrc `source` LINE
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, in plain English: a developer's ~/.zshrc can carry the line
//     source ~/.marginfront-ccc/.env
// to keep Claude Code's telemetry on in every shell. `init` turns telemetry on
// through ~/.claude/settings.json instead, which the Claude command line reads
// with no shell at all, so that ~/.zshrc line does nothing. We DETECT it so `init` can OFFER to
// tidy it up and `uninstall` can remind the user about it. We NEVER edit ~/.zshrc
// without the user explicitly saying yes: it's their file, and it may hold lines
// we know nothing about.
// ===========================================================================

// Where the user's zsh startup file lives.
export const ZSHRC_PATH = join(homedir(), ".zshrc");

// Does ONE shell line source OUR connector's .env? Matches the `source` builtin
// and its `.` alias, ignores commented-out lines, and keys off the distinctive
// ".marginfront-ccc/.env" path - so an unrelated `source somethingelse` is never
// matched. Handles the common spellings (~/, $HOME/, quoted). Exported so the
// detection rule itself is directly unit-testable.
export function lineSourcesCccEnv(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  // Must START with the source builtin (`source` or its `.` alias) + whitespace…
  if (!/^(source|\.)\s/.test(trimmed)) return false;
  // …and mention our env file somewhere on the line.
  return trimmed.includes(".marginfront-ccc/.env");
}

// What a scan of ~/.zshrc found: whether any redundant source line is present,
// and the exact matched lines (trimmed, for showing the user).
export interface ZshrcSourceLineResult {
  found: boolean;
  matchedLines: string[];
}

// Scan ~/.zshrc for the redundant source line(s). Missing/unreadable file reads
// as "found nothing" - never a throw, so callers can use it freely.
export function findCccZshrcSourceLines(
  zshrcPath: string = ZSHRC_PATH,
): ZshrcSourceLineResult {
  if (!existsSync(zshrcPath)) return { found: false, matchedLines: [] };
  let text: string;
  try {
    text = readFileSync(zshrcPath, "utf8");
  } catch {
    return { found: false, matchedLines: [] };
  }
  const matchedLines = text
    .split("\n")
    .filter(lineSourcesCccEnv)
    .map((line) => line.trim());
  return { found: matchedLines.length > 0, matchedLines };
}

// Result of removing the redundant line(s): which lines we took out and where the
// safety backup landed (null when there was nothing to remove).
export interface RemoveZshrcResult {
  removed: string[];
  backupPath: string | null;
}

// REMOVE the redundant source line(s) from ~/.zshrc - ONLY ever called after the
// user explicitly agreed. Backs the file up to "<path>.ccc-bak" first, then drops
// only the matching lines and leaves every other line byte-for-byte. A missing or
// unreadable file is a soft no-op (a log line, never a throw) so this can never
// crash `init`.
export function removeCccZshrcSourceLine({
  zshrcPath = ZSHRC_PATH,
  log = console.log,
}: { zshrcPath?: string; log?: LogFn } = {}): RemoveZshrcResult {
  if (!existsSync(zshrcPath)) {
    log(`Nothing to remove: ${zshrcPath} doesn't exist.`);
    return { removed: [], backupPath: null };
  }
  let text: string;
  try {
    text = readFileSync(zshrcPath, "utf8");
  } catch {
    log(
      `Could not read ${zshrcPath}, so I left it untouched - ` +
        "remove the `source ~/.marginfront-ccc/.env` line by hand if you like.",
    );
    return { removed: [], backupPath: null };
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (lineSourcesCccEnv(line)) removed.push(line.trim());
    else kept.push(line);
  }

  if (removed.length === 0) {
    log(`Nothing to remove in ${zshrcPath}: no MarginFront source line found.`);
    return { removed: [], backupPath: null };
  }

  // Back up the original before we rewrite it - same .ccc-bak convention as our
  // other reverters, so a worried user always has the untouched file to fall back on.
  const backupPath = `${zshrcPath}.ccc-bak`;
  copyFileSync(zshrcPath, backupPath);
  writeFileSync(zshrcPath, kept.join("\n"));
  log(
    `Removed the redundant 'source ~/.marginfront-ccc/.env' line from ${zshrcPath} ` +
      `(backup at ${backupPath}).`,
  );
  return { removed, backupPath };
}
