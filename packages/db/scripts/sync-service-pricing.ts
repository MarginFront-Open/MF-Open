/**
 * Syncs the service_pricing catalog from OpenRouter + LiteLLM plus the built-in
 * rows below. Any built-in or feed row absent from this script's own list is
 * RETIRED (isActive=false) on every run, so a built-in row has to live here,
 * never only in the DB.
 *
 * Run with: npm run db:sync-pricing (from packages/db). Needs internet. A new
 * database with no internet uses `npm run db:seed-pricing` instead, which
 * loads the snapshot committed in data/price-catalog-snapshot.json.
 *
 * Dry run (no database, no DATABASE_URL): add --dry-run --out <file.json> to
 * write the exact rows a real run would upsert, sorted by externalId, with
 * prices rounded to the column's 10 decimals. --litellm-file /
 * --openrouter-file read a feed from disk instead of the network and are
 * accepted only with --dry-run: a real sync always prices from the live feeds.
 * --save-feeds <dir> writes the fetched feeds to <dir>/litellm.json and
 * <dir>/openrouter.json as re-serialized JSON (replay-identical, not the raw
 * bytes) so a later dry run can replay identical inputs.
 *
 * --litellm-only skips the OpenRouter feed. LiteLLM is the one feed a sync
 * needs: if OpenRouter is skipped or returns nothing, the run prices from
 * LiteLLM alone and retires the OpenRouter rows like any other row it no
 * longer lists.
 */

import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadPackageEnvFile } from "./package-env";

// Constructed on first database use, never at import: a dry run must work on a
// machine with no DATABASE_URL at all.
let prismaClient: PrismaClient | null = null;
function db(): PrismaClient {
  if (!prismaClient) {
    loadPackageEnvFile();
    prismaClient = new PrismaClient();
  }
  return prismaClient;
}

// ============================================================
// TYPES
// ============================================================

export interface NormalizedEntry {
  externalId: string;
  displayName: string;
  provider: string;
  serviceType: string;
  inputCost: number | null;
  outputCost: number | null;
  // Dollars per 1M tokens, same units as inputCost/outputCost; absent maps to a
  // null DB column. cacheWriteCost carries the 5-minute-TTL creation rate as
  // parsed — Anthropic LLM rows are overridden to the 1-hour ceiling on write.
  cacheReadCost?: number | null;
  cacheWriteCost?: number | null;
  costUnit: string;
  contextWindow: number | null;
  source: string;
  isApi: boolean;
}

// main() aborts before any DB write on a costUnit outside this set:
// calculateEventCost has no unknown-unit branch and would silently price it
// with flat per-unit math. Add a unit here only after confirming
// calculateEventCost handles it.
export const KNOWN_COST_UNITS = new Set<string>([
  "1M tokens",
  "1M characters",
  "1M requests",
  "1M read units",
  "1K requests",
  "1K results",
  "1K pages",
  "1K emails",
  "1K messages",
  "1K minutes",
  "1K lookups",
  "1K phones",
  "1K MB",
  "1K MB-hours",
  "1K CPU-seconds",
  "1K vCPU-seconds",
  "1K GiB-seconds",
  "1K instance-seconds",
  "minute",
  "second",
  "image",
  "request",
  // CalculateEventCost's flat branch: quantity x rate, rate 0.
  "item",
]);

/**
 * externalId → the lowercase name an event actually passes as `model`: strip
 * a "litellm/" or "api/" source prefix, then keep the last "/" segment
 * ("litellm/gemini/gemini-2.0-flash" → "gemini-2.0-flash").
 *
 * ModelPricingService.lookupModel() matches on this field, so it is the single
 * source of truth for what a usage event will hit.
 */
function toCanonical(externalId: string): string {
  let s = externalId.toLowerCase();
  if (s.startsWith("litellm/")) s = s.slice(8);
  else if (s.startsWith("api/")) s = s.slice(4);
  if (s.includes("/")) s = s.split("/").pop()!;
  return s;
}

// ============================================================
// PROVIDER NAME MAP
// ============================================================

// Maps source-specific prefixes to the canonical provider name. Stored
// lowercase so it matches an event's `modelProvider` with no case-folding.
const PROVIDER_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  "meta-llama": "meta",
  mistralai: "mistral",
  cohere: "cohere",
  deepseek: "deepseek",
  "x-ai": "xai",
  qwen: "qwen",
  microsoft: "microsoft",
  amazon: "aws",
  perplexity: "perplexity",
  stability: "stability",
  "black-forest-labs": "black-forest-labs",
  black_forest_labs: "black-forest-labs",
};

function getProvider(id: string, litellmProvider?: string): string {
  const prefix = id.split("/")[0].toLowerCase();
  if (PROVIDER_MAP[prefix]) return PROVIDER_MAP[prefix];
  if (litellmProvider) {
    const lp = litellmProvider.toLowerCase();
    for (const [key, name] of Object.entries(PROVIDER_MAP)) {
      if (lp.includes(key)) return name;
    }
  }
  return prefix.toLowerCase();
}

// ============================================================
// SERVICE TYPE FROM LITELLM MODE
// ============================================================

const MODE_TO_TYPE: Record<string, string> = {
  chat: "LLM",
  completion: "LLM",
  responses: "LLM",
  embedding: "Embeddings",
  image_generation: "Image Generation",
  image_edit: "Image Generation",
  video_generation: "Video Generation",
  audio_transcription: "Speech-to-Text",
  audio_speech: "Text-to-Speech",
  moderation: "Moderation",
  rerank: "Reranking",
  realtime: "LLM",
  ocr: "Document Processing",
};

// ============================================================
// LITELLM ENTRIES TO SKIP
// ============================================================

