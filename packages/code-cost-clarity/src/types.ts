// types.ts - shared OTLP-input + MarginFront-output shapes for forwarder.ts.
// Two sources: Claude Code emits METRICS (resourceMetrics), Codex emits LOGS
// (resourceLogs); one document is one signal type, never both.

// Type-only, so nothing about control.ts is pulled in at runtime.
import type { CodexTrustDeps } from "./control";

// --- OTLP/JSON input shapes (collector file-exporter output) ----------------
// Wire shape is untrusted: every field optional, forwarder defends each access.

// OTLP encodes attributes as a LIST of { key, value } objects, not a plain map.
export interface OtlpAttribute {
  key?: string;
  value?: { stringValue?: string };
}

// Numeric value is EITHER asInt (JSON STRING, Claude Code console exporter) OR
// asDouble (JSON NUMBER, OTel Collector file exporter - the path we use).
export interface OtlpDataPoint {
  attributes?: OtlpAttribute[];
  asInt?: string | number | null;
  asDouble?: number | null;
}

export interface OtlpMetric {
  name?: string;
  sum?: { dataPoints?: OtlpDataPoint[] };
}

export interface OtlpScopeMetric {
  metrics?: OtlpMetric[];
}

export interface OtlpResourceMetric {
  scopeMetrics?: OtlpScopeMetric[];
}

// --- OTLP LOGS input shapes (Codex - the second source) ---------------------
// Codex reports usage on the LOG tree (resourceLogs[].scopeLogs[].logRecords[]),
// not metrics. One record holds all of a turn's token counts (no per-type
// datapoint split). Attribute values are a wider union: token counts as intValue
// (int64→JSON string) or doubleValue, identity as stringValue.
export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number; // int64 → JSON string; accept a number too
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpLogAttribute {
  key?: string;
  value?: OtlpAnyValue;
}

// `body` carries the event name (e.g. "codex.sse_event") as a fallback when the
// event.name attribute is absent; attributes carry identity + token fields.
export interface OtlpLogRecord {
  timeUnixNano?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpLogAttribute[];
}

export interface OtlpScopeLog {
  logRecords?: OtlpLogRecord[];
}

export interface OtlpResourceLog {
  scopeLogs?: OtlpScopeLog[];
}

// Parsed OTLP/JSON document: EITHER resourceMetrics (Claude) OR resourceLogs
// (Codex), never both - forwarder routes by which tree is present.
export interface ParsedOtlp {
  resourceMetrics?: OtlpResourceMetric[];
  resourceLogs?: OtlpResourceLog[];
}

// --- MarginFront output shape (what we POST to /v1/sdk/usage/record) ---------

// Cost-per-PR attribution coordinates. Read from git plumbing at flush
// time for the session's working directory. Each field is independently null: repo
// is null with no `origin` remote, branch is null on a detached HEAD, commitSha is
// null if `rev-parse HEAD` fails. The whole tuple is OMITTED (never stamped) when the
// session's cwd can't be resolved to exactly one git repo - the honest no-PR bucket.
export interface GitCoordinates {
  repo: string | null; // normalized "owner/repo" from origin
  branch: string | null;
  commitSha: string | null;
}

// Which prompt-cache WRITE flavor this machine's Claude Code sessions run
//Anthropic bills cache writes at 1.25× input for the 5-minute
// cache ("5m": API key / Bedrock / Vertex sign-ins) and 2× input for the
// 1-hour cache ("1h": Claude subscriptions). MarginFront prices
// cacheWriteTokens with this hint; when absent it uses the 2× ceiling.
export type CacheWriteTtl = "5m" | "1h";

