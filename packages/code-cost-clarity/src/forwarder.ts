// forwarder.ts - Claude Code + Codex usage telemetry -> MarginFront usage records.
// Pure builders (shared by preview / one-shot send / live watcher) + the watcher.
//
// THE ONE RULE: Claude Code reports four token kinds - fresh input,
// output, cache-read, cache-creation - that Anthropic prices differently, and
// MarginFront prices all of them. DEFAULT sends cache-read/-creation in their own
// typed fields (accurate). --fold-cache instead adds them into billed input at the
// fresh-input rate: a deliberate HIGH ceiling for a model MarginFront can't price
// yet, never silently low. Either way the raw cache counts + Claude Code's own
// cache-accurate dollar figure are recorded in metadata as audit ground truth.

import {
  readFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";

// Our own package version, stamped into the User-Agent header we send to
// MarginFront so the version always matches the release without anyone having to
// hand-edit a string (and so the server can tag these events as source='ccc').
//
// WHY THIS IS SO CAREFUL: `start` copies the
// BUILT cli.js bundle to ~/.marginfront-ccc/cli.js so launchd can run the meter
// forever. From that copied location there is NO package.json one level up, so a
// plain require("../package.json") would throw MODULE_NOT_FOUND. And because this
// runs at IMPORT TIME (the moment the bundle loads, before any command runs), that
// throw would kill `node cli.js run` on startup - and under launchd's KeepAlive
// that's an invisible respawn loop every ~10 seconds, forever. So we resolve the
// version in a way that can NEVER throw at module load:
//   1. Prefer __CCC_VERSION__, a literal baked in at BUILD TIME by tsup's `define`
//      (see tsup.config.ts). In the shipped bundle this is a real version string,
//      so it works from ANY directory - including the relocated daemon copy.
//   2. Fall back to reading our package.json at runtime. This is the path taken
//      when running FROM SOURCE (tests, dev), where __CCC_VERSION__ isn't defined
//      but package.json IS one level up - so the version stays exact there too.
//   3. Last-ditch placeholder, only if BOTH fail, so module load still completes
//      instead of crashing the daemon. (A relocated bundle with no inlined
//      literal lands here - wrong version, but alive, not crash-looping.)
const _cccRequire = createRequire(import.meta.url);

// Declared so TypeScript accepts the identifier; tsup replaces every use of it with
// a string literal at build time. At runtime-from-source it's simply not defined,
// which the `typeof` guard below handles WITHOUT throwing (typeof on an undefined
// identifier is safe - a bare reference would be a ReferenceError).
declare const __CCC_VERSION__: string;

export function resolveCccPackageVersion(): string {
  // 1) Build-time inlined literal - present in the shipped bundle, location-proof.
  if (typeof __CCC_VERSION__ === "string" && __CCC_VERSION__.length > 0) {
    return __CCC_VERSION__;
  }
  // 2) Runtime read of our own package.json (the from-source path).
  try {
    const pkg = _cccRequire("../package.json") as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // No package.json reachable from here - fall through; NEVER throw at load.
  }
  // 3) Never-throw fallback so the daemon can always start.
  return "0.0.0-unknown";
}

export const CCC_PACKAGE_VERSION: string = resolveCccPackageVersion();

import type {
  OtlpAttribute,
  OtlpAnyValue,
  OtlpLogAttribute,
  OtlpLogRecord,
  OtlpDataPoint,
  ParsedOtlp,
  UsageRecord,
  RequestBody,
  IngestResponse,
  IngestSuccessRow,
  BuildBodyOptions,
  CacheWriteTtl,
  WatchOptions,
  ReadLinesResult,
  ReadLimits,
  PostResult,
  AuthProbeResult,
  KeyCheckResult,
  AuthHoldState,
} from "./types";

// Collector self-heal + the settings-file path. Pulled from connector.ts (no cycle -
// connector never imports us).
import {
  ENV_PATH,
  isPidAlive,
  readCollectorPid,
  startCollector,
} from "./connector";

// Cost-per-PR attribution: the watcher builds a resolver and threads it
// into every build so records carry {repo, branch, commitSha}.
import { createGitCoordinatesResolver } from "./git-coordinates";

// Control (the opt-in spend cap): the watcher resolves the armed stamp once (threaded into
// every Claude build like cacheWriteTtl) and pulls the cap read-back on its cadence.
import {
  resolveControlArmedStamp,
  syncControlState,
  healCodexControlState,
  readCodexTrustCache,
  writeCodexTrustCache,
  resolveCodexControlStamp,
  resolveCodexControlStatus,
  codexTrustValidForMs,
  unknownCodexControlStamp,
  type CodexControlStamp,
  type CodexTrustCacheEntry,
} from "./control";

// The ONE outbound-transport policy, shared byte-identical across the three
// packages (see transport-policy.ts for why it's replicated, not imported).
import { maskApiKey } from "./transport-policy";
import {
  keyCheckUrl,
  keyIdentityUrl,
  resolveConfiguredServer,
  sendToServer,
  usageRecordUrl,
} from "./server-url";

// Resolve the per-developer attribution override from the environment, in ONE place.
// A shared coding-agent login makes every turn report the SAME user.email, so all the
// cost collapses onto one customer. Setting CCC_DEVELOPER_EMAIL on a laptop overrides
// that, so this machine's spend is attributed to the right developer. We trim so a
// stray space can't become a bogus customer id, and an empty/whitespace-only value
// collapses to undefined - which the builders read as "no override", i.e. the
// telemetry's own email is used. Kept PURE and
// exported on its own so the env -> override seam is directly testable: env in, value
// out, nothing global read here. The watcher calls this once and threads the result
// into every build call.
export function resolveDeveloperOverride(
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (env.CCC_DEVELOPER_EMAIL || "").trim() || undefined;
}

// Resolve the cache-write TTL hint from CCC_CACHE_WRITE_TTL (written by init's
// detect-or-ask step) the same way resolveDeveloperOverride works:
// pure, env in / value out, resolved once by the watcher and threaded into every
// build. Only the two valid values pass; anything else (unset, typo, blank)
// collapses to undefined => no metadata stamp => the server prices cache
// writes at the 1-hour ceiling.
export function resolveCacheWriteTtl(
  env: NodeJS.ProcessEnv,
): CacheWriteTtl | undefined {
  const raw = (env.CCC_CACHE_WRITE_TTL || "").trim().toLowerCase();
  return raw === "5m" || raw === "1h" ? raw : undefined;
}

// Metadata values aren't length-checked one by one (only the whole object, at 16 KB),
// so this holds the ID to INGEST_STRING_MAX_LENGTH - the cap on every top-level
// ingest string (apps/api-nest/src/modules/sdk/dto/record-usage.dto.ts).
const WORK_ID_MAX_LENGTH = 255;

// The settings key `init` asks for. CCC_MATTER_ID is also read as the same key,
// because `init` never rewrites a settings file that already exists and a file may
// carry that line.
export const WORK_ID_ENV_KEY = "CCC_WORK_ID";
export const MATTER_NUMBER_ENV_KEY = "CCC_MATTER_ID";

// Highest precedence first: this array's order IS the precedence rule.
const WORK_ID_ENV_KEYS = [WORK_ID_ENV_KEY, MATTER_NUMBER_ENV_KEY] as const;

// Declared in a leaf module so pure files can read them without loading this
// one's import.meta version probe; re-exported because customers import them here.
export { WORK_ITEM_NOUN, WORK_ITEM_NOUN_PLAIN } from "./work-item-noun";

// A union, not two optional fields: a value always came from a key, so "set, from
// nowhere" has no spelling here. The key rides along so printed copy can name the key
// a machine actually has, not one its owner has to go looking for.
export type WorkId =
  | { value: string; key: string }
  | { value?: undefined; key?: undefined };

// Blank => undefined => no metadata.matterId => an untagged record. Trimmed but never re-cased: ingest matches the ID EXACTLY, so "correcting" the
// capitals here would turn a diagnosable Unassigned row into a silently wrong
// attribution.
export function normalizeWorkId(raw: string | undefined): string | undefined {
  const trimmed = (raw || "").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, WORK_ID_MAX_LENGTH);
}

// A key that is set but blank never beats a key that has a value. The settings
// template ships a blank CCC_WORK_ID= line, so the other reading would silently
// drop the attribution of anyone with a value on CCC_MATTER_ID.
export function resolveWorkId(env: Record<string, string | undefined>): WorkId {
  for (const key of WORK_ID_ENV_KEYS) {
    const value = normalizeWorkId(env[key]);
    if (value) return { value, key };
  }
  return { value: undefined };
}

// Read the named KEY=value lines out of the settings file in ONE pass, without
// touching process.env. loadEnvFile deliberately refuses to overwrite a variable that
// is already set, which is right at startup and wrong here: this is the live re-read,
// and a value it loaded an hour ago would win forever.
function readEnvFileValues(
  path: string,
  keys: readonly string[],
): Record<string, string | undefined> {
  const found: Record<string, string | undefined> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return found;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!keys.includes(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Last line wins, matching how a shell sourcing the file would read it.
    found[key] = value;
  }
  return found;
}

export interface SettingsReaderDeps {
  // The settings file to read. Defaults to the real ~/.marginfront-ccc/.env.
  envPath?: string;
  // "When did that file last change?" null when it is missing or unreadable.
  fileChangedAtMs?: (path: string) => number | null;
  // "What do these keys say in that file?" Injected so a test can COUNT reads and
  // prove the modified-time guard actually skips them.
  readFileValues?: (
    path: string,
    keys: readonly string[],
  ) => Record<string, string | undefined>;
  // Consulted ONLY when the file names NONE of the keys - in practice a settings file
  // that has no such line, since `init` writes the lines blank and a
  // present-but-blank line means "not set" and wins over any export. Defaults to this
  // process's environment, which is right for a one-shot command and wrong for the
  // daemon: see WatchOptions.matterEnv.
  env?: Record<string, string | undefined>;
}

export type WorkIdReaderDeps = SettingsReaderDeps;

// Re-read rather than resolve-once, because nobody restarts a background meter they
// cannot see, and the answers these settings give change during a working day. The
// modified-time guard is load-bearing, not an optimization: the caller runs once per
// telemetry line, so an unguarded version would read the file forever.
// The file wins whenever it names ANY of the keys, blank included: a blank line is a
// deliberate "not set" that must beat a variable someone exported months ago.
function createSettingsReader<T>(
  keys: readonly string[],
  resolve: (values: Record<string, string | undefined>) => T,
  deps: SettingsReaderDeps = {},
): () => T {
  const envPath = deps.envPath ?? ENV_PATH;
  const fileChangedAtMs =
    deps.fileChangedAtMs ??
    ((path: string) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    });
  const readFileValues = deps.readFileValues ?? readEnvFileValues;
  const env = deps.env ?? process.env;

  let cachedChangedAtMs = 0;
  let cachedFileValues: Record<string, string | undefined> = {};
  let haveRead = false;

  return () => {
    const changedAtMs = fileChangedAtMs(envPath);
    if (changedAtMs === null) {
      // No readable settings file: fall back to the environment, and forget the cache
      // so a file that comes back is read again.
      haveRead = false;
      cachedChangedAtMs = 0;
      cachedFileValues = {};
      return resolve(env);
    }
    if (!haveRead || changedAtMs !== cachedChangedAtMs) {
      cachedFileValues = readFileValues(envPath, keys);
      cachedChangedAtMs = changedAtMs;
      haveRead = true;
    }
    const fileNamesAKey = keys.some(
      (key) => cachedFileValues[key] !== undefined,
    );
    return resolve(fileNamesAKey ? cachedFileValues : env);
  };
}

export function createWorkIdReader(deps: WorkIdReaderDeps = {}): () => WorkId {
  return createSettingsReader(WORK_ID_ENV_KEYS, resolveWorkId, deps);
}

// --- WHICH REPOS THIS MACHINE NEVER SENDS FROM ------------------------------
//
// One line, comma-separated owner/repo names. A session whose git remote matches one
// of them produces no records at all.
export const IGNORE_REPOS_ENV_KEY = "CCC_IGNORE_REPOS";
const IGNORE_REPOS_ENV_KEYS = [IGNORE_REPOS_ENV_KEY] as const;

// owner/repo, with no whitespace and no empty segment. Multi-segment paths pass
// because that is what a GitLab subgroup remote normalizes to, and refusing them
// would silently drop an entry a customer can see is right.
const OWNER_REPO_SHAPE = /^[^\s/]+(\/[^\s/]+)+$/;

export interface IgnoredRepos {
  // Lowercased, because matching is case-insensitive on the exact owner/repo.
  repos: Set<string>;
  // Entries that are not owner/repo, kept verbatim so a status line can hand the
  // customer back exactly what they typed. An entry in here ignores nothing.
  malformed: string[];
  // Entries that pass the shape gate but carry a web address in front. Worse than a
  // malformed one: it sits in the ACTIVE list looking right and can never match.
  hostPrefixed: string[];
}

// A pasted browser address (github.com/acme/billing) or git remote
// (git@github.com:acme/billing). The dot test needs a whole owner/repo behind it, so a
// two-segment GitLab group with a dot in its name is not mistaken for a host.
function carriesAWebAddress(entry: string): boolean {
  if (entry.includes("@")) return true;
  const segments = entry.split("/");
  return segments.length > 2 && segments[0].includes(".");
}

export function resolveIgnoredRepos(
  env: Record<string, string | undefined>,
): IgnoredRepos {
  const repos = new Set<string>();
  const malformed: string[] = [];
  const hostPrefixed: string[] = [];
  for (const piece of (env[IGNORE_REPOS_ENV_KEY] || "").split(",")) {
    const entry = piece.trim();
    if (!entry) continue;
    // normalizeRemoteUrl strips ".git" off every remote before the repo is stamped, so
    // an entry that keeps it would pass the shape gate below and match nothing.
    const named = entry.replace(/\.git$/i, "");
    if (!OWNER_REPO_SHAPE.test(named)) {
      malformed.push(entry);
      continue;
    }
    if (carriesAWebAddress(named)) hostPrefixed.push(entry);
    repos.add(named.toLowerCase());
  }
  return { repos, malformed, hostPrefixed };
}

// No shell-export fallback, deliberately: a rule that stops spend being counted has
// to be readable in the one file that documents it, not inherited from whatever
// shell happened to start the meter.
export function createIgnoredReposReader(
  deps: Omit<SettingsReaderDeps, "env"> = {},
): () => IgnoredRepos {
  return createSettingsReader(IGNORE_REPOS_ENV_KEYS, resolveIgnoredRepos, {
    ...deps,
    env: {},
  });
}