function shouldSkipLiteLLM(key: string): boolean {
  if (key === "sample_spec") return true;
  if (key.includes("Commitment/")) return true;
  if (key.match(/^\d+[-x]+\d+/)) return true;

  const skipPrefixes = [
    // Regional variants
    "eu.",
    "us.",
    "apac.",
    "au.",
    "jp.",
    "global.",
    // Cloud provider hosted (same models, different hosting)
    "bedrock/",
    "azure/",
    "azure_ai/",
    "vertex_ai/",
    "vertex_ai-",
    "sagemaker/",
    // Third-party hosting (reselling same models)
    "fireworks_ai/",
    "together_ai/",
    "together/",
    "groq/",
    "perplexity/",
    "deepinfra/",
    "anyscale/",
    "cloudflare/",
    "friendliai/",
    "cerebras/",
    "sambanova/",
    "ai21/",
    "nlp_cloud/",
    "aleph_alpha/",
    "petals/",
    "ollama/",
    "ollama_chat/",
    "huggingface/",
    "openrouter/",
    "databricks/",
    "hosted_vllm/",
    "lm_studio/",
    "xinference/",
    "replicate/",
    "github_copilot/",
    "heroku/",
    "snowflake/",
    "gradient_ai/",
    "gmi/",
    "vercel_ai_gateway/",
    "fal_ai/",
    "runwayml/",
    // Completion variants and fine-tuned
    "text-completion-openai/",
    "text-completion-codestral/",
    "codestral/",
    "ft:",
  ];

  for (const prefix of skipPrefixes) {
    if (key.startsWith(prefix)) return true;
  }

  return false;
}

// ============================================================
// BUILT-IN ROWS
// ============================================================

// A tool that ships inside Claude Code or Codex and costs nothing beyond the
// model tokens around it. The bundled cost meter forwards each call as
// (model = tool name, modelProvider = "tool"), so without a row the event
// waits in Needs attention. The 0 is a priced zero, not a missing price: the
// event lands PROCESSED at $0. costUnit "request" keeps each row one edit
// away from a real per-call rate.
function freeAgentTool(name: string, displayName: string): NormalizedEntry {
  return {
    externalId: `tool/${name}`,
    displayName,
    provider: "tool",
    serviceType: "Agent Built-in",
    inputCost: 0,
    outputCost: null,
    costUnit: "request",
    contextWindow: null,
    source: "builtin",
    isApi: true,
  };
}

// Lowercase, because the lookup lowercases the name the agent sends. Task and
// Agent only spawn sub-turns, which are token-billed in their own sessions.
// Older Claude Code builds used KillBash and LS; both names stay.
const CLAUDE_CODE_FREE_TOOLS: Array<[string, string]> = [
  ["read", "Claude Code: Read"],
  ["edit", "Claude Code: Edit"],
  ["write", "Claude Code: Write"],
  ["multiedit", "Claude Code: MultiEdit"],
  ["notebookedit", "Claude Code: NotebookEdit"],
  ["notebookread", "Claude Code: NotebookRead"],
  ["bash", "Claude Code: Bash"],
  ["bashoutput", "Claude Code: BashOutput"],
  ["killshell", "Claude Code: KillShell"],
  ["killbash", "Claude Code: KillBash"],
  ["grep", "Claude Code: Grep"],
  ["glob", "Claude Code: Glob"],
  ["ls", "Claude Code: LS"],
  ["todowrite", "Claude Code: TodoWrite"],
  ["exitplanmode", "Claude Code: ExitPlanMode"],
  ["task", "Claude Code: Task"],
  ["agent", "Claude Code: Agent"],
  ["slashcommand", "Claude Code: SlashCommand"],
  ["toolsearch", "Claude Code: ToolSearch"],
  ["taskcreate", "Claude Code: TaskCreate"],
  ["taskupdate", "Claude Code: TaskUpdate"],
  ["tasklist", "Claude Code: TaskList"],
  ["taskget", "Claude Code: TaskGet"],
  ["taskoutput", "Claude Code: TaskOutput"],
  ["taskstop", "Claude Code: TaskStop"],
  ["webfetch", "Claude Code: WebFetch"],
  ["askuserquestion", "Claude Code: AskUserQuestion"],
  ["skill", "Claude Code: Skill"],
  ["schedulewakeup", "Claude Code: ScheduleWakeup"],
  ["artifact", "Claude Code: Artifact"],
  ["monitor", "Claude Code: Monitor"],
  ["structuredoutput", "Claude Code: StructuredOutput"],
  ["sendmessage", "Claude Code: SendMessage"],
  ["senduserfile", "Claude Code: SendUserFile"],
  ["workflow", "Claude Code: Workflow"],
  ["pushnotification", "Claude Code: PushNotification"],
  ["reportfindings", "Claude Code: ReportFindings"],
  ["enterworktree", "Claude Code: EnterWorktree"],
  ["exitworktree", "Claude Code: ExitWorktree"],
];

// Codex keeps snake_case tool names, so these match what it sends. shell is
// the name older Codex builds used before exec_command.
const CODEX_FREE_TOOLS: Array<[string, string]> = [
  ["exec_command", "Codex: exec_command"],
  ["exec", "Codex: exec"],
  ["shell", "Codex: shell"],
  ["apply_patch", "Codex: apply_patch"],
  ["tool_search", "Codex: tool_search"],
  ["update_plan", "Codex: update_plan"],
  ["write_stdin", "Codex: write_stdin"],
  ["view_image", "Codex: view_image"],
  ["list_mcp_resources", "Codex: list_mcp_resources"],
  ["wait", "Codex: wait"],
  ["run", "Codex: run"],
  ["spawn_agent", "Codex: spawn_agent"],
  ["wait_agent", "Codex: wait_agent"],
  ["send_message", "Codex: send_message"],
  ["send_input", "Codex: send_input"],
  ["followup_task", "Codex: followup_task"],
  ["close_agent", "Codex: close_agent"],
];

// Rows the product needs that no price feed carries: the tools that ship
// inside Claude Code and Codex, and the finished-work row. To price a tool of
// your own, add a row here in the same shape and run
// `npm run db:seed-pricing`.
export const BUILT_IN_ROWS: NormalizedEntry[] = [
  ...CLAUDE_CODE_FREE_TOOLS.map(([name, displayName]) =>
    freeAgentTool(name, displayName),
  ),
  ...CODEX_FREE_TOOLS.map(([name, displayName]) =>
    freeAgentTool(name, displayName),
  ),

  // The vendor bills web search per search. Claude Code sends "WebSearch",
  // which the lookup lowercases to this name.
  {
    externalId: "tool/websearch",
    displayName: "Claude Code Web Search",
    provider: "tool",
    serviceType: "Web Search",
    // One WebSearch call can run several searches, so this can under-bill.
    inputCost: 10.0,
    outputCost: null,
    costUnit: "1K requests",
    contextWindow: null,
    source: "builtin",
    isApi: true,
  },
  // Codex web search carries no tool name, so the cost meter sends the
  // literal "web_search" for it.
  {
    externalId: "tool/web_search",
    displayName: "Codex: web_search",
    provider: "tool",
    serviceType: "Web Search",
    inputCost: 10.0,
    outputCost: null,
    costUnit: "1K requests",
    contextWindow: null,
    source: "builtin",
    isApi: true,
  },

  {
    // A real 0, not a null: a null lands the record NEEDS_COST_BACKFILL and
    // the ROI tab reads it as spend that could not be priced. The provider
    // word is also the ROI read's finished-thing marker, so it must not be
    // reused.
    externalId: "outcome/work-item",
    displayName: "Finished work item",
    provider: "outcome",
    serviceType: "Finished work",
    inputCost: 0,
    outputCost: null,
    costUnit: "item",
    contextWindow: null,
    source: "builtin",
    isApi: true,
  },
];