// Audit metadata on every CLAUDE CODE record.
// claudeCodeCostUsd = Claude's cache-accurate figure, kept as reconcile ground-truth.
export interface UsageRecordMetadata {
  sessionId: string;
  rawModel: string;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheFoldedIntoInput: boolean;
  claudeCodeCostUsd: number | null;
  // Cache-write pricing hint; omitted when unknown, so an
  // unstamped record carries no cacheWriteTtl key.
  cacheWriteTtl?: CacheWriteTtl;
  // Git coordinates; see GitCoordinates.
  repo?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  // Control armed-status stamp. Present ONLY when the device has the
  // opt-in cap-check hook installed, so the dashboard can count "cap armed for N of
  // M developers" off the existing telemetry channel. controlPolicyAsOf carries the
  // materialized policy's freshness (null until the first pull lands). Both omitted
  // when Control isn't armed, so a metering-only record stays byte-identical.
  controlArmed?: true;
  controlPolicyAsOf?: string | null;
  // This machine's work item from CCC_WORK_ID. Ingest matches it
  // EXACTLY against the org's matters, so a near-miss lands in Unassigned rather than
  // erroring. Omitted when unset, so an untagged record carries no matterId key.
  matterId?: string;
}

// Audit metadata on every CODEX record. OpenAI nests its counts:
// reasoning ⊂ output, and input partitions into cached + cache-write + fresh
// (subsets, not separate buckets). The raw reasoning/tool/cached/cacheWrite counts
// here are audit-ONLY - NEVER add them to billed tokens or you double-count.
// source:"codex" is the discriminant; Claude omits it.
export interface CodexUsageRecordMetadata {
  source: "codex";
  sessionId: string | null;
  rawModel: string;
  cachedTokens: number;
  // GPT-5.6-class models on a recent Codex only; omitted when zero or absent.
  cacheWriteTokens?: number;
  // Present only on a malformed turn whose cache slices summed over its own
  // input_token_count. The billed cache tokens were shrunk to fit and so read LOWER
  // than the raw counts on this same object.
  cacheSlicesClamped?: true;
  reasoningTokens: number;
  toolTokens: number;
  cacheFoldedIntoInput: boolean;
  // Git coordinates; see GitCoordinates.
  repo?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  // Per-tool cap stamp. controlStampVersion is the ONLY discriminator:
  // its absence means the sending meter reports no Codex answer, which is not the
  // same as "not armed". codexControlArmed is omitted entirely when we couldn't
  // tell, so a missing key is never readable as a no.
  controlStampVersion?: number;
  codexControlState?: string;
  codexControlArmed?: boolean;
  controlPolicyAsOf?: string | null;
  // This machine's work item from CCC_WORK_ID. Ingest matches it
  // EXACTLY against the org's matters, so a near-miss lands in Unassigned rather than
  // erroring. Omitted when unset, so an untagged record carries no matterId key.
  matterId?: string;
}

// Audit metadata on every TOOL-CALL record: a paid external API
// (Google Maps, Browserbase, paid MCP) fired N times, NOT an LLM turn - no
// tokens, cost = quantity × pricing-table unit rate. source:"tool" is the
// discriminant. estimated is always true: one call ≠ one billable vendor unit
// (free tiers, per-MB/per-1K pricing), so line items round up (never-under-estimate).
export interface ToolUsageRecordMetadata {
  source: "tool";
  sessionId: string | null;
  toolName: string; // raw telemetry name, e.g. "mcp__browserbase__navigate"
  telemetrySource: string; // "claude-code" | "codex"
  estimated: true;
  // Git coordinates; see GitCoordinates.
  repo?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  // This machine's work item from CCC_WORK_ID. Ingest matches it
  // EXACTLY against the org's matters, so a near-miss lands in Unassigned rather than
  // erroring. Omitted when unset, so an untagged record carries no matterId key.
  matterId?: string;
}

// Audit metadata on a FINISHED-WORK record: the customer ran
// `done` because they finished something. No tokens and no session: the count is
// measured, and the AI cost beside it on the ROI page is attributed from the same
// developer's turns on the same work item, never from a session this command cannot
// see. source:"outcome" is the discriminant, and it pairs with the $0 catalog row
// under provider "outcome" that makes the record cost nothing on its own.
export interface FinishedWorkRecordMetadata {
  source: "outcome";
  // When the customer said they finished it, ISO-8601.
  doneAt: string;
  // The work item in effect on this machine, same wire field as every other record.
  matterId?: string;
  // Git coordinates; omitted whole when the cwd is not a repo.
  repo?: string | null;
  branch?: string | null;
  commitSha?: string | null;
}