// Constant source tags stamped on every Claude Code record.
const AGENT_CODE = "claude-code";
const SIGNAL_NAME = "claude-code-turn";
const MODEL_PROVIDER = "anthropic";

// Same tags for the second source, Codex: distinct agent/signal/
// provider so a Codex turn is distinguishable from a Claude Code turn.
const AGENT_CODE_CODEX = "codex";
const SIGNAL_NAME_CODEX = "codex-turn";
const MODEL_PROVIDER_CODEX = "openai";

// Codex token counts ride on a log record named "codex.sse_event". We match this
// name when present but don't depend on it - see isCodexUsageRecord.
const CODEX_USAGE_EVENT_NAME = "codex.sse_event";

// The six token fields Codex stamps on that event. input/output and the
// cached/cache-write slices of input drive the billed numbers; reasoning/tool are
// audit-only because they're nested INSIDE input/output (see buildCodexRequestBody).
const CODEX_INPUT_TOKEN_KEY = "input_token_count";
const CODEX_OUTPUT_TOKEN_KEY = "output_token_count";
const CODEX_CACHED_TOKEN_KEY = "cached_token_count";
// Newer Codex binaries only (seen on 0.145.0/0.146.0, absent on 0.142.x), and
// pre-5.6 models report it as 0. Both read as "no cache write".
const CODEX_CACHE_WRITE_TOKEN_KEY = "cache_write_token_count";
const CODEX_REASONING_TOKEN_KEY = "reasoning_token_count";
const CODEX_TOOL_TOKEN_KEY = "tool_token_count";

// Any of these present = a usage event; codex.sse_event is the only Codex log
// that carries token counts, so this is a reliable fallback to the event name.
const CODEX_TOKEN_KEYS = [
  CODEX_INPUT_TOKEN_KEY,
  CODEX_OUTPUT_TOKEN_KEY,
  CODEX_CACHED_TOKEN_KEY,
  CODEX_CACHE_WRITE_TOKEN_KEY,
  CODEX_REASONING_TOKEN_KEY,
];

// Pseudo-models that aren't real billable models (e.g. codex-auto-review,
// Codex's internal auto-review pass) - dropped so they can't mis-price or land
// NEEDS_COST_BACKFILL. Compared case-insensitively.
const CODEX_EXCLUDED_MODELS = new Set<string>(["codex-auto-review"]);

// --- TOOL-CALL LINE ITEMS --------------------------------------
// A tool that hits a PAID external API (Google Maps, Browserbase, a paid MCP
// server) is recorded as its own priced line - count x catalog unit rate -
// attributed to the same developer as the token turn. It's a SIBLING event, not
// folded in; see buildToolUsageRecords for why.

// Tool records reuse the source's developer + agentCode (so they roll up under
// the one developer) but carry a distinct signal name to stay queryable apart.
const SIGNAL_NAME_TOOL = "claude-code-tool";
const SIGNAL_NAME_TOOL_CODEX = "codex-tool";

// The events meaning "a tool actually finished running" - the count source of
// truth. Claude's event.name is the short "tool_result". Neither is emitted for a
// REJECTED call, so rejections are excluded for free. We deliberately do NOT count
// *_decision events (those include rejections) nor Codex's tool_token_count (those
// are MODEL tokens formatting tool I/O, already nested in output - a different number).
const CLAUDE_TOOL_RESULT_EVENT = "claude_code.tool_result";
const CODEX_TOOL_RESULT_EVENT = "codex.tool_result";

// Where the tool NAME rides. tool_name is the source of truth. The two coding agents
// name MCP tools DIFFERENTLY: Codex emits the full "mcp__server__tool" here natively
// (non-MCP example: tool_name="exec_command"), while
// Claude Code emits the bare bucket "mcp_tool" and only carries the real server + tool
// name in a separate "tool_parameters" attribute when OTEL_LOG_TOOL_DETAILS=1 is set
// (reassembled to the same "mcp__server__tool" shape below). "tool.name"
// is a hedge against version drift. There is no bare "name" fallback: it is too broad
// and could mis-bill an unrelated "name" attribute.
const TOOL_NAME_KEYS = ["tool_name", "tool.name"];

// Provider tag on every tool line. The `model` field carries the raw tool name;
// MarginFront's catalog decides billability by matching (model=tool name,
// modelProvider="tool"). The forwarder forwards; MarginFront maps + prices.
const MODEL_PROVIDER_TOOL = "tool";

// Synthesized service id for Codex web search - there's no tool_name
// attribute to forward verbatim here, so we stamp this literal, matching the
// "tool/web_search" catalog row (distinct from Claude's raw "WebSearch" tool_name).
const CODEX_WEB_SEARCH_TOOL_NAME = "web_search";

// Every record is sent with this environment; there is no per-session setting.
const ENVIRONMENT = "development";

// How often the --watch loop checks the live file (ms).
const WATCH_POLL_MS = 1000;

// Most bytes of the live file one poll reads. Reading the whole
// unsent tail at once can throw past Node's string ceiling, and the poll would
// then retry that same read forever while nothing drained.
export const MAX_TAIL_BYTES_PER_TICK = 16 * 1024 * 1024;

// How often the daemon pulls the Control cap + spend read-back (ms). The 1s file
// poll is far too hot for a network read-back, so control sync rides the same loop
// but throttles to the 5-minute flush cadence - the telemetry beat this daemon
// already runs on (OTEL_*_EXPORT_INTERVAL). The hook enforces the last synced number
// between pulls; a longer gap just means a staler cap, which fails open past the
// hook's freshness window.
const CONTROL_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// How often the daemon asks Codex whether it can still read our hook file (ms). Much
// slower than the spend pull: this spawns a Codex process, and the thing it watches
// for - Codex changing its hook file format in a new release - moves at the speed of
// Codex releases, not minutes.
const CODEX_HEAL_INTERVAL_MS = 60 * 60 * 1000;

// How often the daemon asks Codex whether it still TRUSTS our hook (ms). Minutes,
// not the self-heal's hour: setup ends with the developer running /hooks and
// clicking trust, and a dashboard that takes an hour to notice reads as broken.
const CODEX_TRUST_REFRESH_MS = 5 * 60 * 1000;

// The directory the daemon's Codex answer is ABOUT. Codex resolves hooks
// per working directory, and the daemon's own cwd is an accident - launchd hands it
// `/` - so an answer resolved there means something different on every machine while
// the dashboard presents it as one org-wide claim. Home is stable and carries no
// project-scoped Codex config, so the answer describes the machine's global setup.
// NOT COVERED: a repo whose own config shadows the hook still reads as armed here.
const CODEX_TRUST_SCOPE_CWD = homedir();

// Elapsed time a clock change cannot move. Date.now() is the wrong instrument for
// "has this aged out": walk the wall clock backwards and every deadline expressed in
// it sits hours in the future while the daemon keeps stamping an unchecked verdict.
function monotonicNowMs(): number {
  return performance.now();
}

// No-identity fallback: bills under a clearly labeled placeholder customer rather
// than dropping usage that surfaced no account email.
export const NO_IDENTITY_CUSTOMER = "claude-code-no-identity";
// Codex-specific variant so a Codex developer with no user.email doesn't land
// under the Claude-branded placeholder.
export const CODEX_NO_IDENTITY_CUSTOMER = "codex-no-identity";

// --- SMALL HELPERS for the OTLP/JSON shape ---------------------------------
// OTLP stores attributes as a LIST of { key, value: { stringValue } }, not a plain
// object. These turn that into a by-name lookup so the rest stays clean.

// OTLP attribute list -> { key: value } lookup.
function attributesToLookup(
  attributeList: OtlpAttribute[] | undefined,
): Record<string, string | undefined> {
  const lookup: Record<string, string | undefined> = {};
  if (!Array.isArray(attributeList)) return lookup;
  for (const attribute of attributeList) {
    if (attribute && typeof attribute.key === "string" && attribute.value) {
      // stringValue is the only type Claude Code uses here; a future other type
      // reads as undefined rather than crashing.
      lookup[attribute.key] = attribute.value.stringValue;
    }
  }
  return lookup;
}