// ============================================================
// CACHE-RATE BACKFILLS
// ============================================================

interface CacheRateBackfill {
  cacheReadCost?: number;
  cacheWriteCost?: number;
}

// Rates from the vendors' own pricing pages (ai.google.dev/gemini-api/docs/pricing,
// developers.openai.com/api/docs/pricing, and Alibaba Model Studio's
// context-cache page) for feed rows the cache-completeness check flags as
// half-priced: one cache rate published, the other absent, so the
// missing direction bills at $0. Keyed on the same `canonicalName|provider`
// the runtime lookup uses, and applied only while the feed still reports null
// — the day the feed publishes the field, its value wins and the entry here
// goes dormant instead of pinning a stale rate.
//
// Rates that look wrong but aren't: each Google :batch write encodes the
// STORAGE price printed in that model's own Batch table (per 1M token-hours,
// prorated to the 5-minute default TTL). Most models print the same storage
// price in Batch as Standard — the 50% batch discount covers token I/O only —
// so the write looks un-halved, and on 2.5 Pro that holds all the way up at
// $4.50/hr. The one exception is 3.1 Flash-Lite, whose batch tier halves
// storage ($0.50 vs $1.00), so its write is genuinely halved. And the
// gpt-5.6 *-pro rates are the non-pro vendor numbers: OpenAI doesn't
// publish the pro SKUs, which price identically to non-pro in every
// published field.
//
// The gpt-5.6-sol family is deliberately absent: the feed prices sol at
// half the vendor page on every field, so the page's 3.125 write would be
// 2.5x the feed row's input (every other OpenAI SKU: 1.25x). Keeps
// flagging until feed and page agree.
export const CACHE_RATE_BACKFILLS: Record<string, CacheRateBackfill> = {
  "gemini-2.5-flash-lite:batch|google": {
    cacheWriteCost: 0.0833333333,
  },
  "gemini-2.5-flash:batch|google": {
    cacheWriteCost: 0.0833333333,
  },
  "gemini-2.5-pro:batch|google": {
    cacheWriteCost: 0.375,
  },
  "gemini-3.1-flash-lite:batch|google": {
    cacheWriteCost: 0.0416666667,
  },
  "gemini-3.5-flash-lite:batch|google": {
    cacheWriteCost: 0.0833333333,
  },
  "gemini-3.5-flash:batch|google": {
    cacheWriteCost: 0.0833333333,
  },
  "gpt-5.6-luna-pro:batch|openai": {
    cacheWriteCost: 0.125,
  },
  "gpt-5.6-luna:batch|openai": {
    cacheWriteCost: 0.125,
  },
  "gpt-5.6-terra-pro:batch|openai": {
    cacheWriteCost: 1.25,
  },
  "gpt-5.6-terra:batch|openai": {
    cacheWriteCost: 1.25,
  },
  // Alibaba explicit cache: creation bills 125% of input (the write halves
  // already on these rows), hits bill 10% of input — of the STANDARD input
  // price, not of the 125% creation price.
  "qwen3.5-plus-20260420|qwen": {
    cacheReadCost: 0.03,
  },
  "qwen3.6-flash|qwen": {
    cacheReadCost: 0.01875,
  },
  "qwen3.6-max-preview|qwen": {
    cacheReadCost: 0.1027,
  },
  "qwen3.6-plus|qwen": {
    cacheReadCost: 0.0325,
  },
};

// ============================================================
// OUTPUT-RATE PINS
// ============================================================

interface OutputRatePin {
  outputCost: number;
  costUnit: string;
  // The feed-derived values this pin may replace. Any other value means the
  // feed moved: the pin goes quiet, the feed wins, and a price review sees the
  // change instead of a stale pin hiding it.
  replaces: Array<number | null>;
}

// Output rates from the vendor's own pricing page
// (developers.openai.com/api/docs/pricing) for feed rows whose published
// number disagrees with it. Same key shape as CACHE_RATE_BACKFILLS.
export const OUTPUT_RATE_PINS: Record<string, OutputRatePin> = {
  // OpenAI bills this alias $32 image / $10 text output; the feed still has
  // gpt-image-1's $40. Storing the image rate over-bills text output 3.2x.
  // 10 is replaceable so a feed adding the text rate can't slip under the
  // swing brake.
  "chatgpt-image-latest|openai": {
    outputCost: 32,
    costUnit: "1M tokens",
    replaces: [null, 40, 10],
  },
};

// ============================================================
// FETCH + NORMALIZE
// ============================================================

/**
 * Read one cache rate off a feed's pricing block, in dollars per 1M tokens:
 * absent/blank/unparseable → null ("no rate published"), a reported 0 → 0
 * ("this direction is free"), anything else → rate × 1e6.
 *
 * The two must never collapse: downstream a stored 0 PRICES and a NULL
 * REFUSES. 0→null strands a free model in NEEDS_COST_BACKFILL; absent→0
 * silently prices cache at nothing on the many feed models that
 * publish no cache-write rate.
 */
export function parseFeedCacheRate(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const perToken = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(perToken)) return null;
  return perToken * 1_000_000;
}

interface FeedSpec {
  source: "openrouter" | "litellm";
  label: string;
  url: string;
  fileFlag: "--openrouter-file" | "--litellm-file";
  fix: string;
}

const OPENROUTER_FEED: FeedSpec = {
  source: "openrouter",
  label: "OpenRouter",
  url: "https://openrouter.ai/api/v1/models",
  fileFlag: "--openrouter-file",
  fix: "open https://openrouter.ai/api/v1/models in a browser",
};

const LITELLM_FEED: FeedSpec = {
  source: "litellm",
  label: "LiteLLM",
  url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  fileFlag: "--litellm-file",
  fix: "open the LiteLLM model_prices_and_context_window.json on GitHub",
};