// Discriminated by `source` (in-operator narrowing): "codex", "tool", "outcome", or
// absent (Claude token records).
export type AnyUsageRecordMetadata =
  | UsageRecordMetadata
  | CodexUsageRecordMetadata
  | ToolUsageRecordMetadata
  | FinishedWorkRecordMetadata;

// One MarginFront usage record. cacheReadTokens/cacheWriteTokens are server-priced
// and present ONLY in default mode - OMITTED under --fold-cache, where they're
// already inside inputTokens (sending both double-counts). Codex sets
// cacheWriteTokens only when the turn reports a POSITIVE cache_write_token_count;
// see the buildCodexRequestBody header for why a zero must not be sent.
export interface UsageRecord {
  customerExternalId: string;
  agentCode: string;
  signalName: string;
  model: string;
  modelProvider: string;
  // Optional because a record is EITHER an LLM turn (tokens, no quantity) OR a tool
  // call (quantity, no tokens). Mirrors the server DTO: inputTokens/
  // outputTokens/quantity are all @IsOptional.
  inputTokens?: number;
  outputTokens?: number;
  // Billing units for a tool record: times the paid API fired this flush;
  // server prices quantity × unitPrice. Omitted on LLM records (server defaults to 1).
  quantity?: number;
  environment: string;
  metadata: AnyUsageRecordMetadata;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  // Stable per-turn dedup key: watcher stamps it from the raw
  // line + record identity so a re-read/retried turn collapses to one event server-
  // side. Optional - preview/send paths skip it; server treats missing as at-least-once.
  idempotencyKey?: string;
}

// POST envelope the ingest route expects: { records: [...] }.
export interface RequestBody {
  records: UsageRecord[];
}

// --- MarginFront response shape (only the parts we read back) ----------------

// Per-record success row. totalCostUsd is the server's price - number OR a
// stringified number depending on path.
export interface IngestSuccessRow {
  customerExternalId?: string;
  eventId?: string;
  totalCostUsd?: number | string | null;
}

export interface IngestResponse {
  results?: { success?: IngestSuccessRow[] };
}

// --- function option + result shapes ----------------------------------------

// Options for buildMarginFrontRequestBody. fallbackCustomerId = placeholder used
// when no customer email surfaced.
export interface BuildBodyOptions {
  foldCache?: boolean;
  fallbackCustomerId?: string | null;
  // Per-developer attribution override for a SHARED coding-agent login. When a whole
  // team logs into Claude/Codex with ONE account, every turn's user.email is the same
  // and all cost collapses onto one customer. The meter runs locally per laptop, so this
  // per-machine email (from CCC_DEVELOPER_EMAIL) is the override that restores
  // per-developer attribution. It sits at the TOP of the precedence chain - it WINS
  // over the telemetry's own user.email - which is the mirror image of fallbackCustomerId
  // (the bottom of the chain). The builders stay PURE: this value is resolved once from
  // the environment by the watcher and passed in here; no builder reads process.env or
  // shells out to git. Unset/empty => undefined => output matches a run with no override.
  developerOverride?: string;
  // Raw JSONL line this record came from; when present, hashed
  // into the record's idempotencyKey. Omitted by preview/send (no dedup needed).
  rawSourceLine?: string;
  // Cost-per-PR attribution. Resolver the LIVE WATCHER injects: maps a
  // record's sessionId to fresh git coordinates (repo/branch/SHA read together at
  // flush time). Returns null to omit (cwd unresolvable/ambiguous). The builders stay
  // PURE exactly like developerOverride - they never touch git or the filesystem, they
  // only call this. Unset (preview/one-shot send) => no coordinates stamped.
  resolveGitCoordinates?: (sessionId: string | null) => GitCoordinates | null;
  // Cache-write TTL hint, resolved once from CCC_CACHE_WRITE_TTL by
  // the watcher/preview (same pure-builder pattern as developerOverride) and
  // stamped into Claude record metadata. Unset => no stamp => server prices
  // cache writes at the 1h ceiling.
  cacheWriteTtl?: CacheWriteTtl;
  // Control armed-status stamp, resolved once from the local control
  // state by the watcher (same pure-builder pattern) and stamped into Claude turn
  // metadata. Unset => no stamp => byte-identical to a metering-only record.
  controlArmed?: { controlArmed: true; controlPolicyAsOf: string | null };
  // Per-tool Codex cap stamp, threaded in like controlArmed but for a
  // sharper reason: answering the Codex question spawns a Codex process, and this
  // builder runs once per telemetry line. Unset (preview, one-shot send) => no stamp
  // => the record reads as "we don't know", the honest answer for a path that never
  // asked.
  codexControlStamp?: {
    controlStampVersion: number;
    codexControlState: string;
    codexControlArmed?: boolean;
    controlPolicyAsOf?: string | null;
  };
  // This machine's work item, read from CCC_WORK_ID (or its alias
  // CCC_MATTER_ID) by the watcher/preview - same pure-builder pattern as
  // developerOverride - and stamped as metadata.matterId on EVERY record: Claude
  // turns, Codex turns, tool calls from both. The field name is a wire contract, so it
  // keeps the matter spelling the server reads.
  matterNumber?: string;
  // The repos this machine never sends spend from, read from CCC_IGNORE_REPOS by the
  // watcher/preview - same pure-builder pattern as matterNumber - and lowercased
  // once, because matching is case-insensitive on the exact owner/repo. A session the
  // git resolver places in one of these produces NO records at all. Unset or empty =>
  // output byte-identical to a build with no ignore list, and so is a session whose
  // repo cannot be resolved: a repo the meter cannot place is still SENT, because
  // failing closed would silently stop metering a whole machine.
  ignoredRepos?: Set<string>;
}