// A datapoint's value as a whole token count. OTLP carries it as EITHER `asInt`
// (a JSON string, Claude Code's console exporter) OR `asDouble` (a JSON number,
// the Collector's file exporter) - handle both; the real pipeline uses asDouble.
// Missing/garbage -> 0 ("zero of that type used"), never NaN.
function dataPointTokenCount(
  dataPoint: OtlpDataPoint | null | undefined,
): number {
  if (dataPoint == null) return 0;
  if (dataPoint.asInt !== undefined && dataPoint.asInt !== null) {
    const parsed = parseInt(String(dataPoint.asInt), 10); // base-10 on purpose
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (dataPoint.asDouble !== undefined && dataPoint.asDouble !== null) {
    const parsed = Math.round(Number(dataPoint.asDouble)); // tokens are whole
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// Flatten resourceMetrics[].scopeMetrics[].metrics[].sum.dataPoints into one list
// of datapoints for the named metric, so callers don't walk the tree.
function collectDataPointsForMetric(
  parsedOtlp: ParsedOtlp,
  metricName: string,
): OtlpDataPoint[] {
  const collectedDataPoints: OtlpDataPoint[] = [];
  const resourceMetricsList = parsedOtlp?.resourceMetrics;
  if (!Array.isArray(resourceMetricsList)) return collectedDataPoints;

  for (const resourceMetric of resourceMetricsList) {
    const scopeMetricsList = resourceMetric?.scopeMetrics;
    if (!Array.isArray(scopeMetricsList)) continue;

    for (const scopeMetric of scopeMetricsList) {
      const metricsList = scopeMetric?.metrics;
      if (!Array.isArray(metricsList)) continue;

      for (const metric of metricsList) {
        if (metric?.name !== metricName) continue;
        const dataPointsList = metric?.sum?.dataPoints;
        if (!Array.isArray(dataPointsList)) continue;
        for (const dataPoint of dataPointsList) {
          collectedDataPoints.push(dataPoint);
        }
      }
    }
  }
  return collectedDataPoints;
}

// --- MODEL NAME NORMALIZATION ----------------------------------------------
// Claude Code reports "claude-opus-4-8[1m]"; the pricing table stores
// "claude-opus-4.8" (dot, no bracket suffix). Sending the raw string -> null cost.
// Two GENERIC steps (not a hardcoded one-model swap) so new models normalize too;
// the ONE place to update when a new family lands.
export function normalizeModelId(rawModelId: string): string;
export function normalizeModelId(rawModelId: unknown): unknown;
export function normalizeModelId(rawModelId: unknown): unknown {
  if (typeof rawModelId !== "string") return rawModelId;

  // Step 1: drop a trailing [..] context-window suffix ([1m], [200k], ...).
  const withoutContextSuffix = rawModelId.replace(/\[.*\]$/, "");

  // Step 2: version segment's last "-<digits>" -> ".<digits>" (-4-8 -> -4.8).
  const dottedVersion = withoutContextSuffix.replace(
    /^(claude-[a-z]+-\d+)-(\d+)$/,
    "$1.$2",
  );

  return dottedVersion;
}

// One accumulated token group (who/which model/which session + the four running
// token tallies). Local intermediate accumulator, not the request DTO.
interface TokenGroup {
  email: string;
  rawModel: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// --- IDEMPOTENCY KEY -----------------------------------
// Stamps each turn so the server can tell a re-send from a new turn. Two opposite
// pulls: a REPLAY (same line re-read after restart, or a queue retry) must produce
// the SAME key (server dedups); DISTINCT turns must NOT collide (else we under-count
// by deduping real events). We hash four things that pin a turn uniquely AND
// deterministically: rawSourceLine (the exact collector line - carries per-tick
// counts+cost, so ticks differ; a byte-identical re-read reproduces it), email,
// rawModel, and indexWithinLine (one line can yield several records - multiple
// developers, or several codex.sse_event records in one flush - so the deterministic
// position keeps same-line records distinct even if who/model/session match).
// sessionId folded in as extra signal.
function idempotencyKeyFor(
  rawSourceLine: string,
  email: string,
  rawModel: string,
  sessionId: string | null,
  indexWithinLine: number,
): string {
  return createHash("sha256")
    .update(
      `${rawSourceLine}|${email}|${rawModel}|${sessionId ?? ""}|${indexWithinLine}`,
    )
    .digest("hex");
}

// --- THE CORE TRANSLATOR ----------------------------------------------------
// Shared by preview, one-shot send, AND the watcher, so preview == what's sent.
// options.foldCache (default false): true -> cache tokens ADDED into billed
// inputTokens (round-up for an unpriceable model); false -> sent in their own
// typed DTO fields at the real cache rates. Raw cache numbers go to metadata either way.
export function buildMarginFrontRequestBody(
  parsedOtlp: ParsedOtlp,
  options: BuildBodyOptions = {},
): RequestBody {
  const foldCache = options.foldCache === true;
  // Placeholder for usage that never surfaced an account email (some interactive
  // logins), so it lands somewhere obvious instead of being dropped.
  const fallbackCustomerId =
    typeof options.fallbackCustomerId === "string" &&
    options.fallbackCustomerId.length > 0
      ? options.fallbackCustomerId
      : null;

  // Per-developer attribution override (shared coding-agent login). When set, this
  // email WINS over the telemetry's own user.email for every record built here. The
  // watcher resolved it once from CCC_DEVELOPER_EMAIL; we never read the environment in
  // this pure builder. Unset => undefined, so the `|| attributes["user.email"]` below
  // falls back to the telemetry's own email.
  const developerOverride = options.developerOverride;

  const tokenDataPoints = collectDataPointsForMetric(
    parsedOtlp,
    "claude_code.token.usage",
  );
  const costDataPoints = collectDataPointsForMetric(
    parsedOtlp,
    "claude_code.cost.usage",
  );

  // Group token usage by (email, model, session). A real export can carry several
  // users/models/sessions at once, so don't assume a single group.
  const groupsByKey = new Map<string, TokenGroup>();

  function makeGroupKey(
    email: string,
    model: string,
    sessionId: string,
  ): string {
    return `${email}\n${model}\n${sessionId}`;
  }

  // First pass: fold the four token TYPES for each group into one tally.
  for (const dataPoint of tokenDataPoints) {
    const attributes = attributesToLookup(dataPoint.attributes);
    // PRECEDENCE: the shared-login override wins; otherwise user.email (stamped on
    // org-managed seats); otherwise the no-identity placeholder.
    const email =
      developerOverride || attributes["user.email"] || fallbackCustomerId;
    const rawModel = attributes["model"];
    const sessionId = attributes["session.id"];
    const tokenType = attributes["type"]; // input | output | cacheRead | cacheCreation
    const tokenCount = dataPointTokenCount(dataPoint);

    // Missing model/session -> can't build a coherent record; skip rather than bill
    // a phantom group. (email is covered by the placeholder above.)
    if (!email || !rawModel || !sessionId) continue;

    const groupKey = makeGroupKey(email, rawModel, sessionId);
    let group = groupsByKey.get(groupKey);
    if (!group) {
      group = {
        email,
        rawModel,
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      groupsByKey.set(groupKey, group);
    }

    // Fresh input/output -> billed counts; cacheRead/cacheCreation -> their own
    // buckets. How cache reaches MarginFront (typed vs folded) is decided below.
    if (tokenType === "input") {
      group.inputTokens += tokenCount;
    } else if (tokenType === "output") {
      group.outputTokens += tokenCount;
    } else if (tokenType === "cacheRead") {
      group.cacheReadTokens += tokenCount;
    } else if (tokenType === "cacheCreation") {
      group.cacheCreationTokens += tokenCount;
    }
    // Any unknown future type is intentionally ignored for billing.
  }

  // Cost for a group. The cost metric carries only email + model + session (no
  // "type"), so we join on exactly those three.
  function findCostForGroup(
    email: string,
    rawModel: string,
    sessionId: string,
  ): number | null {
    for (const costPoint of costDataPoints) {
      const costAttributes = attributesToLookup(costPoint.attributes);
      // Resolve the cost row's developer the SAME way as the token row above
      // (override first) so cost still joins to its token group: group.email is
      // the override too, so `costEmail === email` holds and the cost lands.
      const costEmail =
        developerOverride || costAttributes["user.email"] || fallbackCustomerId;
      if (
        costEmail === email &&
        costAttributes["model"] === rawModel &&
        costAttributes["session.id"] === sessionId
      ) {
        return typeof costPoint.asDouble === "number"
          ? costPoint.asDouble
          : null;
      }
    }
    return null;
  }

  // Second pass: turn each accumulated group into one MarginFront record.
  const records: UsageRecord[] = [];
  for (const group of groupsByKey.values()) {
    const cacheReadTokens = group.cacheReadTokens;
    const cacheCreationTokens = group.cacheCreationTokens;
    const cacheTokens = cacheReadTokens + cacheCreationTokens;

    // Billed input. --fold-cache rolls cache into input at the fresh-input rate
    // (round-up ceiling for an unpriceable model); otherwise input is fresh-only
    // and cache rides in its own typed fields below.
    const billedInputTokens = foldCache
      ? group.inputTokens + cacheTokens
      : group.inputTokens;

    // Empty-event guard. Test the RAW buckets, not billedInputTokens: in the
    // accurate default cache isn't part of billedInputTokens, so testing it would
    // silently drop a cache-only tick in the very mode meant to be accurate (one
    // --fold-cache would keep). Real turns always produce output, so only truly
    // empty ticks drop.
    if (
      group.inputTokens === 0 &&
      group.outputTokens === 0 &&
      cacheTokens === 0
    )
      continue;

    const claudeCodeCostUsd = findCostForGroup(
      group.email,
      group.rawModel,
      group.sessionId,
    );

    const gitCoordinates =
      options.resolveGitCoordinates?.(group.sessionId) ?? null;

    const record: UsageRecord = {
      // Per-developer attribution: the developer's email IS the customer id (or the
      // no-identity placeholder).
      customerExternalId: group.email,
      agentCode: AGENT_CODE,
      signalName: SIGNAL_NAME,
      model: normalizeModelId(group.rawModel),
      modelProvider: MODEL_PROVIDER,
      inputTokens: billedInputTokens,
      outputTokens: group.outputTokens,
      environment: ENVIRONMENT,
      // usageDate omitted so MarginFront defaults it to "now."
      metadata: {
        sessionId: group.sessionId,
        rawModel: group.rawModel,
        // Raw cache numbers ALWAYS recorded (audit), whether typed or folded.
        cacheReadTokens,
        cacheCreationTokens,
        // Whether inputTokens includes cache (fold) or not (default).
        cacheFoldedIntoInput: foldCache,
        // Claude Code's own cache-accurate cost - reconciliation ground truth,
        // not the billed figure.
        claudeCodeCostUsd: claudeCodeCostUsd,
        // Cache-write pricing hint. Omitted when unknown, so an
        // unstamped record carries no cacheWriteTtl key.
        ...(options.cacheWriteTtl
          ? { cacheWriteTtl: options.cacheWriteTtl }
          : {}),
        // Control armed-status stamp. Omitted when Control isn't armed,
        // so a record from an install without Control carries no stamp.
        ...(options.controlArmed ?? {}),
        // The job this machine's spend belongs to.
        ...(options.matterNumber ? { matterId: options.matterNumber } : {}),
        ...(gitCoordinates ?? {}),
      },
    };

    // DEFAULT path: typed, server-priced cache fields. NAME MAP: Claude Code's
    // "cacheCreation" is the DTO's cacheWriteTokens (Anthropic
    // cache_creation_input_tokens). When folding, these are already inside
    // inputTokens - adding the typed fields too would double-count, so omit them.
    if (!foldCache) {
      record.cacheReadTokens = cacheReadTokens;
      record.cacheWriteTokens = cacheCreationTokens;
    }

    // Dedup key when the watcher gave us the raw line. records.length
    // is the within-line index so two groups from one line never share a key.
    if (options.rawSourceLine !== undefined) {
      record.idempotencyKey = idempotencyKeyFor(
        options.rawSourceLine,
        group.email,
        group.rawModel,
        group.sessionId,
        records.length,
      );
    }

    records.push(record);
  }

  // The POST envelope; ingest expects { records: [...] }.
  return { records };
}

// --- CODEX LOG-ATTRIBUTE HELPERS -------------------------------
// Codex log attributes use a WIDER union than Claude's metric attributes: identity
// is stringValue, token counts are intValue (JSON string, protobuf int64) or
// doubleValue (JSON number). These dig the right type out; both default safely
// (undefined / 0) rather than throwing.

// Codex log record attribute list -> key -> value lookup.
function logAttributesToLookup(
  attributeList: OtlpLogAttribute[] | undefined,
): Record<string, OtlpAnyValue | undefined> {
  const lookup: Record<string, OtlpAnyValue | undefined> = {};
  if (!Array.isArray(attributeList)) return lookup;
  for (const attribute of attributeList) {
    if (attribute && typeof attribute.key === "string" && attribute.value) {
      lookup[attribute.key] = attribute.value;
    }
  }
  return lookup;
}

// Read a STRING attribute; non-string reads as undefined rather than crashing.
function logAttrString(value: OtlpAnyValue | undefined): string | undefined {
  if (value && typeof value.stringValue === "string") return value.stringValue;
  return undefined;
}

// Read a NUMERIC token-count attribute (intValue string-or-number, doubleValue, or
// a numeric stringValue). Missing/garbage -> 0, never NaN; mirrors dataPointTokenCount.
function logAttrTokenCount(value: OtlpAnyValue | undefined): number {
  if (value == null) return 0;
  if (value.intValue !== undefined && value.intValue !== null) {
    const parsed = parseInt(String(value.intValue), 10); // base-10 on purpose
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value.doubleValue !== undefined && value.doubleValue !== null) {
    const parsed = Math.round(Number(value.doubleValue)); // tokens are whole
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value.stringValue === "string") {
    const parsed = parseInt(value.stringValue, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// Is this log record a Codex usage event? Prefer the explicit event name, but fall
// back to "carries any token-count field" - codex.sse_event is the only Codex log
// that does, so this holds even if a version moves the name.
function isCodexUsageRecord(
  lookup: Record<string, OtlpAnyValue | undefined>,
  eventName: string | undefined,
): boolean {
  if (eventName === CODEX_USAGE_EVENT_NAME) return true;
  return CODEX_TOKEN_KEYS.some((key) => lookup[key] !== undefined);
}

// --- CODEX WEB SEARCH -------------------------------
// `codex exec --json` prints the raw model turn to the log record's body as a
// JSON string, with any web_search items nested somewhere inside at no fixed
// path - so we walk the whole tree rather than assume a shape, and dedupe by id
// since the same search can appear more than once (e.g. in-progress + completed).
function collectCodexWebSearchIds(
  value: unknown,
  seenIds: Set<string>,
  depth: number,
): void {
  if (depth > 25 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value)
      collectCodexWebSearchIds(entry, seenIds, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  // Codex proxies OpenAI's Responses API, whose web-search output item is typed
  // "web_search_call" (ws_ id). Do NOT collapse to one string: "web_search"
  // alone matches nothing real and bills a $10/1K metered search $0.
  if (
    (node.type === "web_search" || node.type === "web_search_call") &&
    typeof node.id === "string" &&
    node.id
  ) {
    seenIds.add(node.id);
  }
  for (const key of Object.keys(node)) {
    collectCodexWebSearchIds(node[key], seenIds, depth + 1);
  }
}

// Distinct web_search item ids in one log record's body; empty (never throws)
// if there are none or the body is missing/malformed. Returns the ids, not just
// a count, so the caller can dedupe ACROSS the several codex.sse_event records a
// single turn emits — the same ws_ id rides on response.output_item.added, .done
// AND response.completed, so per-record counting would bill one search 2-3×.
function extractCodexWebSearchIds(logRecord: OtlpLogRecord): string[] {
  const bodyText = logAttrString(logRecord.body);
  if (!bodyText) return [];
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const seenIds = new Set<string>();
  collectCodexWebSearchIds(parsedBody, seenIds, 0);
  return [...seenIds];
}

// --- THE CODEX TRANSLATOR --------------------------------------
// Codex OTel LOG records -> the same MarginFront usage records, with the accurate
// nested-token mapping.
//
// LOAD-BEARING: OpenAI's token counts are NESTED SUBSETS, not Anthropic's disjoint
// buckets. input_token_count is a THREE-WAY PARTITION of everything sent up:
//   input_token_count = cached_token_count      (served from prompt cache)
//                     + cache_write_token_count (written INTO the cache this turn)
//                     + fresh                   (neither - the remainder)
// and reasoning_token_count is INSIDE output_token_count. So
// "fold reasoning into output" would DOUBLE-COUNT reasoning, and billing
// input_token_count alongside either cache slice DOUBLE-COUNTS that slice - at the
// cache-write rate of 1.25x input that is a 2.25x over-bill, worse than the
// under-bill it would be fixing. The accurate mapping:
//   inputTokens      = input_token_count - cached - cache_write  (fresh input only)
//   cacheReadTokens  = cached_token_count                        (cache-read rate)
//   cacheWriteTokens = cache_write_token_count                   (cache-write rate)
//   outputTokens     = output_token_count                        (reasoning already in it)
//   reasoning/tool/cached/cache_write -> metadata ONLY (audit), never billed twice.
//
// cacheWriteTokens is set ONLY when the count is positive, never as a zero:
// api-nest flips any event with cacheWriteTokens > 0 against a pricing row whose
// cacheWriteCost is NULL to NEEDS_COST_BACKFILL with a null cost, so a zero on a
// pre-5.6 model (gpt-5.5 reports the field but always as 0, and has no write rate)
// would turn billed revenue into unbilled for nothing.
//
// options.foldCache (default false): the escape hatch for a Codex model whose cache
// rates aren't priced yet - bills the WHOLE input_token_count at the plain input
// rate and emits neither cache field, so no cache token can reach a row with no
// cache rate. Direction differs per slice: a ceiling for cached (input > cache-read)
// but a 20% FLOOR for the write slice, whose real rate is 1.25x input. Opt-in only,
// for exactly that reason.
//
// CUMULATIVE-VS-PER-EVENT: each codex.sse_event is
// treated as a PER-TURN snapshot, one record per event (the safe default; there
// is no cumulativetodelta for logs). A source that reported session-CUMULATIVE
// totals would need a per-session delta step where each event is mapped below.
export function buildCodexRequestBody(
  parsedOtlp: ParsedOtlp,
  options: BuildBodyOptions = {},
): RequestBody {
  const foldCache = options.foldCache === true;
  // Default to CODEX_NO_IDENTITY_CUSTOMER so a no-email Codex developer lands
  // under the Codex-branded placeholder, not the Claude one.
  const fallbackCustomerId =
    typeof options.fallbackCustomerId === "string" &&
    options.fallbackCustomerId.length > 0
      ? options.fallbackCustomerId
      : CODEX_NO_IDENTITY_CUSTOMER;

  // Per-developer attribution override (shared coding-agent login) - same role as in
  // the Claude builder: wins over the log's own user.email. Pure: passed in, never
  // read from the environment here. Unset => undefined => the log's own email is used.
  const developerOverride = options.developerOverride;

  const records: UsageRecord[] = [];
  const resourceLogsList = parsedOtlp?.resourceLogs;
  if (!Array.isArray(resourceLogsList)) return { records };

  for (const resourceLog of resourceLogsList) {
    const scopeLogsList = resourceLog?.scopeLogs;
    if (!Array.isArray(scopeLogsList)) continue;

    for (const scopeLog of scopeLogsList) {
      const logRecordsList = scopeLog?.logRecords;
      if (!Array.isArray(logRecordsList)) continue;

      for (const logRecord of logRecordsList) {
        const lookup = logAttributesToLookup(logRecord?.attributes);

        // The event name can be on event.name or in the body.
        const eventName =
          logAttrString(lookup["event.name"]) ?? logAttrString(logRecord?.body);
        // A *_result event is NEVER a token turn - skip here so a tool_result that
        // happens to carry a token-count attr can't be double-emitted as both a
        // token record (here) and a tool record (buildToolUsageRecords). Structural.
        if (toolResultSource(eventName) !== null) continue;
        if (!isCodexUsageRecord(lookup, eventName)) continue;

        // No model -> can't price it; skip rather than bill a phantom.
        const rawModel = logAttrString(lookup["model"]);
        if (!rawModel) continue;

        // Drop pseudo-models (e.g. codex-auto-review).
        if (CODEX_EXCLUDED_MODELS.has(rawModel.trim().toLowerCase())) continue;

        // Developer identity. PRECEDENCE: shared-login override first, then the log's
        // own user.email, then the placeholder. No email and no fallback -> skip.
        const email =
          developerOverride ||
          logAttrString(lookup["user.email"]) ||
          fallbackCustomerId;
        if (!email) continue;

        // Session id is best-effort metadata only; accept the common spellings
        // across Codex versions.
        const sessionId =
          logAttrString(lookup["session.id"]) ??
          logAttrString(lookup["conversation.id"]) ??
          logAttrString(lookup["session_id"]) ??
          null;

        const inputCount = logAttrTokenCount(lookup[CODEX_INPUT_TOKEN_KEY]);
        const outputCount = logAttrTokenCount(lookup[CODEX_OUTPUT_TOKEN_KEY]);
        const cachedCount = logAttrTokenCount(lookup[CODEX_CACHED_TOKEN_KEY]);
        const cacheWriteCount = logAttrTokenCount(
          lookup[CODEX_CACHE_WRITE_TOKEN_KEY],
        );
        const reasoningCount = logAttrTokenCount(
          lookup[CODEX_REASONING_TOKEN_KEY],
        );
        const toolCount = logAttrTokenCount(lookup[CODEX_TOOL_TOKEN_KEY]);

        // Empty-tick guard. cached and cache_write are subsets of input (input===0
        // implies both are 0); still test all three against malformed data.
        // cache_write is deliberately left OUT: a write with no input at all is
        // nonsense, and dropping it beats billing it.
        if (inputCount === 0 && outputCount === 0 && cachedCount === 0)
          continue;

        // CONSERVATION. The slices are carved OUT of input_token_count, so the billed
        // trio must never sum past it - unclamped, a turn reporting more slice than
        // input OVER-bills, fresh flooring at zero while both slices bill in full.
        // The WRITE slice absorbs the whole discrepancy and cached keeps precedence:
        // the write count is the newest and the dearest per token, so shrinking it
        // lands on the likeliest to be wrong and errs toward under-billing. Worked
        // example at real rates: test/codex-token-conservation.test.ts.
        const billableCacheRead = Math.min(cachedCount, inputCount);
        const billableCacheWrite = Math.min(
          cacheWriteCount,
          inputCount - billableCacheRead,
        );
        const cacheSlicesClamped =
          billableCacheRead !== cachedCount ||
          billableCacheWrite !== cacheWriteCount;

        // Non-negative by construction, so no floor: each subtrahend was already
        // capped against what remained of input.
        const freshInputTokens =
          inputCount - billableCacheRead - billableCacheWrite;

        // --fold-cache bills the whole input_token_count at the input rate (both
        // cache slices are already inside it); otherwise only the fresh portion is
        // billed and the slices ride in the typed cache fields below.
        const billedInputTokens = foldCache ? inputCount : freshInputTokens;

        const gitCoordinates =
          options.resolveGitCoordinates?.(sessionId) ?? null;

        const record: UsageRecord = {
          customerExternalId: email,
          agentCode: AGENT_CODE_CODEX,
          signalName: SIGNAL_NAME_CODEX,
          model: normalizeModelId(rawModel),
          modelProvider: MODEL_PROVIDER_CODEX,
          inputTokens: billedInputTokens,
          // Reasoning is ALREADY inside this number - do NOT add it again.
          outputTokens: outputCount,
          environment: ENVIRONMENT,
          // usageDate omitted so MarginFront defaults it to "now."
          metadata: {
            source: "codex",
            sessionId,
            rawModel,
            // Audit-only - nested inside input/output already, never added to the
            // billed tokens; recorded to prove we didn't drop anything.
            cachedTokens: cachedCount,
            ...(cacheWriteCount > 0
              ? { cacheWriteTokens: cacheWriteCount }
              : {}),
            ...(cacheSlicesClamped ? { cacheSlicesClamped: true } : {}),
            reasoningTokens: reasoningCount,
            toolTokens: toolCount,
            cacheFoldedIntoInput: foldCache,
            // Per-tool cap stamp. NEVER resolved here - resolving it
            // spawns a Codex process and this runs once per telemetry line. Omitted
            // when unset, so preview and one-shot send carry no stamp.
            ...(options.codexControlStamp ?? {}),
            // The job this machine's spend belongs to.
            ...(options.matterNumber ? { matterId: options.matterNumber } : {}),
            ...(gitCoordinates ?? {}),
          },
        };

        // DEFAULT path: each slice -> its own typed, server-priced field. Under
        // --fold-cache both are already inside inputTokens, so both are omitted (no
        // double-count). The positive-only test on the write is the revenue guard
        // described in the header - do not relax it to always-set.
        if (!foldCache) {
          record.cacheReadTokens = billableCacheRead;
          if (billableCacheWrite > 0) {
            record.cacheWriteTokens = billableCacheWrite;
          }
        }

        // Dedup key. Codex emits ONE record per log record, so two turns
        // for the same session in one flushed line are kept distinct by the
        // within-line index - without it they'd false-dedup.
        if (options.rawSourceLine !== undefined) {
          record.idempotencyKey = idempotencyKeyFor(
            options.rawSourceLine,
            email,
            rawModel,
            sessionId,
            records.length,
          );
        }

        records.push(record);
      }
    }
  }

  return { records };
}

// Classify an event name: a "tool actually ran" event and from which source, or
// null for anything we don't count (decisions, prompts, api_request, token events).
// Bare "tool_result" is Claude's short event.name.
function toolResultSource(
  eventName: string | undefined,
): "claude-code" | "codex" | null {
  if (!eventName) return null;
  if (eventName === CODEX_TOOL_RESULT_EVENT) return "codex";
  if (eventName === CLAUDE_TOOL_RESULT_EVENT || eventName === "tool_result") {
    return "claude-code";
  }
  return null;
}

// One accumulated tool group (who/session/source/tool + run count this flush).
// Local accumulator.
interface ToolGroup {
  email: string;
  sessionId: string | null;
  telemetrySource: "claude-code" | "codex";
  toolName: string;
  count: number;
}

// Reassemble the "mcp__server__tool" identity from Claude Code's tool_parameters
// attribute (present only under OTEL_LOG_TOOL_DETAILS=1). Returns null when the
// attribute is absent, malformed, or missing either name, so the caller keeps the
// bare "mcp_tool" bucket. Reads ONLY the two names - never the call's arguments.
function mcpNameFromToolParameters(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      mcp_server_name?: unknown;
      mcp_tool_name?: unknown;
    };
    const server = parsed.mcp_server_name;
    const tool = parsed.mcp_tool_name;
    if (
      typeof server === "string" &&
      server.length > 0 &&
      typeof tool === "string" &&
      tool.length > 0
    ) {
      return `mcp__${server}__${tool}`;
    }
  } catch {
    // Swallow: a malformed value just keeps the bare bucket. Never log or rethrow
    // the raw string or parsed value - tool_parameters can carry arguments and a
    // parse error must not leak them.
  }
  return null;
}

// --- THE TOOL TRANSLATOR ---------------------------------------
// Tool-call EVENTS on the log stream -> single-service tool records. Claude:
// claude_code.tool_result (needs OTEL_LOGS_EXPORTER=otlp); Codex: codex.tool_result.
// One executed call = one count; aggregate per (developer, session, source, tool)
// over the flush line and emit ONE record with quantity = count, tool NAME as the
// service id. No cost math here (pricing happens on the server) - we forward EVERY tool, no
// client-side drop-list (free built-ins have $0 catalog rows), and the
// catalog prices it (priced row -> quantity x unitPrice;
// none -> NEEDS_COST_BACKFILL, visible).
//
// Codex web search is a model-turn item on that same codex.sse_event
// record, never a local codex.tool_result - it feeds this same `groups` map
// through a separate extraction branch below instead of the tool_name path.
//
// WHY a sibling event, not folded into the token turn: token figure and tool events
// arrive on different channels/clocks with no shared per-turn id - merging needs a
// stateful correlator and reopens the exactly-once idempotency guarantee. Per-developer
// attribution is all this needs, so each tool line stands alone.
export function buildToolUsageRecords(
  parsedOtlp: ParsedOtlp,
  options: BuildBodyOptions = {},
): RequestBody {
  // Default to CODEX_NO_IDENTITY_CUSTOMER so a no-email developer whose tool
  // events arrive on the Codex logs stream lands under the Codex-branded
  // placeholder, not the Claude one.
  const fallbackCustomerId =
    typeof options.fallbackCustomerId === "string" &&
    options.fallbackCustomerId.length > 0
      ? options.fallbackCustomerId
      : CODEX_NO_IDENTITY_CUSTOMER;

  // Per-developer attribution override (shared coding-agent login). Wins over the
  // event's own user.email so a tool line is attributed to the same developer as that
  // machine's token turns. Pure: passed in, not read from the environment here.
  const developerOverride = options.developerOverride;

  const records: UsageRecord[] = [];
  const resourceLogsList = parsedOtlp?.resourceLogs;
  if (!Array.isArray(resourceLogsList)) return { records };

  const groups = new Map<string, ToolGroup>();

  // Web-search ids already counted per group this flush. A single server-side
  // search surfaces on multiple codex.sse_event records in one turn carrying the
  // same ws_ id; deduping across records (not just within one) bills it once.
  const webSearchSeenIds = new Map<string, Set<string>>();

  for (const resourceLog of resourceLogsList) {
    const scopeLogsList = resourceLog?.scopeLogs;
    if (!Array.isArray(scopeLogsList)) continue;
    for (const scopeLog of scopeLogsList) {
      const logRecordsList = scopeLog?.logRecords;
      if (!Array.isArray(logRecordsList)) continue;
      for (const logRecord of logRecordsList) {
        const lookup = logAttributesToLookup(logRecord?.attributes);
        const eventName =
          logAttrString(lookup["event.name"]) ?? logAttrString(logRecord?.body);
        const source = toolResultSource(eventName);

        // See the web-search note above; this record was never going to match
        // the tool_result branch below anyway.
        if (source === null && isCodexUsageRecord(lookup, eventName)) {
          const webSearchIds = logRecord
            ? extractCodexWebSearchIds(logRecord)
            : [];
          if (webSearchIds.length > 0) {
            const email =
              developerOverride ||
              logAttrString(lookup["user.email"]) ||
              fallbackCustomerId;
            if (email) {
              const sessionId =
                logAttrString(lookup["session.id"]) ??
                logAttrString(lookup["conversation.id"]) ??
                logAttrString(lookup["session_id"]) ??
                null;
              const groupKey = `${email}\n${sessionId ?? ""}\ncodex\n${CODEX_WEB_SEARCH_TOOL_NAME}`;
              let group = groups.get(groupKey);
              if (!group) {
                group = {
                  email,
                  sessionId,
                  telemetrySource: "codex",
                  toolName: CODEX_WEB_SEARCH_TOOL_NAME,
                  count: 0,
                };
                groups.set(groupKey, group);
              }
              let seen = webSearchSeenIds.get(groupKey);
              if (!seen) {
                seen = new Set<string>();
                webSearchSeenIds.set(groupKey, seen);
              }
              // Count only ids not already seen for this group so the same
              // search echoed across several sse_event records bills once.
              for (const id of webSearchIds) {
                if (!seen.has(id)) {
                  seen.add(id);
                  group.count += 1;
                }
              }
            }
          }
          continue;
        }

        if (!source) continue; // not a "tool actually ran" event

        // Tool name - Claude uses tool_name; try the fallbacks for Codex.
        let toolName: string | undefined;
        for (const key of TOOL_NAME_KEYS) {
          const candidate = logAttrString(lookup[key]);
          if (candidate) {
            toolName = candidate;
            break;
          }
        }
        if (!toolName) continue;

        // Claude Code's bare "mcp_tool" carries its real identity in tool_parameters
        // under OTEL_LOG_TOOL_DETAILS=1; recover the full name (names only, never args).
        if (toolName === "mcp_tool") {
          const mcpName = mcpNameFromToolParameters(
            logAttrString(lookup["tool_parameters"]),
          );
          if (mcpName) toolName = mcpName;
        }

        // WHO. PRECEDENCE: shared-login override first, then the event's own
        // user.email, then the placeholder. Else skip (can't attribute it).
        const email =
          developerOverride ||
          logAttrString(lookup["user.email"]) ||
          fallbackCustomerId;
        if (!email) continue;

        // Session id is metadata only; accept the common spellings.
        const sessionId =
          logAttrString(lookup["session.id"]) ??
          logAttrString(lookup["conversation.id"]) ??
          logAttrString(lookup["session_id"]) ??
          null;

        const groupKey = `${email}\n${sessionId ?? ""}\n${source}\n${toolName}`;
        let group = groups.get(groupKey);
        if (!group) {
          group = {
            email,
            sessionId,
            telemetrySource: source,
            toolName,
            count: 0,
          };
          groups.set(groupKey, group);
        }
        group.count += 1; // one tool_result event = one executed call
      }
    }
  }

  // Map iteration is insertion order, so records.length as the within-line index is
  // stable across a re-read - the idempotency key reproduces exactly on replay.
  for (const group of groups.values()) {
    if (group.count === 0) continue;
    const isCodex = group.telemetrySource === "codex";
    const gitCoordinates =
      options.resolveGitCoordinates?.(group.sessionId) ?? null;
    const record: UsageRecord = {
      customerExternalId: group.email,
      agentCode: isCodex ? AGENT_CODE_CODEX : AGENT_CODE,
      signalName: isCodex ? SIGNAL_NAME_TOOL_CODEX : SIGNAL_NAME_TOOL,
      // Raw tool NAME as the service id, verbatim - NOT through normalizeModelId
      // (that's Claude-LLM-name-specific). Catalog matches (model=tool name,
      // modelProvider="tool").
      model: group.toolName,
      modelProvider: MODEL_PROVIDER_TOOL,
      // Billing volume = times this tool fired this flush; no token fields (not an
      // LLM turn). Server prices quantity x unitPrice.
      quantity: group.count,
      environment: ENVIRONMENT,
      metadata: {
        source: "tool",
        sessionId: group.sessionId,
        toolName: group.toolName,
        telemetrySource: group.telemetrySource,
        estimated: true,
        // The job this machine's spend belongs to.
        ...(options.matterNumber ? { matterId: options.matterNumber } : {}),
        ...(gitCoordinates ?? {}),
      },
    };

    // Dedup key. The model component is namespaced with a "tool:"
    // sentinel so a tool record's key can NEVER collide with a token record's on the
    // same line (structurally, not by convention) - otherwise the server's
    // exactly-once dedup could silently DROP one as a false duplicate, under-counting.
    if (options.rawSourceLine !== undefined) {
      record.idempotencyKey = idempotencyKeyFor(
        options.rawSourceLine,
        group.email,
        `tool:${group.toolName}`,
        group.sessionId,
        records.length,
      );
    }

    records.push(record);
  }

  return { records };
}

// The finished-work arm of the metadata union has no session of its own, so this is
// the one place that narrows for it.
export function recordSessionId(record: UsageRecord): string | null {
  const metadata = record.metadata;
  return "sessionId" in metadata && typeof metadata.sessionId === "string"
    ? metadata.sessionId
    : null;
}

// THE ONE PARTITION SITE, and it runs AFTER the builders on purpose: they use their
// own records.length as the within-line index of an idempotency key, so dropping a
// record earlier would renumber every record behind it and a replay of the line would
// land as brand new work.
//
// The verdict comes from the repo the record ALREADY CARRIES, never a second git read.
// Two reads can disagree, and the only direction that breaks is a record going out
// stamped with the repo name the rule was set to keep in. Fail-open by construction:
// no list, no repo stamped, or a repo nobody named, and everything passes through.
export function dropRecordsFromIgnoredRepos(
  records: UsageRecord[],
  ignored: Set<string> | undefined,
): UsageRecord[] {
  if (!ignored || ignored.size === 0) return records;
  return records.filter((record) => {
    const repo = stampedRepo(record);
    return !(repo !== null && ignored.has(repo.toLowerCase()));
  });
}

// readQueue casts every parsed queue line to this type, so a line truncated by a crash
// mid-append reaches here as a number, a string, or null. A line that names no repo
// goes out unchanged (fail-open) rather than throwing and wedging the whole drain.
function stampedRepo(record: UsageRecord): string | null {
  const metadata = (record as unknown as { metadata?: unknown } | null)
    ?.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const repo = (metadata as { repo?: unknown }).repo;
  return typeof repo === "string" ? repo : null;
}

// --- THE SHAPE-DETECTING DISPATCHER ----------------------------
// Both sources write the SAME file, one JSON doc per line: a Claude line is metrics
// (resourceMetrics), a Codex line is logs (resourceLogs). Routing by tree lets one
// watcher handle Claude-only / Codex-only / both with no mode flag - the developer
// picks the mode by which source(s) they turn on.
export function buildRequestBodyForLine(
  parsedOtlp: ParsedOtlp,
  options: BuildBodyOptions = {},
): RequestBody {
  if (parsedOtlp && Array.isArray(parsedOtlp.resourceLogs)) {
    // A logs line can carry Codex TOKEN usage (codex.sse_event) AND/OR TOOL-call
    // events from either source. Run both readers and concatenate -
    // they don't overlap: the token reader only matches codex.sse_event/*_count
    // keys, the tool reader only matches *_result events.
    //
    // The CLI always passes NO_IDENTITY_CUSTOMER ("claude-code-no-identity")
    // as the explicit fallback. Without this substitution that value would override the
    // Codex builders' own CODEX_NO_IDENTITY_CUSTOMER default, putting Codex developers
    // under the Claude-branded placeholder. Swap it here so the Codex-specific
    // placeholder is used while a custom caller-supplied fallback passes through unchanged.
    const codexOptions: BuildBodyOptions =
      options.fallbackCustomerId === NO_IDENTITY_CUSTOMER
        ? { ...options, fallbackCustomerId: CODEX_NO_IDENTITY_CUSTOMER }
        : options;
    const tokenBody = buildCodexRequestBody(parsedOtlp, codexOptions);
    const toolBody = buildToolUsageRecords(parsedOtlp, codexOptions);
    return {
      records: dropRecordsFromIgnoredRepos(
        [...tokenBody.records, ...toolBody.records],
        codexOptions.ignoredRepos,
      ),
    };
  }
  const body = buildMarginFrontRequestBody(parsedOtlp, options);
  const kept = dropRecordsFromIgnoredRepos(body.records, options.ignoredRepos);
  return kept === body.records ? body : { records: kept };
}

// --- READING + PARSING A SINGLE OTLP/JSON FILE (--dry-run, one-shot send) ---
export function readAndParseOtlpFile(inputFilePath: string): ParsedOtlp {
  if (!existsSync(inputFilePath)) {
    console.error(
      `Could not read/parse ${inputFilePath}: file does not exist. Check the path and try again.`,
    );
    process.exit(1);
  }

  let fileText: string;
  try {
    fileText = readFileSync(inputFilePath, "utf8");
  } catch (readError) {
    console.error(
      `Could not read/parse ${inputFilePath}: ${(readError as Error).message}`,
    );
    process.exit(1);
  }

  try {
    return JSON.parse(fileText);
  } catch {
    // SECURITY: generic reason only - never echo file content (Node's JSON error
    // quotes a fragment of the offending file).
    console.error(
      `Could not read/parse ${inputFilePath}: the file is not valid JSON. ` +
        "Make sure it is an OTLP/JSON export line (Claude Code metrics or Codex " +
        "logs), not raw text.",
    );
    process.exit(1);
  }
}

// --- THE ACTUAL SEND - returns a result, never exits, so it works in a loop. --
export async function postToMarginFront(
  requestBody: RequestBody,
  serverUrl?: string,
): Promise<PostResult> {
  const apiKey = process.env.MARGINFRONT_API_KEY;
  // Callers must ensure the key exists before getting here; this is a backstop.
  if (!apiKey) {
    return { ok: false, reason: "no-key" };
  }

  // Resolved at every send, so the settings file (copied into the environment at
  // startup) is always what decides where usage goes. A missing or unsafe address
  // is terminal - the same value won't start passing on a retry.
  const server = resolveConfiguredServer(process.env, serverUrl);
  if (!server.ok) {
    console.error(`Usage not sent. ${server.problem}`);
    return { ok: false, reason: "blocked-url" };
  }

  let response: Response;
  try {
    response = await sendToServer(
      server.baseUrl,
      usageRecordUrl(server.baseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // MarginFront authenticates with x-api-key, NOT Bearer/Authorization.
          "x-api-key": apiKey,
          // This User-Agent is what lets the server tag these events as source='ccc'
          // instead of the generic 'api' fallback. Without it, server-side analytics dashboards
          // can't tell cost-meter traffic from raw API clients - every cost-meter
          // event would be mislabelled as source='api'.
          "User-Agent": `@marginfront/code-cost-clarity/${CCC_PACKAGE_VERSION}`,
        },
        body: JSON.stringify(requestBody),
      },
    );
  } catch (networkError) {
    return {
      ok: false,
      reason: "network",
      message: (networkError as Error).message,
    };
  }

  const responseText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      reason: "http",
      status: response.status,
      body: responseText,
    };
  }

  let parsed: IngestResponse | null = null;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = null;
  }
  return { ok: true, parsed, body: responseText };
}

// Pull the per-record success rows (eventId + totalCostUsd) out of a response.
function successRowsFrom(parsed: IngestResponse | null): IngestSuccessRow[] {
  const rows = parsed?.results?.success;
  return Array.isArray(rows) ? rows : [];
}

// --- KEY VALIDATION + AUTH-HOLD PROBE ---------------------------

// Both fetches below carry explicit timeouts. Nothing else in this package sets
// one, and Node's default undici headers timeout is 300 seconds - a captive-portal
// wifi that completes the TCP handshake and never answers would hang init for five
// minutes at its very first step. An abort is "could not check", never a rejection.
const KEY_CHECK_TIMEOUT_MS = 8_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;

function keyCheckHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    Accept: "application/json",
    "User-Agent": `@marginfront/code-cost-clarity/${CCC_PACKAGE_VERSION}`,
  };
}

// Ask GET /v1/me/key what kind of key this is. A 200 with an unreadable body still
// returns ok with keyType null: the route requires auth, so a 200 alone proves the
// key authenticates, and a server that omits keyType must not deadlock a
// valid key. Never logs or returns the key itself.
export async function probeKeyIdentity({
  apiKey,
  serverUrl,
  fetchImpl = fetch,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS,
}: {
  apiKey: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AuthProbeResult> {
  const server = resolveConfiguredServer(process.env, serverUrl);
  if (!server.ok) {
    return { ok: false, reason: "network" };
  }
  let response: Response;
  try {
    response = await sendToServer(
      server.baseUrl,
      keyIdentityUrl(server.baseUrl),
      {
        headers: keyCheckHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      },
      fetchImpl,
    );
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!response.ok) {
    return { ok: false, reason: "http", status: response.status };
  }
  let keyType: "secret" | "publishable" | null = null;
  let role: string | null = null;
  try {
    const body = (await response.json()) as {
      keyType?: unknown;
      role?: unknown;
    };
    if (body.keyType === "secret" || body.keyType === "publishable") {
      keyType = body.keyType;
    }
    if (typeof body.role === "string") role = body.role;
  } catch {
    // Unreadable body on a 200: the key authenticates, the type is unknown.
  }
  return { ok: true, keyType, role };
}

// init's validation gate: GET /v1/verify for the org echo, then GET /v1/me/key for
// the key TYPE. Two calls because /v1/verify alone waves a publishable key through
// (the server's write guard only blocks POSTs), which would print a green
// "Connected to ..." for the single most common wrong-key paste and then 403 on
// every send forever. Only an authoritative bad answer rejects - see KeyCheckResult.
export async function checkKeyWithServer({
  apiKey,
  serverUrl,
  fetchImpl = fetch,
  timeoutMs = KEY_CHECK_TIMEOUT_MS,
}: {
  apiKey: string;
  serverUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<KeyCheckResult> {
  const server = resolveConfiguredServer(process.env, serverUrl);
  if (!server.ok) {
    return { ok: false, reason: "unreachable", message: server.problem };
  }
  let response: Response;
  try {
    response = await sendToServer(
      server.baseUrl,
      keyCheckUrl(server.baseUrl),
      {
        headers: keyCheckHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      },
      fetchImpl,
    );
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      message: (err as Error).message,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected", status: response.status };
  }
  if (response.status === 404) {
    return { ok: false, reason: "wrong-address", serverUrl: server.baseUrl };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "unreachable",
      message: `the server answered HTTP ${response.status}`,
    };
  }
  let organizationName = "";
  try {
    const body = (await response.json()) as {
      organization?: { name?: unknown };
    };
    const name = body?.organization?.name;
    if (typeof name === "string" && name.length > 0) organizationName = name;
  } catch {
    // Fall through to the unreadable-answer branch below.
  }
  if (!organizationName) {
    return {
      ok: false,
      reason: "unreachable",
      message: "the server's answer didn't include an organization name",
    };
  }
  const identity = await probeKeyIdentity({
    apiKey,
    serverUrl: server.baseUrl,
    fetchImpl,
    timeoutMs,
  });
  if (identity.ok && identity.keyType === "publishable") {
    return { ok: false, reason: "publishable", organizationName };
  }
  return {
    ok: true,
    organizationName,
    keyType: identity.ok ? identity.keyType : null,
  };
}

// --- RESUME CURSOR - how the watcher remembers where it stopped ------------
// The file exporter only ever APPENDS (no rotation/truncation; deleted only by
// `uninstall`). Reading from the top each run would re-POST the prior session on a
// stop-then-`run` and DOUBLE-COUNT (one event per POST, no server dedup). So we
// persist a BYTE OFFSET to a tiny cursor file: it lets each poll read only the NEW
// tail (not re-scan the whole file) and survives a restart.

// Read the saved byte offset (0 when there's no cursor yet or it's unreadable).
export function readWatchCursor(cursorPath: string | undefined): number {
  if (!cursorPath || !existsSync(cursorPath)) return 0;
  try {
    const parsed = parseInt(readFileSync(cursorPath, "utf8").trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

// Save the byte offset. Best-effort: a failed write just means the next run
// might re-read a little - never a crash.
export function writeWatchCursor(
  cursorPath: string | undefined,
  byteOffset: number,
): void {
  if (!cursorPath) return;
  try {
    writeFileSync(cursorPath, String(byteOffset));
  } catch {
    /* best effort; resume degrades gracefully if we can't persist */
  }
}

// Read the bytes AFTER `fromByte` and return the COMPLETE lines there plus the
// offset past the last one (what to persist). A trailing PARTIAL line (still being
// written, no newline yet) is left unconsumed - nextCursor stops at the last
// newline so it's re-read complete next poll. A file now SMALLER than the cursor was
// truncated/replaced, so read from the top. At most `maxBytes` are read per call;
// a backlog drains over several calls. Pure + exported for unit testing.
export function readNewCompleteLines(
  filePath: string,
  fromByte: number,
  limits: ReadLimits = {},
): ReadLinesResult {
  const maxBytes = limits.maxBytes ?? MAX_TAIL_BYTES_PER_TICK;
  const maxLineBytes = limits.maxLineBytes ?? bufferConstants.MAX_STRING_LENGTH;
  if (!existsSync(filePath)) return { lines: [], nextCursor: fromByte };

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { lines: [], nextCursor: fromByte };
  }

  let start = fromByte;
  if (size < start) start = 0; // file shrank -> treat as new, read from the top
  if (size === start) return { lines: [], nextCursor: start }; // nothing new

  const unreadBytes = size - start;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const window = readBytesAt(fd, start, Math.min(unreadBytes, maxBytes));
    // Find the LAST newline by BYTE. A newline (0x0A) is never part of a multibyte
    // UTF-8 character, so this is always a clean boundary - we won't split a char.
    const lastNewline = window.lastIndexOf(0x0a);
    if (lastNewline !== -1) {
      return {
        lines: splitCompleteLines(window.subarray(0, lastNewline + 1)),
        nextCursor: start + lastNewline + 1,
        unreadBytes,
      };
    }

    // No newline in the window: either a partial line still being written, or
    // one line longer than the cap. Find where that one line ends.
    const lineEnd = findNextNewline(fd, start + window.length, size, maxBytes);
    if (lineEnd === -1) return { lines: [], nextCursor: start, unreadBytes };

    const lineBytes = lineEnd + 1 - start;
    if (lineBytes > maxLineBytes) {
      return {
        lines: [],
        nextCursor: lineEnd + 1,
        unreadBytes,
        skippedLineBytes: lineBytes,
      };
    }
    const whole = readBytesAt(fd, start, lineBytes);
    const newline = whole.lastIndexOf(0x0a);
    if (newline === -1) return { lines: [], nextCursor: start, unreadBytes };
    return {
      lines: splitCompleteLines(whole.subarray(0, newline + 1)),
      nextCursor: start + newline + 1,
      unreadBytes,
    };
  } catch {
    return { lines: [], nextCursor: fromByte };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readBytesAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// Scans forward in fixed-size chunks so an enormous line costs one chunk of
// memory to locate, not the whole line.
function findNextNewline(
  fd: number,
  from: number,
  size: number,
  chunkBytes: number,
): number {
  const chunk = Buffer.alloc(Math.max(1, Math.min(chunkBytes, size - from)));
  let position = from;
  while (position < size) {
    const bytesRead = readSync(
      fd,
      chunk,
      0,
      Math.min(chunk.length, size - position),
      position,
    );
    if (bytesRead === 0) break;
    const index = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (index !== -1) return position + index;
    position += bytesRead;
  }
  return -1;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function splitCompleteLines(completeBytes: Buffer): string[] {
  const parts = completeBytes.toString("utf8").split("\n");
  parts.pop(); // last element is "" (the bytes end in the final newline)
  return parts;
}

// --- DURABLE RETRY QUEUE -------------------------------
// The "never silently drop a failed send" half of exactly-once. A transient POST
// failure (network/429/5xx) parks the record(s) on disk before the cursor advances
// past them, and the watcher retries each poll; dropping them would under-count. The server dedup makes a "landed but response lost, then retried" case
// a no-op, so at-least-once delivery x idempotent server = each turn lands once.

// Cap so a long outage can't grow the queue unbounded. At the cap the newest
// overflow is shed WITH A LOUD LOG (never silently). 10k is generous for this meter.
const MAX_QUEUE_RECORDS = 10_000;
// Ingest accepts up to 100 records per POST (RecordUsageDto), so drain in batches.
const MAX_RECORDS_PER_DRAIN = 100;
// Bounded exponential backoff between drains so a sustained outage doesn't hammer
// the endpoint; reset to the floor on any success.
const QUEUE_BACKOFF_START_MS = 2_000;
const QUEUE_BACKOFF_MAX_MS = 60_000;

// Split one line's records into bodies the server will accept. A single 5-minute
// flush can exceed the 100-record POST cap because EVERY tool event is forwarded.
// An oversized body is a 400 - TERMINAL, not retryable - which would
// drop the whole line's spend. Order-preserving; exported for unit testing.
export function splitIntoPostBatches(
  records: UsageRecord[],
  maxPerPost: number = MAX_RECORDS_PER_DRAIN,
): RequestBody[] {
  const batches: RequestBody[] = [];
  for (let start = 0; start < records.length; start += maxPerPost) {
    batches.push({ records: records.slice(start, start + maxPerPost) });
  }
  return batches;
}

// COLLECTOR SELF-HEAL backoff. After we revive a dead collector we won't
// try again for this long - win or lose. Without it, a collector that crashes the
// instant it starts would be respawned every poll (once a second) forever: a tight
// crash-loop that floods the logs and the process table. 30s is short enough that a
// genuinely-dead collector is back fast (so spend capture barely skips a beat) but
// long enough that a sick one can't spin us.
const COLLECTOR_REVIVE_BACKOFF_MS = 30_000;

// The two things the self-heal step needs from the outside world, injected so it can
// be unit-tested without spawning a real collector or reading a real pidfile:
//   - isCollectorAlive(): in production, probe the collector pidfile.
//   - reviveCollector():  in production, startCollector() (which itself no-ops if the
//                         collector is somehow already up - defense in depth).
//   - now():              wall-clock ms; injected so a test can drive the backoff
//                         window deterministically instead of sleeping.
//   - log():              where the one-line warning goes (defaults to console.error).
export interface CollectorHealDeps {
  isCollectorAlive: () => boolean;
  reviveCollector: () => void;
  now: () => number;
  log?: (message: string) => void;
}

// DECIDE-AND-ACT for one poll tick.
//
// WHY THIS EXISTS, in plain English: the collector is the thing that actually writes
// down every dollar of model usage. It runs as its own detached process, invisible to
// the launchd daemon that babysits the forwarder. So if the collector dies but the
// forwarder keeps running, the forwarder would happily poll a file that never grows
// again - no error, no crash, just spend silently going uncounted. For a tool whose
// one job is to never under-count, that's the worst possible failure. This check, run
// every tick, notices the collector is gone and brings it back.
//
// CONTRACT: if the collector is alive, or we revived it too recently (inside the
// backoff window), this does nothing and returns nextReviveAllowedAt unchanged. If the
// collector is dead AND we're past the window, it revives once and returns the next
// timestamp at which another revive is allowed. The caller threads that return value
// back in on the following tick - that one number IS the backoff state.
export function maybeReviveCollector(
  deps: CollectorHealDeps,
  nextReviveAllowedAt: number,
  backoffMs: number,
): number {
  // Healthy collector - the overwhelmingly common case. Do nothing, change nothing.
  if (deps.isCollectorAlive()) return nextReviveAllowedAt;

  // Collector is down. Are we still inside the cool-off window from a recent revive?
  const now = deps.now();
  if (now < nextReviveAllowedAt) return nextReviveAllowedAt;

  const log = deps.log ?? console.error;
  // Arm the next window BEFORE attempting the revive, so that even if reviveCollector
  // throws (binary missing, spawn refused), we still wait a full window before the
  // next attempt. This is what stops a sick collector from spinning us tick-after-tick.
  const updatedReviveAllowedAt = now + backoffMs;
  log("collector was down, restarted it");
  try {
    deps.reviveCollector();
  } catch (err: unknown) {
    log(`collector revive attempt failed: ${(err as Error).message}`);
  }
  return updatedReviveAllowedAt;
}

// Is a failed POST worth retrying? TRANSIENT (network down, 429, 5xx) can succeed
// later -> queue. TERMINAL (other 4xx, or missing key) never will -> drop.
// 404 queues too: ingest never answers 404 for a record, so a 404 means the saved
// server address is wrong (usually missing /v1), and dropping would lose every
// record until someone noticed. Pure + exported for unit testing.
export function isRetryablePostResult(result: PostResult): boolean {
  if (result.ok) return false;
  if (result.reason === "network") return true; // transient by nature
  if (result.reason === "no-key") return false; // config error, retry won't help
  if (result.reason === "http") {
    return (
      result.status === 404 || result.status === 429 || result.status >= 500
    );
  }
  return false;
}

// A 401/403 from ingest = the KEY is dead, not the request. Neither retryable nor
// terminal: the watcher enters an auth hold (parks the batch, probes for recovery)
// BEFORE the retryable question is ever asked, so this classifier changes nothing
// about how genuine 400s drop. Type predicate so callers can read result.status.
export function isAuthFailurePostResult(
  result: PostResult,
): result is { ok: false; reason: "http"; status: number; body: string } {
  return (
    !result.ok &&
    result.reason === "http" &&
    (result.status === 401 || result.status === 403)
  );
}

// Read every queued record, skipping any unparseable line (a partial line from a
// crash mid-append shouldn't wedge the drain). [] when there's no path/file yet.
export function readQueue(queuePath: string | undefined): UsageRecord[] {
  if (!queuePath || !existsSync(queuePath)) return [];
  let text: string;
  try {
    text = readFileSync(queuePath, "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as UsageRecord);
    } catch {
      // Drop the one corrupt line, keep draining the rest.
    }
  }
  return out;
}

// Queue depth without parsing: `status` calls this interactively and a full queue
// is 10k JSON lines - counting non-empty lines answers "how many are waiting"
// without 10k JSON.parse calls. 0 when there's no path/file.
export function countQueueRecords(queuePath: string | undefined): number {
  if (!queuePath || !existsSync(queuePath)) return 0;
  let text: string;
  try {
    text = readFileSync(queuePath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

// Append records to the queue durably (one JSON record per line). Best-effort, but
// the append happens BEFORE the cursor advances (see the watcher), so a crash first
// just re-reads the line next run (at-least-once). No-op with no path/records.
export function appendToQueue(
  queuePath: string | undefined,
  records: UsageRecord[],
): void {
  if (!queuePath || records.length === 0) return;
  const payload = records.map((r) => JSON.stringify(r) + "\n").join("");
  try {
    appendFileSync(queuePath, payload);
  } catch {
    /* best effort; the record is still in the live file until the cursor moves */
  }
}

// Overwrite the queue with exactly these records (after a partial drain, the ones
// that haven't landed). Empty list -> remove the file so no stale file lingers.
export function writeQueue(
  queuePath: string | undefined,
  records: UsageRecord[],
): void {
  if (!queuePath) return;
  try {
    if (records.length === 0) {
      if (existsSync(queuePath)) rmSync(queuePath, { force: true });
      return;
    }
    writeFileSync(
      queuePath,
      records.map((r) => JSON.stringify(r) + "\n").join(""),
    );
  } catch {
    /* best effort; a failed rewrite just means we retry the same records again */
  }
}

// Re-reads rather than rewriting from the copy taken before the POST: the `done`
// command appends from its own process, and a record landing during that await would be
// erased by such a rewrite. Position is exact only because every other writer
// appends - the drained records are still the first `drained` lines.
export function dropDrainedPrefix(
  queuePath: string | undefined,
  drained: number,
): number {
  if (!queuePath) return 0;
  const onDisk = readQueue(queuePath);
  const remaining = onDisk.slice(Math.min(drained, onDisk.length));
  writeQueue(queuePath, remaining);
  return remaining.length;
}

// --- WHICH ASSISTANT WAS LAST SEEN ---------------
// On a machine with both installed, the `done` command has to name one. The honest answer is
// whichever has been working, and only the watcher knows: it reads the telemetry.

// The two agent codes a finished thing may claim. A tool record carries the same
// pair, so a tool call counts as "this assistant was working" exactly like a turn.
const KNOWN_AGENT_CODES = new Set([AGENT_CODE, AGENT_CODE_CODEX]);

export function lastAgentInRecords(records: UsageRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (KNOWN_AGENT_CODES.has(records[i].agentCode))
      return records[i].agentCode;
  }
  return null;
}

export function readLastAgentSeen(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const value = readFileSync(path, "utf8").trim();
    return KNOWN_AGENT_CODES.has(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastAgentSeen(
  path: string | undefined,
  agentCode: string,
): void {
  if (!path || !KNOWN_AGENT_CODES.has(agentCode)) return;
  try {
    writeFileSync(path, `${agentCode}\n`);
  } catch {
    /* best effort; done falls back to asking for --agent */
  }
}

// --- AUTH HOLD -------------------------------------
// A 401/403 from ingest means every further POST fails the same way until the KEY
// changes - retrying is hammering, dropping is destroying a customer's usage data.
// So the watcher holds: batches park in the durable queue, a bounded probe asks
// GET /v1/me/key every few minutes, and a working answer drains the backlog. The
// hold persists to disk so a launchd KeepAlive respawn resumes it.

// How often the held daemon asks whether the key works again (ms).
const AUTH_PROBE_INTERVAL_MS = 5 * 60 * 1000;

// Non-reversible identity for "which key is this hold about". First 8 hex of a
// sha256 - deliberately NOT maskApiKey output, which keeps 20 readable characters
// of the key. A daemon that starts with a different fingerprint drops the hold.
export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
}

// Read the persisted hold. Anything unreadable - missing file, torn JSON, a shape
// missing a required field - reads as "not held": a corrupt marker must never
// wedge the daemon into a hold no probe recovery would clear correctly.
export function readAuthHold(
  holdPath: string | undefined,
): AuthHoldState | null {
  if (!holdPath || !existsSync(holdPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(holdPath, "utf8")) as AuthHoldState;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.since === "string" &&
      typeof parsed.lastStatus === "number" &&
      typeof parsed.keyFingerprint === "string"
    ) {
      return {
        since: parsed.since,
        lastStatus: parsed.lastStatus,
        keyFingerprint: parsed.keyFingerprint,
        lastProbeAt:
          typeof parsed.lastProbeAt === "string" ? parsed.lastProbeAt : null,
      };
    }
  } catch {
    // Fall through to null.
  }
  return null;
}

// Persist the hold via temp + rename so `status` can never read a torn file.
// Best-effort: with no path (or a failed write) the hold still lives in memory.
export function writeAuthHold(
  holdPath: string | undefined,
  state: AuthHoldState,
): void {
  if (!holdPath) return;
  try {
    const tmp = `${holdPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, holdPath);
  } catch {
    /* best effort */
  }
}

export function clearAuthHold(holdPath: string | undefined): void {
  if (!holdPath) return;
  try {
    rmSync(holdPath, { force: true });
  } catch {
    /* best effort */
  }
}

// Does this probe answer end the hold? Only a 200 from a NON-publishable key. A
// publishable key passes GETs (the write guard blocks POSTs only), so an ok-only
// check would clear the hold, drain, 403, and re-enter it - a permanent thrash
// loop that never empties the queue. keyType null still recovers: a server
// that omits the field must not deadlock a valid key.
export function authHoldRecovers(result: AuthProbeResult): boolean {
  return result.ok && result.keyType !== "publishable";
}

// What the probe rider needs from the watcher, injected so the cadence can be
// unit-tested by driving a fake clock instead of holding a daemon for an hour.
export interface AuthRecoveryProbeDeps {
  probe: () => Promise<AuthProbeResult>;
  // The hold is over: clear it and let the next tick drain the queue.
  onRecovered: () => void;
  // Probe answered but the key still doesn't work (or the probe threw: null).
  onStillHeld: (result: AuthProbeResult | null) => void;
  monotonicNow: () => number;
  isInFlight: () => boolean;
  setInFlight: (inFlight: boolean) => void;
}

// DECIDE-AND-PROBE for one poll tick while held, shaped like maybeReviveCollector:
// the caller threads the returned next-allowed timestamp back in - that one number
// IS the cadence state. Single-flight via the in-flight flag; the next window is
// armed BEFORE the await so a throwing or hanging probe still waits a full
// interval. Throttled on the MONOTONIC clock: a wall clock corrected backwards
// would otherwise park the next probe hours out while the hold persists.
export function maybeProbeAuthRecovery(
  deps: AuthRecoveryProbeDeps,
  nextProbeAllowedAt: number,
  intervalMs: number,
): number {
  if (deps.isInFlight()) return nextProbeAllowedAt;
  const now = deps.monotonicNow();
  if (now < nextProbeAllowedAt) return nextProbeAllowedAt;

  deps.setInFlight(true);
  const nextAllowed = now + intervalMs;
  void deps
    .probe()
    .then((result) => {
      if (authHoldRecovers(result)) deps.onRecovered();
      else deps.onStillHeld(result);
    })
    .catch(() => deps.onStillHeld(null))
    .finally(() => deps.setInFlight(false));
  return nextAllowed;
}

// --- LIVE WATCHER: tail the Collector's JSONL file, send each new tick ------
// The file exporter writes one JSON object per line and only APPENDS. We keep a
// BYTE cursor (persisted via options.cursorPath), read only the new tail each poll,
// and POST each complete line. Resuming from the cursor is what stops a
// stop-then-`run` re-sending the prior session. Relies on the collector emitting
// DELTA temporality so each tick is already an increment. Returns a stop() fn.
export function watchAndForward(
  filePath: string,
  options: WatchOptions = {},
): () => void {
  const foldCache = options.foldCache === true;
  const fallbackCustomerId = options.fallbackCustomerId;
  const cursorPath = options.cursorPath;
  // Single-instance guard pidfile: written below once we know we have a
  // key (so a failed startup doesn't falsely claim the slot), removed in stop().
  const pidFilePath = options.pidFilePath;

  // PER-DEVELOPER ATTRIBUTION (shared coding-agent login). Resolve the override ONCE
  // here, straight from the environment - the same way MARGINFRONT_API_KEY is read
  // just below - and thread it into every build call so the builders stay pure (they
  // never touch process.env or git). resolveDeveloperOverride owns the env -> value
  // rule (trim, empty/whitespace => undefined => the telemetry's own email). See
  // CCC_DEVELOPER_EMAIL in the .env template renderEnvTemplate writes.
  const developerOverride = resolveDeveloperOverride(process.env);

  // WORK ITEM ID. Deliberately NOT the once-per-daemon resolve the three
  // settings above use: this one is re-read per line so an edited settings file reaches
  // the next record with no `stop` and `start`. See createWorkIdReader.
  const lastAgentPath = options.lastAgentPath;
  let lastAgentStamped: string | null = readLastAgentSeen(lastAgentPath);

  const readWorkId = createWorkIdReader({
    envPath: options.matterEnvPath,
    // Deliberately not process.env: cmdRun copied this very file into it at startup,
    // so a deleted line would come back from that copy. See WatchOptions.matterEnv.
    env: options.matterEnv ?? {},
  });

  // REPOS THIS MACHINE NEVER SENDS FROM. Same per-line re-read behind the same
  // modified-time guard, for the same reason: adding a repo to the list has to take
  // effect on the next record, not after a `stop` and a `start` on a meter nobody
  // can see.
  const readIgnoredRepos = createIgnoredReposReader({
    envPath: options.matterEnvPath,
  });

  // CACHE-WRITE TTL. Same once-per-daemon resolve-and-thread
  // pattern as developerOverride, from CCC_CACHE_WRITE_TTL.
  const cacheWriteTtl = resolveCacheWriteTtl(process.env);

  // COST-PER-PR ATTRIBUTION. One resolver for the daemon's lifetime,
  // threaded into every build the same way developerOverride is. It caches each
  // session's cwd but reads repo/branch/SHA fresh per flush, so the builders stay
  // pure and a mid-session branch switch can't pair a fresh SHA with a stale branch.
  const resolveGitCoordinates =
    options.gitCoordinatesResolver ?? createGitCoordinatesResolver();

  // CONTROL. Resolve the armed stamp once (same resolve-and-thread
  // pattern) - undefined unless the opt-in cap-check hook is installed, in which case
  // it rides Claude turn metadata so the dashboard can count armed developers.
  const controlArmed = resolveControlArmedStamp();

  // CONTROL per-tool truth. The per-line path reads these variables
  // and nothing else: no spawn per event, and no file read per event either,
  // because a syscall per line is as wrong as a spawn per line.
  // The seams default to the real implementations and exist so a test can
  // COUNT calls instead of inferring them from where the source happens to sit.
  const readCodexTrust =
    options.codexTrustDeps?.readCache ?? readCodexTrustCache;
  const writeCodexTrust =
    options.codexTrustDeps?.writeCache ?? writeCodexTrustCache;
  const resolveCodexTrust =
    options.codexTrustDeps?.resolveStatus ?? resolveCodexControlStatus;
  const monotonicNow = options.codexTrustDeps?.monotonicNow ?? monotonicNowMs;
  const wallNow = options.codexTrustDeps?.wallNow ?? Date.now;

  const UNKNOWN_CODEX_STAMP = unknownCodexControlStamp();
  let cachedCodexTrust: CodexTrustCacheEntry | null =
    readCodexTrust(CCC_PACKAGE_VERSION);
  let codexControlStamp: CodexControlStamp = unknownCodexControlStamp();
  // The verdict's expiry, kept on BOTH clocks because neither one bounds its age
  // alone. Monotonic time survives a wall clock corrected backwards; wall time
  // survives a suspend, because on macOS the monotonic source is
  // mach_absolute_time and does not advance while the machine sleeps. A laptop
  // that slept overnight would otherwise wake with most of its 30 minutes intact
  // and stamp "armed" off a verdict from yesterday, about a hook a Codex update
  // may have un-trusted while it was closed.
  let codexStampExpiresAtMono = 0;
  let codexStampExpiresAtWall = 0;

  function refreshCodexStamp(): void {
    codexControlStamp = resolveCodexControlStamp({
      cached: cachedCodexTrust,
      cccVersion: CCC_PACKAGE_VERSION,
    });
    const validForMs = codexTrustValidForMs(
      cachedCodexTrust,
      CCC_PACKAGE_VERSION,
    );
    codexStampExpiresAtMono = monotonicNow() + validForMs;
    codexStampExpiresAtWall = wallNow() + validForMs;
  }
  refreshCodexStamp();

  // What every telemetry line actually gets. Number comparisons only, no syscall
  // and no subprocess, so nothing resolves per event while the TTL still bites. Whichever
  // clock expires first wins, so the answer degrades to unknown rather than
  // outliving its evidence.
  function currentCodexControlStamp(): CodexControlStamp {
    const live =
      monotonicNow() < codexStampExpiresAtMono &&
      wallNow() < codexStampExpiresAtWall;
    return live ? codexControlStamp : UNKNOWN_CODEX_STAMP;
  }

  const apiKey = process.env.MARGINFRONT_API_KEY;
  if (!apiKey) {
    console.error(
      "MARGINFRONT_API_KEY is not set. Set it in your shell before watching: " +
        "export MARGINFRONT_API_KEY=...",
    );
    process.exit(1);
  }

  // CLAIM THE SLOT: write our pid so a concurrent `run` can see we're alive.
  // Best-effort: a write failure (bad disk, permissions) proceeds anyway - the
  // guard just can't block a second instance in that edge case. Placed AFTER the
  // API-key check so a bad-key exit never leaves a phantom pidfile.
  if (pidFilePath) {
    try {
      writeFileSync(pidFilePath, String(process.pid));
    } catch {
      /* best effort - proceed even if the pidfile can't be written */
    }
  }

  // Log WHICH key the daemon loaded, masked - so a wrong/expired key is diagnosable
  // from the log without ever writing the raw secret to disk or terminal.
  console.log(`Using MarginFront key ${maskApiKey(apiKey)}.`);
  const sendingTo = resolveConfiguredServer();
  if (sendingTo.ok) console.log(`Sending usage to ${sendingTo.baseUrl}.`);

  console.log(
    `Watching ${filePath} for live Claude Code + Codex usage` +
      (foldCache ? " (fold-cache: cache tokens rolled into input)" : "") +
      "… Ctrl-C to stop.",
  );

  // Resume where the previous run stopped (0 on a first-ever run) so we never
  // re-POST already-sent history.
  let cursorBytes = readWatchCursor(cursorPath);
  let running = false; // prevents overlapping polls
  const maxTailBytesPerTick =
    options.maxTailBytesPerTick ?? MAX_TAIL_BYTES_PER_TICK;
  let catchingUp = false;

  // Durable retry queue state. queuedCount is in memory for an
  // O(1) cap check, SEEDED from any queue a prior run left so a restart resumes the
  // backlog. The backoff throttles drains during a sustained outage.
  const queuePath = options.queuePath;
  let queuedCount = readQueue(queuePath).length;
  let queueBackoffMs = QUEUE_BACKOFF_START_MS;
  let nextQueueRetryAt = 0; // 0 = eligible to drain on the next poll

  const hhmmss = (): string => new Date().toISOString().slice(11, 19);

  // AUTH HOLD. Seeded from disk so a launchd respawn resumes the hold
  // instead of hammering a dead key - UNLESS the key changed since the hold was
  // written (a re-init, a hand-edited .env + start, a shell export), in which case
  // the hold is about a key this daemon no longer holds and is dropped. A running
  // daemon never re-reads the .env, so this startup check is the only place a new
  // key can be noticed.
  const authHoldPath = options.authHoldPath;
  const authProbeIntervalMs =
    options.authProbeDeps?.intervalMs ?? AUTH_PROBE_INTERVAL_MS;
  const probeMonotonicNow =
    options.authProbeDeps?.monotonicNow ?? monotonicNowMs;
  const probeKey =
    options.authProbeDeps?.probe ?? (() => probeKeyIdentity({ apiKey }));
  const runningKeyFingerprint = keyFingerprint(apiKey);
  let authHold: AuthHoldState | null = readAuthHold(authHoldPath);
  if (authHold && authHold.keyFingerprint !== runningKeyFingerprint) {
    clearAuthHold(authHoldPath);
    authHold = null;
    console.log(
      `[${hhmmss()}] the MarginFront key changed since the last run - sending resumes now.`,
    );
  } else if (authHold) {
    // status tails the error log as the user's self-diagnosis surface, so a daemon
    // respawned into a hold must say why it is silent.
    console.error(
      [
        `[${hhmmss()}] PROBLEM: sending is still paused from a previous run. MarginFront`,
        `  rejected this machine's key (HTTP ${authHold.lastStatus}) and it hasn't worked since`,
        `  ${authHold.since}. Your spend keeps being recorded locally. I check the key every`,
        `  ${Math.round(authProbeIntervalMs / 60_000)} minute(s) and resume on my own once it works.`,
        `  Fix now: run node ~/.marginfront-ccc/cli.js init and paste a working SECRET key (mf_sk_...).`,
      ].join("\n"),
    );
  }
  let nextAuthProbeAtMono = 0; // 0 = probe on the first held tick
  let authProbeInFlight = false;

  function enterAuthHold(status: number, stamp: string): void {
    if (authHold) return;
    authHold = {
      since: new Date().toISOString(),
      lastStatus: status,
      keyFingerprint: runningKeyFingerprint,
      lastProbeAt: null,
    };
    writeAuthHold(authHoldPath, authHold);
    console.error(
      [
        `[${stamp}] PROBLEM: MarginFront rejected this machine's key (HTTP ${status}), so sending is paused.`,
        "  Why: the key was probably revoked, replaced, or is the wrong kind of key.",
        "  Your spend keeps being recorded locally and parked on disk; nothing is lost.",
        `  I check the key every ${Math.round(authProbeIntervalMs / 60_000)} minute(s) and resume on my own once it works.`,
        "  Fix now: run node ~/.marginfront-ccc/cli.js init and paste a working SECRET key (mf_sk_...).",
      ].join("\n"),
    );
  }

  const authProbeRiderDeps: AuthRecoveryProbeDeps = {
    probe: probeKey,
    monotonicNow: probeMonotonicNow,
    isInFlight: () => authProbeInFlight,
    setInFlight: (inFlight) => {
      authProbeInFlight = inFlight;
    },
    onRecovered: () => {
      clearAuthHold(authHoldPath);
      authHold = null;
      // The probe owns recovery timing; hand the drain back its floor cadence so
      // the next tick empties the backlog immediately.
      queueBackoffMs = QUEUE_BACKOFF_START_MS;
      nextQueueRetryAt = 0;
      console.log(
        `[${hhmmss()}] the MarginFront key works again - sending resumes now ` +
          `(${queuedCount} parked record(s) will go out).`,
      );
    },
    onStillHeld: () => {
      if (!authHold) return;
      authHold = { ...authHold, lastProbeAt: new Date().toISOString() };
      writeAuthHold(authHoldPath, authHold);
    },
  };

  // COLLECTOR SELF-HEAL state + wiring. The collector is detached and the
  // launchd daemon can't see it, so the watcher is the only thing positioned to notice
  // it died and restart it. nextCollectorReviveAt is the backoff window state: 0 means
  // "eligible to revive right now"; maybeReviveCollector returns the updated value.
  let nextCollectorReviveAt = 0;
  const collectorHealDeps: CollectorHealDeps = {
    isCollectorAlive: () => isPidAlive(readCollectorPid()),
    reviveCollector: () => {
      startCollector();
    },
    now: () => Date.now(),
    log: (message) => console.error(`[${hhmmss()}] ${message}`),
  };

  // CONTROL spend-state sync. Rides this poll loop but throttled to
  // the flush cadence, NOT the 1s file poll (that would hammer the read-back).
  // syncControlState itself no-ops unless armed and fails open on any error.
  // nextControlSyncAt = 0 => sync on the first tick, then every interval.
  let nextControlSyncAt = 0;
  let controlSyncInFlight = false;
  function maybeSyncControlState(): void {
    // Paused during an auth hold: the caps/spend reads use the same dead key, so
    // syncing is only a second stream of 401s. spent.json goes stale on exactly
    // the same schedule either way (a failed sync never rewrites it), and the cap
    // check's own freshness gate fails open - `status` warns about it.
    if (authHold) return;
    if (controlSyncInFlight || Date.now() < nextControlSyncAt) return;
    controlSyncInFlight = true;
    void syncControlState({
      devEmail: developerOverride,
      log: (message) => console.error(`[${hhmmss()}] ${message}`),
    })
      .catch(() => {
        // Fail open: a sync error never blocks - the hook reads last-good/stale.
      })
      .finally(() => {
        controlSyncInFlight = false;
        nextControlSyncAt = Date.now() + CONTROL_SYNC_INTERVAL_MS;
      });
  }

  // CODEX SELF-HEAL. If a future Codex release stops understanding our
  // hook entry, Codex refuses the WHOLE hooks file - including hooks the developer
  // wrote - and this pulls ours back out so theirs work again. No-ops unless the
  // Codex arm was actually installed, and never throws.
  let nextCodexHealAt = 0;
  let codexHealInFlight = false;
  function maybeHealCodexControl(): void {
    if (codexHealInFlight || Date.now() < nextCodexHealAt) return;
    codexHealInFlight = true;
    void healCodexControlState({
      log: (message) => console.error(`[${hhmmss()}] ${message}`),
    })
      .catch(() => {
        // Fail open: we could not ask Codex. Nothing changes.
      })
      .finally(() => {
        codexHealInFlight = false;
        nextCodexHealAt = Date.now() + CODEX_HEAL_INTERVAL_MS;
      });
  }

  // CODEX TRUST REFRESH. A third self-throttling rider, deliberately NOT
  // folded into either one above: the hourly self-heal skips machines with no
  // ownership receipt, which is the population whose status we most need, and
  // sharing the spend sync's in-flight guard would let a slow network stall this.
  // Monotonic throttle: a wall-clock jump backwards would park the next refresh
  // hours out while the per-second poll kept stamping the unrefreshed verdict.
  let nextCodexTrustAtMono = 0;
  let codexTrustInFlight = false;
  function maybeRefreshCodexTrust(): void {
    if (codexTrustInFlight || monotonicNow() < nextCodexTrustAtMono) return;
    codexTrustInFlight = true;
    void resolveCodexTrust({ cwd: CODEX_TRUST_SCOPE_CWD })
      .then((status) => {
        cachedCodexTrust = writeCodexTrust(status, CCC_PACKAGE_VERSION);
      })
      .catch(() => {
        // We could not ask Codex. Fall back to "we don't know" rather than keep
        // stamping the last answer - an unread machine is never a covered one.
        cachedCodexTrust = null;
      })
      .finally(() => {
        refreshCodexStamp();
        codexTrustInFlight = false;
        nextCodexTrustAtMono = monotonicNow() + CODEX_TRUST_REFRESH_MS;
      });
  }

  // Print the standard one-line-per-event success log for a landed body.
  function logSuccess(
    body: RequestBody,
    result: PostResult,
    stamp: string,
  ): void {
    if (!result.ok) return;
    for (const rec of body.records) {
      const row = successRowsFrom(result.parsed).find(
        (r) => r?.customerExternalId === rec.customerExternalId,
      );
      const cost = row?.totalCostUsd != null ? `$${row.totalCostUsd}` : "$?";
      const eventId = row?.eventId ? ` event=${row.eventId}` : "";
      // Trailing reference differs by source: Claude carries its cache-accurate cost
      // to reconcile against; Codex metadata has `source`.
      const reference =
        "source" in rec.metadata
          ? `src=${rec.metadata.source}`
          : `cc=$${rec.metadata.claudeCodeCostUsd ?? "?"}`;
      // Tool records carry a quantity, not token counts - log "qty=N tool=X".
      const volume =
        rec.quantity !== undefined
          ? `qty=${rec.quantity} tool=${"toolName" in rec.metadata ? rec.metadata.toolName : "?"}`
          : `in=${rec.inputTokens} out=${rec.outputTokens}`;
      console.log(
        `[${stamp}] recorded ${rec.customerExternalId} · ${volume} · ` +
          `server=${cost} · ${reference}${eventId}`,
      );
    }
  }

  // Print the standard failure log for a non-ok result.
  function logFailure(result: PostResult, stamp: string): void {
    if (result.ok) return;
    if (result.reason === "http") {
      console.error(
        `[${stamp}] MarginFront HTTP ${result.status}: ${result.body}`,
      );
    } else if (result.reason === "network") {
      console.error(
        `[${stamp}] could not reach MarginFront: ${result.message}`,
      );
    } else {
      console.error(`[${stamp}] send failed (${result.reason}).`);
    }
  }

  // Append up to the cap, OLDEST-PRESERVED: at the cap the front of the queue
  // survives and the newest overflow is shed. No logging here - the network-outage
  // and auth-hold callers each explain the shed in their own true terms.
  function appendWithCap(records: UsageRecord[]): {
    queued: number;
    shed: number;
  } {
    const room = Math.max(0, MAX_QUEUE_RECORDS - queuedCount);
    const toQueue = records.slice(0, room);
    if (toQueue.length > 0) {
      appendToQueue(queuePath, toQueue);
      queuedCount += toQueue.length;
    }
    return { queued: toQueue.length, shed: records.length - toQueue.length };
  }

  // Park transiently-failed records in the durable queue BEFORE the cursor advances,
  // with the cap as a loud safety valve.
  function enqueueFailed(records: UsageRecord[], stamp: string): void {
    const { queued, shed } = appendWithCap(records);
    if (queued > 0) {
      console.error(
        `[${stamp}] send failed - queued ${queued} record(s) for retry ` +
          `(${queuedCount} now in queue).`,
      );
    }
    if (shed > 0) {
      console.error(
        `[${stamp}] QUEUE FULL (cap ${MAX_QUEUE_RECORDS}): shed ${shed} record(s) - ` +
          `these turns are LOST. The ingest endpoint has been unreachable for a ` +
          `long time; check connectivity.`,
      );
    }
    // Don't immediately retry on this same poll - schedule with backoff.
    nextQueueRetryAt = Date.now() + queueBackoffMs;
    queueBackoffMs = Math.min(queueBackoffMs * 2, QUEUE_BACKOFF_MAX_MS);
  }

  // Park records during an auth hold. Same cap-and-append, but NO backoff advance
  // (the probe cadence owns recovery timing, not the queue backoff) and its own
  // log lines: nothing was sent and the endpoint is reachable, so enqueueFailed's
  // wording would be false here.
  function parkWhileHeld(records: UsageRecord[], stamp: string): void {
    const { queued, shed } = appendWithCap(records);
    if (queued > 0) {
      console.error(
        `[${stamp}] key on hold - parked ${queued} record(s) to send later ` +
          `(${queuedCount} waiting).`,
      );
    }
    if (shed > 0) {
      console.error(
        `[${stamp}] QUEUE FULL (cap ${MAX_QUEUE_RECORDS}): dropped ${shed} record(s) - ` +
          `these turns are LOST. The queue filled up while the key wasn't working; ` +
          `fix the key with node ~/.marginfront-ccc/cli.js init.`,
      );
    }
  }

  // Retry parked records first thing each poll, bounded by the backoff window. The
  // server's dedup makes a "landed-but-response-lost" retry a no-op, so this recovers
  // a dropped turn without risking a double.
  async function drainQueue(): Promise<void> {
    // Held = the key is dead; every drain POST would fail the same 401/403. The
    // probe owns recovery timing, so the drain waits for it and the batch stays
    // safe on disk.
    if (authHold) return;
    if (!queuePath) return;
    // queuedCount only moves on the daemon's OWN writes, so it never sees a `done`
    // command's append. writeQueue rm's the file when empty, so the stat is exact.
    if (queuedCount === 0 && !existsSync(queuePath)) return;
    if (Date.now() < nextQueueRetryAt) return; // still backing off

    const queued = readQueue(queuePath);
    queuedCount = queued.length; // reconcile the counter with what's on disk
    if (queued.length === 0) return;

    const batch = queued.slice(0, MAX_RECORDS_PER_DRAIN);
    // The outbox obeys the rule too: a record from an ignored repo is in here only
    // because it was parked before the customer wrote that rule.
    const sendable = dropRecordsFromIgnoredRepos(
      batch,
      readIgnoredRepos().repos,
    );
    const discarded = batch.length - sendable.length;

    if (sendable.length === 0) {
      queuedCount = dropDrainedPrefix(queuePath, batch.length);
      console.log(
        `[${hhmmss()}] queue: discarded ${discarded} parked record(s) from a repo ` +
          `named in ${IGNORE_REPOS_ENV_KEY}.`,
      );
      return;
    }

    const result = await postToMarginFront({ records: sendable });
    const stamp = hhmmss();

    if (result.ok) {
      const stillQueued = dropDrainedPrefix(queuePath, batch.length);
      queuedCount = stillQueued;
      queueBackoffMs = QUEUE_BACKOFF_START_MS; // recovered - reset the throttle
      nextQueueRetryAt = 0;
      console.log(
        `[${stamp}] queue: ${sendable.length} retried record(s) landed · ` +
          `${stillQueued} still queued.` +
          (discarded > 0
            ? ` ${discarded} discarded (repo named in ${IGNORE_REPOS_ENV_KEY}).`
            : ""),
      );
    } else if (isAuthFailurePostResult(result)) {
      // The KEY is dead, not the records: enter the hold and leave the whole
      // queue on disk untouched. Checked BEFORE the retryable/terminal split, or
      // a 401 would fall to the terminal drop and destroy the batch.
      logFailure(result, stamp);
      enterAuthHold(result.status, stamp);
    } else if (isRetryablePostResult(result)) {
      // Still down - leave them, back off so the next attempt waits longer.
      logFailure(result, stamp);
      const waitMs = queueBackoffMs;
      nextQueueRetryAt = Date.now() + waitMs;
      queueBackoffMs = Math.min(queueBackoffMs * 2, QUEUE_BACKOFF_MAX_MS);
      console.error(
        `[${stamp}] queue: retry failed, ${queued.length} record(s) still queued ` +
          `(next attempt in ~${Math.round(waitMs / 1000)}s).`,
      );
    } else {
      // Terminal failure - these never land. Drop them LOUDLY so a poison record
      // can't wedge the queue and starve everything behind it.
      queuedCount = dropDrainedPrefix(queuePath, batch.length);
      console.error(
        `[${stamp}] queue: dropping ${batch.length} record(s) - terminal failure ` +
          `(server rejected them, retrying can't help).`,
      );
    }
  }

  async function processNewLines(): Promise<void> {
    if (running) return;
    running = true;
    try {
      // Drain the retry queue FIRST so freshly-arriving ticks don't starve the backlog.
      await drainQueue();

      // Held with no queue file: there is nowhere to park, so the cursor stays
      // put and the live file itself holds the records until recovery (the
      // idempotency keys make the eventual re-read a server-side no-op).
      if (authHold && !queuePath) return;

      const { lines, nextCursor, unreadBytes, skippedLineBytes } =
        readNewCompleteLines(filePath, cursorBytes, {
          maxBytes: maxTailBytesPerTick,
        });
      if ((unreadBytes ?? 0) > maxTailBytesPerTick) {
        if (!catchingUp) {
          console.log(
            `[${hhmmss()}] catching up on ${megabytes(unreadBytes ?? 0)} MB of ` +
              `unsent usage, sending it in chunks.`,
          );
          catchingUp = true;
        }
      } else {
        catchingUp = false;
      }
      if (skippedLineBytes) {
        console.error(
          `[${hhmmss()}] skipped one telemetry line of ` +
            `${megabytes(skippedLineBytes)} MB: too large to read.`,
        );
      }
      // Set when an auth failure hits with no queue to park into: the cursor must
      // not advance past records that were neither sent nor parked.
      let holdCursor = false;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        let parsed: ParsedOtlp;
        try {
          parsed = JSON.parse(line);
        } catch {
          // SECURITY: never echo the line (could be large/sensitive); just note it.
          console.error("(skipped one telemetry line that wasn't valid JSON)");
          continue;
        }

        // Route by shape; thread the raw line in so each record gets a stable
        // idempotency key (server-side dedup pairs with it to collapse a replay).
        const body = buildRequestBodyForLine(parsed, {
          foldCache,
          fallbackCustomerId,
          developerOverride,
          matterNumber: readWorkId().value,
          ignoredRepos: readIgnoredRepos().repos,
          cacheWriteTtl,
          controlArmed,
          codexControlStamp: currentCodexControlStamp(),
          resolveGitCoordinates,
          rawSourceLine: line,
        });
        if (!body.records.length) continue; // empty tick, nothing to record

        // Stamp which assistant this line came from, but only when it CHANGES: the
        // caller runs once per telemetry line, and an unguarded write would touch
        // the disk forever for an answer that moves a few times a day.
        const agentThisLine = lastAgentInRecords(body.records);
        if (agentThisLine && agentThisLine !== lastAgentStamped) {
          writeLastAgentSeen(lastAgentPath, agentThisLine);
          lastAgentStamped = agentThisLine;
        }

        // Send in <=100-record batches - one flush line can exceed the server's
        // per-POST cap (see splitIntoPostBatches). Each batch fails or lands on
        // its own, so an outage mid-line parks only the unsent remainder.
        for (const batch of splitIntoPostBatches(body.records)) {
          // Zero ingest POSTs while held: every batch parks until the probe
          // clears the hold.
          if (authHold) {
            if (queuePath) {
              parkWhileHeld(batch.records, hhmmss());
              continue;
            }
            holdCursor = true;
            break;
          }
          const result = await postToMarginFront(batch);
          const stamp = hhmmss();
          if (!result.ok) {
            logFailure(result, stamp);
            if (isAuthFailurePostResult(result)) {
              // The key is dead. Park the batch (BEFORE the cursor advances, so
              // nothing is destroyed) and stop sending until the probe recovers.
              enterAuthHold(result.status, stamp);
              if (queuePath) {
                parkWhileHeld(batch.records, stamp);
              } else {
                holdCursor = true;
                break;
              }
            } else if (queuePath && isRetryablePostResult(result)) {
              // Park in the durable queue BEFORE the cursor advances. A
              // crash before the cursor write re-reads the line next run
              // (at-least-once); the server dedups the duplicate.
              enqueueFailed(batch.records, stamp);
            } else if (queuePath) {
              // Terminal failure - retrying resends the same bad request, so drop it.
              console.error(
                `[${stamp}] dropping ${batch.records.length} record(s): terminal ` +
                  `send failure (not retryable).`,
              );
            }
            // No queuePath at all = at-most-once: nothing queued, drop.
            continue;
          }

          logSuccess(batch, result, stamp);

          // A fresh send landed -> connectivity is back; clear the backoff so the
          // next poll drains the backlog immediately.
          if (queuedCount > 0) {
            queueBackoffMs = QUEUE_BACKOFF_START_MS;
            nextQueueRetryAt = 0;
          }
        }
        if (holdCursor) break;
      }
      // Advance + persist the cursor past what we consumed so a restart resumes
      // here. Advancing past a FAILED tick is safe: any retryable OR auth-held
      // failure was captured in the queue above, which (not a re-read) owns its
      // recovery. The one exception is an auth failure with no queue to park
      // into - holdCursor keeps the cursor put so those records survive in the
      // live file.
      if (!holdCursor && nextCursor !== cursorBytes) {
        cursorBytes = nextCursor;
        writeWatchCursor(cursorPath, cursorBytes);
      }
    } finally {
      running = false;
    }
  }

  // Process anything new since last run, then poll for more.
  processNewLines().catch((e: unknown) =>
    console.error(`watch error: ${(e as Error).message}`),
  );
  const timer: NodeJS.Timeout = setInterval(() => {
    // before doing the usual poll, make sure the collector is still alive and
    // restart it if it died. This guards the happy path WITHOUT changing it - a healthy
    // collector makes this a single cheap pidfile probe.
    nextCollectorReviveAt = maybeReviveCollector(
      collectorHealDeps,
      nextCollectorReviveAt,
      COLLECTOR_REVIVE_BACKOFF_MS,
    );
    // Refresh the local cap + spend files on the flush cadence (throttled inside).
    maybeSyncControlState();
    // Check Codex still understands our hook file (throttled inside, hourly).
    maybeHealCodexControl();
    // Refresh the cached "does Codex trust our hook" answer (throttled inside).
    maybeRefreshCodexTrust();
    // While held, ask (bounded, single-flight) whether the key works again.
    if (authHold) {
      nextAuthProbeAtMono = maybeProbeAuthRecovery(
        authProbeRiderDeps,
        nextAuthProbeAtMono,
        authProbeIntervalMs,
      );
    }
    processNewLines().catch((e: unknown) =>
      console.error(`watch error: ${(e as Error).message}`),
    );
  }, WATCH_POLL_MS);

  return function stop(): void {
    clearInterval(timer);
    // RELEASE THE SLOT: a clean stop removes the pidfile so the next `run` doesn't
    // see a stale live-looking pid. A crash (SIGKILL, power loss) skips this; that
    // leaves a stale file, but cmdRun's isPidAlive check will clear it on the next
    // start attempt. Best-effort: a stuck file is recoverable; a throw here isn't.
    if (pidFilePath) {
      try {
        rmSync(pidFilePath, { force: true });
      } catch {
        /* best effort */
      }
    }
  };
}