// Dry runs keep stdout to the one summary line the caller parses; every
// progress line moves to stderr for the duration of that run.
let progressToStderr = false;
function progress(line: string): void {
  if (progressToStderr) console.error(line);
  else console.log(line);
}

async function loadFeedJson(
  feed: FeedSpec,
  feedFile: string | undefined,
): Promise<unknown> {
  if (feedFile === undefined) {
    progress(`Fetching from ${feed.label}...`);
    const response = await fetch(feed.url);
    if (!response.ok)
      throw new Error(`${feed.label} returned ${response.status}`);
    return response.json();
  }

  progress(`Reading ${feed.label} feed from ${feedFile}...`);
  let text: string;
  try {
    text = fs.readFileSync(feedFile, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read the ${feed.label} feed file "${feedFile}" ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `${feed.fileFlag} must point at a file written by --save-feeds. ` +
        `Fix: check the path, or drop ${feed.fileFlag} to fetch the feed ` +
        `from ${feed.url}. Nothing was changed.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The ${feed.label} feed file "${feedFile}" is not valid JSON. It was ` +
        `probably truncated or hand-edited. Fix: re-create it with ` +
        `--save-feeds, or drop ${feed.fileFlag} to fetch the feed from ` +
        `${feed.url}. Nothing was changed.`,
    );
  }
}

export async function fetchOpenRouter(
  feedFile?: string,
): Promise<NormalizedEntry[]> {
  return normalizeOpenRouter(await loadFeedJson(OPENROUTER_FEED, feedFile));
}

export function normalizeOpenRouter(feed: unknown): NormalizedEntry[] {
  const data: any = feed;
  const models = data?.data || [];
  progress(`  Got ${models.length} models from OpenRouter`);

  const entries: NormalizedEntry[] = [];
  for (const model of models) {
    const promptCost = parseFloat(model.pricing?.prompt || "0");
    const completionCost = parseFloat(model.pricing?.completion || "0");
    // input_cache_write is the standard 5-minute-TTL creation rate (anthropic/*
    // runs ≈1.25× prompt); the Anthropic override before write replaces it with
    // the 1-hour ceiling.
    const cacheReadCost = parseFeedCacheRate(model.pricing?.input_cache_read);
    const cacheWriteCost = parseFeedCacheRate(model.pricing?.input_cache_write);

    if (promptCost === 0 && completionCost === 0) continue;
    if (model.id.includes(":free") || model.id.includes(":extended")) continue;

    // Provider is stored separately: "Anthropic: Claude 4.6" → "Claude 4.6".
    let displayName = model.name || model.id;
    displayName = displayName.replace(/^[^:]+:\s*/, "");

    entries.push({
      externalId: model.id,
      displayName,
      provider: getProvider(model.id),
      serviceType: "LLM", // OpenRouter only has chat models
      inputCost: promptCost > 0 ? promptCost * 1_000_000 : null,
      outputCost: completionCost > 0 ? completionCost * 1_000_000 : null,
      cacheReadCost,
      cacheWriteCost,
      costUnit: "1M tokens",
      contextWindow: model.context_length || null,
      source: "openrouter",
      isApi: false,
    });
  }

  progress(`  Kept ${entries.length} after filtering`);
  return entries;
}

// OpenAI bills these at the image-token rate the feed lists beside a $10 text
// rate; gpt-image-2 rows already store their image rate.
const IMAGE_RATE_OUTPUT_KEYS = new Set([
  "gpt-image-1.5",
  "gpt-image-1.5-2025-12-16",
]);