// Live-watcher options. cursorPath persists the resume byte-offset so a restart
// resumes instead of re-sending the whole session.
export interface WatchOptions {
  foldCache?: boolean;
  fallbackCustomerId?: string | null;
  cursorPath?: string;
  // Durable retry-queue path: a transiently-failed send is
  // appended here instead of dropped; each poll drains it first. Omitted = at-most-once.
  queuePath?: string;
  // Single-instance guard pidfile path. When provided, watchAndForward
  // writes process.pid here on startup (claiming the slot) and removes it in
  // stop() (releasing it). cmdRun checks this file BEFORE calling watchAndForward
  // and refuses if a live pid is already there. Omit in tests that don't need the
  // on-disk side-effect (cursor/queue unit tests are unaffected).
  pidFilePath?: string;
  // Test seam for the Codex trust answer. Unset in
  // production, where the real spawn-and-disk implementations are used.
  codexTrustDeps?: CodexTrustDeps;
  // Test seam for the git resolver. Unset in production, where the real
  // createGitCoordinatesResolver() reads ~/.claude/projects and ~/.codex/sessions.
  // It exists because the real resolver keys off homedir(), which under vitest does
  // NOT follow a process.env.HOME a test sets - so an in-process daemon test cannot
  // point it at a throwaway home the way a child process can.
  gitCoordinatesResolver?: (sessionId: string | null) => GitCoordinates | null;
  // Auth-hold state file. When ingest rejects the key (401/403) the
  // watcher parks batches in the queue and persists the hold here, so a launchd
  // respawn resumes the hold instead of hammering a dead key. Omitted = the hold
  // still happens but lives only in this process's memory.
  authHoldPath?: string;
  // Test seam for the hold-recovery probe (probe fn, clock, cadence). Unset in
  // production, where the real GET /v1/me/key on a 5-minute cadence runs.
  authProbeDeps?: AuthProbeSeams;
  // Test seam for the settings file the work item is re-read from.
  // Unset in production, where the real ~/.marginfront-ccc/.env is read. ENV_PATH is
  // fixed from homedir() at module load, so a temp HOME cannot move it for a test.
  matterEnvPath?: string;
  // Where the watcher records WHICH assistant it last saw a record from, so
  // `done` on a machine with both installed can name the one that has
  // actually been working instead of guessing. Omitted = nothing is written and
  // `done` asks for --agent on a both-installed machine.
  lastAgentPath?: string;
  // The environment consulted ONLY when that file names NEITHER work-item key - in
  // practice a .env with no work-item line, on a machine that exports the variable
  // instead. It is NOT process.env: `run` copies the settings file into
  // process.env at startup, so a line deleted later would keep resolving out of that
  // copy. cmdRun snapshots the shell's own value before that copy happens; omitted
  // here means there is no such fallback.
  matterEnv?: NodeJS.ProcessEnv;
  // Test seam for the per-tick read cap. Unset in production, where
  // MAX_TAIL_BYTES_PER_TICK applies.
  maxTailBytesPerTick?: number;
}