export function normalizeLiteLLM(feed: unknown): NormalizedEntry[] {
  const data: any = feed ?? {};
  const keys = Object.keys(data);
  progress(`  Got ${keys.length} entries from LiteLLM`);

  const entries: NormalizedEntry[] = [];
  for (const key of keys) {
    if (shouldSkipLiteLLM(key)) continue;

    const raw = data[key];
    const mode = raw.mode || "chat";
    const serviceType = MODE_TO_TYPE[mode] || "LLM";

    let inputCost: number | null = null;
    let outputCost: number | null = null;
    // Cache rates are LLM-only — set them solely in the per-token branch below.
    let cacheReadCost: number | null = null;
    let cacheWriteCost: number | null = null;
    let costUnit = "1M tokens";

    if (raw.input_cost_per_token != null) {
      inputCost = raw.input_cost_per_token * 1_000_000;
      // output_cost_per_image_token is the same per-token unit, so it stands in
      // when output_cost_per_token is absent. A row carrying both keeps the
      // text price: the schema holds one output rate.
      const billsImageRate =
        IMAGE_RATE_OUTPUT_KEYS.has(key) &&
        raw.output_cost_per_image_token != null;
      const outputPerToken =
        raw.output_cost_per_token != null && !billsImageRate
          ? raw.output_cost_per_token
          : raw.output_cost_per_image_token;
      outputCost = outputPerToken != null ? outputPerToken * 1_000_000 : null;
      // cache_creation_input_token_cost is the 5-minute write rate (a pricier
      // *_above_1hr also exists). Anthropic LLM rows do NOT keep this value:
      // the override before write swaps in the 1-hour ceiling so an unknown TTL
      // can never under-bill, and applyCacheWriteTtl re-bases events that prove
      // the 5m flavor.
      cacheReadCost =
        raw.cache_read_input_token_cost != null
          ? raw.cache_read_input_token_cost * 1_000_000
          : null;
      cacheWriteCost =
        raw.cache_creation_input_token_cost != null
          ? raw.cache_creation_input_token_cost * 1_000_000
          : null;
      costUnit = "1M tokens";
    } else if (raw.input_cost_per_image != null) {
      inputCost = raw.input_cost_per_image;
      outputCost = raw.output_cost_per_image ?? null;
      costUnit = "image";
    } else if (raw.input_cost_per_second != null) {
      inputCost = raw.input_cost_per_second;
      outputCost = raw.output_cost_per_second ?? null;
      costUnit = "second";
    } else if (raw.input_cost_per_character != null) {
      inputCost = raw.input_cost_per_character * 1_000_000;
      outputCost =
        raw.output_cost_per_character != null
          ? raw.output_cost_per_character * 1_000_000
          : null;
      costUnit = "1M characters";
    } else if (raw.input_cost_per_request != null) {
      inputCost = raw.input_cost_per_request;
      outputCost = raw.output_cost_per_request ?? null;
      costUnit = "request";
    }
    // Nothing in these feeds is actually free, so both costs 0/null means the
    // source reported no price at all — bad data, not a free model.
    const hasSomeCost =
      (inputCost !== null && inputCost > 0) ||
      (outputCost !== null && outputCost > 0);
    if (!hasSomeCost) continue;

    let displayName = key
      .replace(/^amazon\./, "")
      .replace(/\./, " ")
      .split(/[-_]/)
      .map((w: string) => {
        const up = w.toUpperCase();
        if (["GPT", "AI", "XL", "DALL", "TTS", "HD", "SD"].includes(up))
          return up;
        if (w.match(/^v\d/i)) return w.toLowerCase();
        if (w.match(/^\d/)) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    entries.push({
      externalId: `litellm/${key}`,
      displayName,
      provider: getProvider(key, raw.litellm_provider),
      serviceType,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWriteCost,
      costUnit,
      contextWindow: raw.max_input_tokens ?? raw.max_tokens ?? null,
      source: "litellm",
      isApi: false,
    });
  }

  progress(`  Kept ${entries.length} after filtering`);
  return entries;
}

// ============================================================
// DEDUPLICATE
// ============================================================

// Dedupe key = `${canonicalName}|${provider}` — the same key runtime lookup
// uses, so two rows sharing it would collide at query time. OpenRouter-first
// preference is preserved by insert order.
function dedupeKey(entry: NormalizedEntry): string {
  return `${toCanonical(entry.externalId)}|${entry.provider.toLowerCase()}`;
}

// Prices only, never row identity: the feeds spell some makers differently
// (OpenRouter "z-ai" and "moonshotai", LiteLLM "zai" and "moonshot").
function priceCandidateKey(entry: NormalizedEntry): string {
  const provider = entry.provider.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${priceModelName(entry.externalId)}|${provider === "moonshot" ? "moonshotai" : provider}`;
}

// Novita appends "/community" after the model name, so the last segment alone
// would price deepseek-v3/community at deepseek-r1/community's rate.
function priceModelName(externalId: string): string {
  const segments = externalId.toLowerCase().split("/");
  return segments.length > 2 && segments[segments.length - 1] === "community"
    ? segments.slice(-2).join("/")
    : toCanonical(externalId);
}

// Both feeds price this alias at an older Flash; Google moved it onto
// gemini-3.5-flash (ai.google.dev/gemini-api/docs/changelog). This entry is wrong the day Google
// repoints the alias again.
const ALIAS_PRICE_TARGETS: Record<string, string> = {
  "gemini-flash-latest|google": "gemini-3.5-flash|google",
};

const AWS_REGION_SEGMENT = /\/[a-z]{2}(-gov)?-[a-z]+-\d\//;
const SIZED_IMAGE_SEGMENT = /\/(low|medium|high|standard|hd|auto)\/\d+-x-\d+\//;

const PRICE_FIELDS = [
  "inputCost",
  "outputCost",
  "cacheReadCost",
  "cacheWriteCost",
] as const;

/** Safety net: rows with both costs 0/null are bad upstream data, not free models. */
function hasValidCost(entry: NormalizedEntry): boolean {
  return (
    (entry.inputCost !== null && entry.inputCost > 0) ||
    (entry.outputCost !== null && entry.outputCost > 0)
  );
}

// A GovCloud key bills 1.2x and a sized key bills per image, so neither may
// price or claim the plain key for the same model.
function withoutRegionAndSizedVariants(
  litellm: NormalizedEntry[],
): NormalizedEntry[] {
  const isRegion = (entry: NormalizedEntry) =>
    AWS_REGION_SEGMENT.test(entry.externalId);
  const isSized = (entry: NormalizedEntry) =>
    SIZED_IMAGE_SEGMENT.test(entry.externalId);
  const unsegmentedKeys = new Set(
    litellm.filter((entry) => !isRegion(entry)).map(dedupeKey),
  );
  const unsizedKeys = new Set(
    litellm.filter((entry) => !isSized(entry)).map(dedupeKey),
  );
  return litellm.filter(
    (entry) =>
      !(isRegion(entry) && unsegmentedKeys.has(dedupeKey(entry))) &&
      !(isSized(entry) && unsizedKeys.has(dedupeKey(entry))),
  );
}

// Highest wins so neither a stale feed nor an OpenRouter-funded discount
// under-bills. A cache rate only the other feed publishes stays out: LiteLLM's
// $3 cached input for gpt-5.5-pro is a discount OpenAI says it doesn't offer.
function withHighestPrices(
  winner: NormalizedEntry,
  candidates: NormalizedEntry[],
): NormalizedEntry {
  const priced = { ...winner };
  for (const field of PRICE_FIELDS) {
    const publishers = candidates.filter(
      (candidate) =>
        candidate.costUnit === winner.costUnit && candidate[field] != null,
    );
    const isCacheRate = field === "cacheReadCost" || field === "cacheWriteCost";
    const winnerFeedPublishes = publishers.some(
      (candidate) => candidate.source === winner.source,
    );
    const adopted = isCacheRate && !winnerFeedPublishes ? [] : publishers;
    priced[field] =
      adopted.length > 0
        ? Math.max(...adopted.map((candidate) => candidate[field] as number))
        : null;
  }
  return priced;
}

function deduplicate(
  openRouter: NormalizedEntry[],
  litellm: NormalizedEntry[],
): NormalizedEntry[] {
  const openRouterPriced = openRouter.filter(hasValidCost);
  const litellmPriced = withoutRegionAndSizedVariants(
    litellm.filter(hasValidCost),
  );
  const winners = new Map<string, NormalizedEntry>();

  // OpenRouter first: it has the better LLM names, so it wins the key slot.
  for (const entry of openRouterPriced) {
    winners.set(dedupeKey(entry), entry);
  }

  // LiteLLM supplies the non-LLM types OpenRouter doesn't cover; its LLM rows
  // only fill slots OpenRouter left empty.
  for (const entry of litellmPriced) {
    const key = dedupeKey(entry);
    if (entry.serviceType !== "LLM" || !winners.has(key)) {
      winners.set(key, entry);
    }
  }

  const candidatesByKey = new Map<string, NormalizedEntry[]>();
  for (const entry of [...openRouterPriced, ...litellmPriced]) {
    const key = priceCandidateKey(entry);
    candidatesByKey.set(key, [...(candidatesByKey.get(key) ?? []), entry]);
  }
  for (const [alias, target] of Object.entries(ALIAS_PRICE_TARGETS)) {
    candidatesByKey.set(alias, [
      ...(candidatesByKey.get(alias) ?? []),
      ...(candidatesByKey.get(target) ?? []),
    ]);
  }

  return Array.from(winners.values(), (winner) =>
    withHighestPrices(
      winner,
      candidatesByKey.get(priceCandidateKey(winner)) ?? [winner],
    ),
  );
}

// ============================================================
// BUILD THE CATALOG (shared by the real run and the dry run)
// ============================================================

/** Exactly the columns one upsert writes to service_pricing. */
export interface CatalogRow {
  externalId: string;
  canonicalName: string;
  displayName: string;
  provider: string;
  serviceType: string;
  inputCost: number | null;
  outputCost: number | null;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  costUnit: string;
  contextWindow: number | null;
  source: string;
  isApi: boolean;
  isActive: boolean;
}

export interface CatalogBuild {
  rows: CatalogRow[];
  /** Remote rows surviving dedupe, before the built-in rows join them. */
  mergedRemoteCount: number;
}

// service_pricing money columns are Decimal(18,10). Rounding here makes the
// dry-run file equal the persisted value instead of float noise such as
// 0.39999999999999997 (4e-7 x 1e6); the upsert stores the same number either way.
function toDbScale(value: number | null | undefined): number | null {
  return value == null ? null : Number(value.toFixed(10));
}

/**
 * Any pricing logic added to one path must land here so the real run and
 * --dry-run can never disagree.
 */
export function buildCatalogRows(
  openRouterEntries: NormalizedEntry[],
  litellmEntries: NormalizedEntry[],
): CatalogBuild {
  const merged = deduplicate(openRouterEntries, litellmEntries);

  // Sanity floor: zero remote entries means both feeds are down or
  // garbage. Continuing would let the retire step deactivate every feed row,
  // the entire live LLM catalog. Exactly zero is the right floor:
  // BUILT_IN_ROWS is compiled in and can never be empty, so any higher number
  // would be a guess about upstream catalog size.
  if (merged.length === 0) {
    throw new Error(
      "Sync aborted before any database write: OpenRouter and LiteLLM both " +
        "returned zero usable pricing entries. This usually means both sources " +
        "are down, unreachable from this machine, or changed their response " +
        "format. If the sync had continued, the retire step would have " +
        "deactivated the entire live model catalog. Fix: open " +
        "https://openrouter.ai/api/v1/models and the LiteLLM " +
        "model_prices_and_context_window.json on GitHub in a browser — once " +
        "they return data again, re-run this script. Nothing was changed.",
    );
  }

  return {
    rows: finishCatalogRows(merged),
    mergedRemoteCount: merged.length,
  };
}

/**
 * Also the offline seed's entry point (seed-pricing.ts feeds it the committed
 * snapshot's rows), so every override below must stay a no-op over its own
 * output: fill a hole or replace a listed value, never compound.
 */
export function finishCatalogRows(merged: NormalizedEntry[]): CatalogRow[] {
  // Copies, so the overrides below never mutate BUILT_IN_ROWS between runs.
  const all = [...merged, ...BUILT_IN_ROWS].map((entry) => ({ ...entry }));

  // Unit gate: calculateEventCost prices an unknown unit with flat
  // per-unit math and no error, so a typo'd or novel costUnit would mis-cost
  // every event against that row. Abort the whole run instead.
  const unknownUnitRows = all.filter(
    (entry) => !KNOWN_COST_UNITS.has(entry.costUnit),
  );
  if (unknownUnitRows.length > 0) {
    const offenders = unknownUnitRows
      .slice(0, 10)
      .map((entry) => `"${entry.externalId}" (costUnit "${entry.costUnit}")`)
      .join(", ");
    throw new Error(
      `Sync aborted before any database write: ${unknownUnitRows.length} ` +
        `row(s) carry a costUnit outside the known-unit list: ${offenders}. ` +
        `This is usually a typo in BUILT_IN_ROWS or a new unit shape from an ` +
        `upstream feed. An unrecognized unit has no branch in ` +
        `calculateEventCost and would silently fall through to flat ` +
        `per-unit math, mis-costing every event priced against the row. ` +
        `Fix: correct the unit, or — if it's genuinely new — confirm ` +
        `calculateEventCost (packages/db/src/lib/model-pricing.ts) handles ` +
        `it, then add it to KNOWN_COST_UNITS in this script. Nothing was changed.`,
    );
  }

  // Anthropic bills cache writes at 1.25× base input for a 5-minute TTL and 2×
  // for a 1-hour TTL, and the feeds report the 5-minute rate. Store the 1-hour
  // ceiling so a cached event can never under-bill whichever TTL the session
  // used. First-party anthropic LLM rows only — no other provider bills a
  // cache write.
  for (const entry of all) {
    if (
      entry.provider.toLowerCase() === "anthropic" &&
      entry.serviceType === "LLM" &&
      entry.inputCost != null &&
      entry.inputCost > 0
    ) {
      entry.cacheWriteCost = entry.inputCost * 2;
    }
  }

  // Fills only a hole: the loose == null deliberately spares a feed-priced
  // zero.
  for (const entry of all) {
    const backfill =
      CACHE_RATE_BACKFILLS[
        `${toCanonical(entry.externalId)}|${entry.provider.toLowerCase()}`
      ];
    if (!backfill) continue;
    if (backfill.cacheReadCost !== undefined && entry.cacheReadCost == null) {
      entry.cacheReadCost = backfill.cacheReadCost;
    }
    if (backfill.cacheWriteCost !== undefined && entry.cacheWriteCost == null) {
      entry.cacheWriteCost = backfill.cacheWriteCost;
    }
  }

  for (const entry of all) {
    const pin =
      OUTPUT_RATE_PINS[
        `${toCanonical(entry.externalId)}|${entry.provider.toLowerCase()}`
      ];
    if (!pin || entry.costUnit !== pin.costUnit) continue;
    if (!pin.replaces.includes(toDbScale(entry.outputCost))) continue;
    entry.outputCost = pin.outputCost;
  }

  // Upserts are keyed on externalId, so when a feed entry shares one with a
  // built-in row only the later (built-in) write survives. Collapse here so the
  // row list is the persisted state, not the write sequence.
  const byExternalId = new Map<string, CatalogRow>();
  for (const entry of all) {
    byExternalId.set(entry.externalId, {
      externalId: entry.externalId,
      canonicalName: toCanonical(entry.externalId),
      displayName: entry.displayName,
      provider: entry.provider.toLowerCase(),
      serviceType: entry.serviceType,
      inputCost: toDbScale(entry.inputCost),
      outputCost: toDbScale(entry.outputCost),
      cacheReadCost: toDbScale(entry.cacheReadCost),
      cacheWriteCost: toDbScale(entry.cacheWriteCost),
      costUnit: entry.costUnit,
      contextWindow: entry.contextWindow,
      source: entry.source,
      isApi: entry.isApi,
      isActive: true,
    });
  }

  return Array.from(byExternalId.values());
}