// readNewCompleteLines result: complete lines past the cursor + nextCursor, the
// byte offset past the last one (persist it to resume).
export interface ReadLinesResult {
  lines: string[];
  nextCursor: number;
  // Bytes still unread past the cursor when this read began. Lets the watcher
  // tell a catch-up from an ordinary tick without a second stat.
  unreadBytes?: number;
  // Set when one line was too long to ever turn into a string and was stepped
  // over instead of read.
  skippedLineBytes?: number;
}

export interface ReadLimits {
  maxBytes?: number;
  maxLineBytes?: number;
}

// POST result - discriminated union on `ok`/`reason` (compiler checks exhaustiveness).
export type PostResult =
  | { ok: true; parsed: IngestResponse | null; body: string }
  | { ok: false; reason: "no-key" }
  // No usable server address is configured. Terminal (not retryable) - the check at
  // the send site returns this instead of hitting the wire.
  | { ok: false; reason: "blocked-url" }
  | { ok: false; reason: "network"; message: string }
  | { ok: false; reason: "http"; status: number; body: string };

// --- key validation + auth hold --------------------------------

// What GET /v1/me/key said about the key. keyType null = the server answered 200
// but the body carried no readable keyType (a server that does not report it) - the key
// authenticates, which is all hold recovery needs to know.
export type AuthProbeResult =
  | { ok: true; keyType: "secret" | "publishable" | null; role: string | null }
  | { ok: false; reason: "http"; status: number }
  | { ok: false; reason: "network" };

// init's key check. Three answers stop init: "rejected" (the server 401/403'd
// /v1/verify), "publishable" (a valid key that can never POST usage, because
// the write guard blocks publishable keys on POSTs only - a GET-only check would
// wave it through) and "wrong-address" (a 404 from /verify: something answered,
// but not a MarginFront API, which is what a typed address missing /v1 looks
// like). Everything else - a 5xx, an unreadable body, no network - is
// "unreachable": no authoritative verdict, so init saves the key rather than
// dead-ending setup on an unrelated outage.
export type KeyCheckResult =
  | {
      ok: true;
      organizationName: string;
      keyType: "secret" | "publishable" | null;
    }
  | { ok: false; reason: "rejected"; status: number }
  | { ok: false; reason: "publishable"; organizationName: string }
  | { ok: false; reason: "wrong-address"; serverUrl: string }
  | { ok: false; reason: "unreachable"; message: string };

// The auth-hold state persisted to disk so a daemon respawn resumes the hold
// instead of hammering a dead key.
export interface AuthHoldState {
  // When the hold began (ISO timestamp) - what `status` shows the user.
  since: string;
  // The HTTP status that triggered it (401 or 403).
  lastStatus: number;
  // Non-reversible sha256 prefix of the held key. A daemon that starts with a
  // DIFFERENT key drops the hold immediately - covers a re-init, a hand-edited
  // .env followed by `start`, and a shell export override in one rule.
  keyFingerprint: string;
  // Last failed probe (ISO timestamp), null before the first probe.
  lastProbeAt: string | null;
}

// Test seam for the hold-recovery probe rider: the probe call, the throttle
// clock, and the cadence, so a test can drive an hour of hold in milliseconds.
export interface AuthProbeSeams {
  probe?: () => Promise<AuthProbeResult>;
  monotonicNow?: () => number;
  intervalMs?: number;
}