// ============================================================
// CLI
// ============================================================

export interface SyncOptions {
  dryRun?: boolean;
  out?: string;
  litellmFile?: string;
  openRouterFile?: string;
  saveFeeds?: string;
  litellmOnly?: boolean;
}

const USAGE =
  "Usage: npx tsx packages/db/scripts/sync-service-pricing.ts " +
  "[--dry-run --out <file.json> [--litellm-file <path>] " +
  "[--openrouter-file <path>]] [--save-feeds <dir>] [--litellm-only]";

export function parseCliArgs(argv: string[]): SyncOptions {
  const valueFlags: Record<
    string,
    "out" | "litellmFile" | "openRouterFile" | "saveFeeds"
  > = {
    "--out": "out",
    "--litellm-file": "litellmFile",
    "--openrouter-file": "openRouterFile",
    "--save-feeds": "saveFeeds",
  };
  const options: SyncOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--litellm-only") {
      options.litellmOnly = true;
      continue;
    }
    const key = valueFlags[arg];
    if (key === undefined) {
      throw new Error(
        `Unknown argument "${arg}". The script did not run. ${USAGE}`,
      );
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(
        `${arg} needs a path after it, but none was given. The script did ` +
          `not run. ${USAGE}`,
      );
    }
    options[key] = value;
    i += 1;
  }
  if (options.dryRun && options.out === undefined) {
    throw new Error(
      `--dry-run needs --out <file.json> to say where the computed catalog ` +
        `goes. The script did not run. ${USAGE}`,
    );
  }
  if (options.out !== undefined && !options.dryRun) {
    throw new Error(
      `--out only applies to a dry run, and this would have been a real ` +
        `database sync. Add --dry-run to write the catalog to a file instead, ` +
        `or drop --out to sync. The script did not run. ${USAGE}`,
    );
  }
  const feedFileFlags = [
    options.litellmFile === undefined ? null : "--litellm-file",
    options.openRouterFile === undefined ? null : "--openrouter-file",
  ].filter((flag) => flag !== null);
  if (feedFileFlags.length > 0 && !options.dryRun) {
    throw new Error(
      `${feedFileFlags.join(" and ")} only work with --dry-run, and this ` +
        `would have been a real database sync. A real sync must price from ` +
        `the live feeds: a stale or edited feed file would overwrite live ` +
        `prices and retire every row missing from it. Fix: drop the flag to ` +
        `sync from the network, or add --dry-run --out <file.json> to replay ` +
        `the file. The script did not run. ${USAGE}`,
    );
  }
  if (options.litellmOnly && options.openRouterFile !== undefined) {
    throw new Error(
      `--litellm-only skips the OpenRouter feed, so --openrouter-file would ` +
        `never be read. Fix: drop one of the two. The script did not run. ` +
        `${USAGE}`,
    );
  }
  return options;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unwritableMessage(
  flag: "--out" | "--save-feeds",
  target: string,
  reason: string,
): string {
  const shape = flag === "--out" ? "file path" : "directory";
  const example = flag === "--out" ? "./catalog.json" : "./feeds";
  return (
    `Could not write to "${target}" for ${flag} (${reason}). ${flag} must ` +
    `point at a ${shape} this user can write to. Fix: choose a path under a ` +
    `directory you own, for example ${example}. Nothing was changed.`
  );
}

// Runs before the feeds load so a bad path fails in milliseconds instead of
// after two network round trips. Creates the directory, never the file: an
// aborted run must leave no --out behind.
function assertWritablePath(
  flag: "--out" | "--save-feeds",
  target: string,
): void {
  const resolved = path.resolve(target);
  const dir = flag === "--save-feeds" ? resolved : path.dirname(resolved);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    if (
      flag === "--out" &&
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isDirectory()
    ) {
      throw new Error("it is a directory, not a file");
    }
  } catch (err) {
    throw new Error(unwritableMessage(flag, target, describeError(err)));
  }
}

function writeFileOrExplain(
  flag: "--out" | "--save-feeds",
  filePath: string,
  content: string,
): void {
  try {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, content);
  } catch (err) {
    throw new Error(unwritableMessage(flag, filePath, describeError(err)));
  }
}

// Sorted by code point, not locale, so two machines produce identical files.
function writeDryRunCatalog(rows: CatalogRow[], outFile: string): void {
  const sorted = [...rows].sort((a, b) =>
    a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0,
  );
  writeFileOrExplain("--out", outFile, JSON.stringify(sorted, null, 2) + "\n");
}

function saveRawFeed(dir: string, feed: FeedSpec, raw: unknown): void {
  writeFileOrExplain(
    "--save-feeds",
    path.join(dir, `${feed.source}.json`),
    JSON.stringify(raw),
  );
}

// Aborts even for OpenRouter, which may otherwise be empty: a format change
// would hide behind a stderr warning, and could as easily yield rows that
// parse into wrong prices.
function normalizeOrAbort(
  feed: FeedSpec,
  raw: unknown,
  normalize: (raw: unknown) => NormalizedEntry[],
): NormalizedEntry[] {
  if (raw === null) return [];
  try {
    return normalize(raw);
  } catch (err) {
    throw new Error(
      `The ${feed.label} feed loaded but has an entry this script cannot ` +
        `read (${describeError(err)}). The feed format probably changed, or ` +
        `a saved feed file was hand-edited. Sync aborted before any database ` +
        `write. Fix: open ${feed.url}, find the entry that no longer matches ` +
        `normalize${feed.label} in packages/db/scripts/sync-service-pricing.ts ` +
        `and update the parser; a feed file can also be re-created with ` +
        `--save-feeds. Nothing was changed.`,
    );
  }
}

// ============================================================
// MAIN
// ============================================================

export async function main(options: SyncOptions = {}) {
  progressToStderr = options.dryRun === true;
  try {
    await run(options);
  } finally {
    progressToStderr = false;
  }
}

async function run(options: SyncOptions) {
  progress(
    options.dryRun
      ? "=== Syncing Service Pricing (DRY RUN — no database) ===\n"
      : "=== Syncing Service Pricing ===\n",
  );

  if (options.dryRun) assertWritablePath("--out", options.out as string);
  if (options.saveFeeds !== undefined) {
    assertWritablePath("--save-feeds", options.saveFeeds);
  }

  // A feed that fails to FETCH loads as empty so the empty-feed checks below
  // name it. A feed FILE that fails to load aborts here instead, as does a
  // feed that no longer parses (normalizeOrAbort).
  async function loadFeed(
    feed: FeedSpec,
    feedFile: string | undefined,
  ): Promise<unknown> {
    if (feedFile !== undefined) return loadFeedJson(feed, feedFile);
    try {
      return await loadFeedJson(feed, undefined);
    } catch (err) {
      console.error(`${feed.label} fetch failed:`, err);
      return null;
    }
  }

  const openRouterRaw = options.litellmOnly
    ? null
    : await loadFeed(OPENROUTER_FEED, options.openRouterFile);
  const litellmRaw = await loadFeed(LITELLM_FEED, options.litellmFile);

  if (options.saveFeeds !== undefined) {
    for (const [feed, raw] of [
      [OPENROUTER_FEED, openRouterRaw],
      [LITELLM_FEED, litellmRaw],
    ] as const) {
      if (feed === OPENROUTER_FEED && options.litellmOnly) continue;
      if (raw === null) {
        console.error(
          `WARNING: ${feed.label} did not load, so ${options.saveFeeds}/` +
            `${feed.source}.json was not written.`,
        );
        continue;
      }
      saveRawFeed(options.saveFeeds, feed, raw);
    }
  }

  const openRouterEntries = normalizeOrAbort(
    OPENROUTER_FEED,
    openRouterRaw,
    normalizeOpenRouter,
  );
  const litellmEntries = normalizeOrAbort(
    LITELLM_FEED,
    litellmRaw,
    normalizeLiteLLM,
  );

  if (!litellmEntries.some(hasValidCost)) {
    throw new Error(
      `Sync aborted before any database write: LiteLLM returned zero ` +
        `usable pricing entries. The source is probably down, unreachable ` +
        `from this machine, or changed its response format. If the sync had ` +
        `continued, the retire step would have switched off most of the ` +
        `catalog. Fix: ${LITELLM_FEED.fix}; once it returns data again, ` +
        `re-run this script. Nothing was changed.`,
    );
  }
  if (!options.litellmOnly && !openRouterEntries.some(hasValidCost)) {
    console.error(
      `WARNING: OpenRouter returned zero usable pricing entries, so this ` +
        `run prices from LiteLLM alone and switches off the OpenRouter rows. ` +
        `To add them back, ${OPENROUTER_FEED.fix} and re-run this script ` +
        `once it returns data.`,
    );
  }

  const { rows, mergedRemoteCount } = buildCatalogRows(
    openRouterEntries,
    litellmEntries,
  );

  const totalRaw = openRouterEntries.length + litellmEntries.length;
  const droppedInMerge = totalRaw - mergedRemoteCount;

  progress(`\nFinal counts:`);
  progress(
    `  OpenRouter: ${options.litellmOnly ? "skipped" : openRouterEntries.length}`,
  );
  progress(`  LiteLLM: ${litellmEntries.length}`);
  progress(`  Merged models: ${mergedRemoteCount}`);
  progress(`  Dropped in merge: ${droppedInMerge} (duplicates + zero-cost)`);
  progress(`  Built-in rows: ${BUILT_IN_ROWS.length}`);
  progress(`  Total: ${rows.length}`);

  const byType: Record<string, number> = {};
  for (const row of rows) {
    byType[row.serviceType] = (byType[row.serviceType] || 0) + 1;
  }
  progress(`\nBy service type:`);
  for (const [type, count] of Object.entries(byType).sort(
    (a, b) => b[1] - a[1],
  )) {
    progress(`  ${type}: ${count}`);
  }

  if (options.dryRun) {
    const outFile = options.out as string;
    writeDryRunCatalog(rows, outFile);
    const bySource: Record<string, number> = {};
    for (const row of rows) {
      bySource[row.source] = (bySource[row.source] || 0) + 1;
    }
    const sourceCounts = Object.entries(bySource)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([source, count]) => `${source} ${count}`)
      .join(", ");
    console.log(
      `Dry run: wrote ${rows.length} catalog rows to ${outFile} ` +
        `(${sourceCounts}); no database was touched.`,
    );
    return;
  }

  progress(`\nWriting to database...`);

  // Never delete: a delete cascades into org_model_mappings/signal_services and
  // wipes every model mapping. Upsert on externalId keeps ids
  // stable; rows gone from upstream are retired (isActive=false) instead.
  const existingExternalIds = new Set(
    (await db().service_pricing.findMany({ select: { externalId: true } })).map(
      (row) => row.externalId,
    ),
  );

  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const { externalId, ...columns } = row;
    await db().service_pricing.upsert({
      where: { externalId },
      create: row,
      update: columns,
    });
    if (existingExternalIds.has(externalId)) {
      updated += 1;
    } else {
      created += 1;
    }
    const processed = created + updated;
    if (processed % 500 === 0 || processed === rows.length) {
      progress(`  Upserted ${processed}/${rows.length}`);
    }
  }

  const { count: retired } = await db().service_pricing.updateMany({
    where: {
      externalId: { notIn: rows.map((row) => row.externalId) },
      source: { in: ["builtin", "openrouter", "litellm"] },
      isActive: true,
    },
    data: { isActive: false },
  });

  progress(
    `\nDone. ${created} created, ${updated} updated, ${retired} retired (isActive=false).`,
  );
  await db().$disconnect();
}

// Guarded so tests can import main() without firing a real sync (network + process.exit) on load.
if (require.main === module) {
  Promise.resolve()
    .then(() => main(parseCliArgs(process.argv.slice(2))))
    .catch((err) => {
      console.error("Sync failed:", err);
      prismaClient?.$disconnect();
      process.exit(1);
    });
}
