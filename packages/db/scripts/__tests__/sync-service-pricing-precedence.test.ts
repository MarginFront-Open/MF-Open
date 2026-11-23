/**
 * Hermetic: the Prisma client and fetch both throw if touched; feed files live
 * in a temp directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      throw new Error(
        "precedence tests must never construct a database client",
      );
    }
  },
}));

import {
  BUILT_IN_ROWS,
  buildCatalogRows,
  main,
  normalizeLiteLLM,
  normalizeOpenRouter,
  type CatalogRow,
} from "../sync-service-pricing";

// Unrelated entries: a real run aborts unless LiteLLM carries one.
const OR_GPT_4O = {
  id: "openai/gpt-4o",
  name: "OpenAI: GPT-4o",
  pricing: { prompt: "0.0000025", completion: "0.00001" },
  context_length: 128000,
};
const LL_WHISPER = {
  "whisper-1": {
    mode: "audio_transcription",
    input_cost_per_second: 0.0001,
    litellm_provider: "openai",
  },
};

// Feed entries in each feed's shape, trimmed to parsed fields.
const OR_GPT_56_SOL = {
  id: "openai/gpt-5.6-sol",
  name: "OpenAI: GPT-5.6 Sol",
  pricing: {
    prompt: "0.000002",
    completion: "0.00001",
    input_cache_read: "0.0000002",
    input_cache_write: "0.0000025",
  },
  context_length: 1050000,
};
const LL_GPT_56_SOL = {
  mode: "chat",
  litellm_provider: "openai",
  max_input_tokens: 922000,
  input_cost_per_token: 4e-6,
  output_cost_per_token: 2e-5,
  cache_read_input_token_cost: 4e-7,
  cache_creation_input_token_cost: 5e-6,
};
const OR_GPT_55_PRO = {
  id: "openai/gpt-5.5-pro",
  name: "OpenAI: GPT-5.5 Pro",
  pricing: { prompt: "0.00003", completion: "0.00018" },
  context_length: 1050000,
};
const LL_GPT_55_PRO = {
  mode: "responses",
  litellm_provider: "openai",
  max_input_tokens: 1050000,
  input_cost_per_token: 3e-5,
  output_cost_per_token: 0.00018,
  cache_read_input_token_cost: 3e-6,
};
const OR_GLM_52 = {
  id: "z-ai/glm-5.2",
  name: "Z.ai: GLM 5.2",
  pricing: {
    prompt: "0.0000004875",
    completion: "0.00000156",
    input_cache_read: "0.000000091",
  },
  context_length: 1048576,
};
const LL_GLM_52 = {
  mode: "chat",
  litellm_provider: "zai",
  max_input_tokens: 1000000,
  input_cost_per_token: 1.4e-6,
  output_cost_per_token: 4.4e-6,
  cache_read_input_token_cost: 2.6e-7,
  cache_creation_input_token_cost: 0,
};
const OR_KIMI_K27_CODE = {
  id: "moonshotai/kimi-k2.7-code",
  name: "MoonshotAI: Kimi K2.7 Code",
  pricing: {
    prompt: "0.00000071",
    completion: "0.0000035",
    input_cache_read: "0.00000015",
  },
  context_length: 262144,
};
const LL_KIMI_K27_CODE = {
  mode: "chat",
  litellm_provider: "moonshot",
  max_input_tokens: 262144,
  input_cost_per_token: 9.5e-7,
  output_cost_per_token: 4e-6,
  cache_read_input_token_cost: 1.9e-7,
};
const OR_GEMINI_3_PRO_IMAGE = {
  id: "google/gemini-3-pro-image",
  name: "Google: Nano Banana Pro (Gemini 3 Pro Image)",
  pricing: {
    prompt: "0.000002",
    completion: "0.000012",
    input_cache_read: "0.0000002",
    input_cache_write: "0.000000375",
  },
  context_length: 131072,
};
const LL_GEMINI_3_PRO_IMAGE = {
  mode: "image_generation",
  litellm_provider: "gemini",
  max_input_tokens: 65536,
  input_cost_per_token: 2e-6,
  output_cost_per_token: 1.2e-5,
  output_cost_per_image_token: 0.00012,
  input_cost_per_image: 0.0011,
  output_cost_per_image: 0.134,
};
const LL_GPT_IMAGE_1 = {
  mode: "image_generation",
  litellm_provider: "openai",
  input_cost_per_token: 5e-6,
  output_cost_per_image_token: 4e-5,
  cache_read_input_token_cost: 1.25e-6,
};
const LL_GPT_IMAGE_15 = {
  mode: "image_generation",
  litellm_provider: "openai",
  input_cost_per_token: 5e-6,
  output_cost_per_token: 1e-5,
  output_cost_per_image_token: 3.2e-5,
  cache_read_input_token_cost: 1.25e-6,
};
const LL_CHATGPT_IMAGE_LATEST = {
  mode: "image_generation",
  litellm_provider: "openai",
  input_cost_per_token: 5e-6,
  output_cost_per_image_token: 4e-5,
  cache_read_input_token_cost: 1.25e-6,
};
const LL_CLAUDE_4_SONNET = {
  mode: "chat",
  litellm_provider: "anthropic",
  max_input_tokens: 1000000,
  input_cost_per_token: 3e-6,
  output_cost_per_token: 1.5e-5,
  cache_read_input_token_cost: 3e-7,
  cache_creation_input_token_cost: 3.75e-6,
};
const LL_BEDROCK_GPT_54 = {
  mode: "responses",
  litellm_provider: "bedrock_mantle",
  max_input_tokens: 1050000,
  input_cost_per_token: 2.75e-6,
  output_cost_per_token: 1.65e-5,
  cache_read_input_token_cost: 2.75e-7,
};
const LL_BEDROCK_GOV_GPT_54 = {
  ...LL_BEDROCK_GPT_54,
  input_cost_per_token: 3.3e-6,
  output_cost_per_token: 1.98e-5,
  cache_read_input_token_cost: 3.3e-7,
};

function build(
  openRouterModels: object[],
  litellm: Record<string, object>,
): Map<string, CatalogRow> {
  const { rows } = buildCatalogRows(
    normalizeOpenRouter({ data: [OR_GPT_4O, ...openRouterModels] }),
    normalizeLiteLLM({ ...LL_WHISPER, ...litellm }),
  );
  return new Map(rows.map((row) => [row.externalId, row]));
}

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-precedence-"));
  vi.stubGlobal("fetch", async () => {
    throw new Error("precedence tests must never reach the network");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("vendor-price precedence", () => {
  it("(a) candidates: every LiteLLM entry on the key plus OpenRouter's price, with z-ai meeting zai and moonshotai meeting moonshot", () => {
    const rows = build([OR_GLM_52, OR_KIMI_K27_CODE], {
      "zai/glm-5.2": LL_GLM_52,
      "moonshot/kimi-k2.7-code": LL_KIMI_K27_CODE,
      "gpt-9": {
        mode: "chat",
        litellm_provider: "openai",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
      "openai/gpt-9": {
        mode: "chat",
        litellm_provider: "openai",
        input_cost_per_token: 3e-6,
        output_cost_per_token: 4e-6,
      },
    });

    expect(rows.get("z-ai/glm-5.2")).toMatchObject({
      inputCost: 1.4,
      outputCost: 4.4,
      cacheReadCost: 0.26,
    });
    expect(rows.get("moonshotai/kimi-k2.7-code")).toMatchObject({
      inputCost: 0.95,
      outputCost: 4,
      cacheReadCost: 0.19,
    });
    expect(rows.get("litellm/gpt-9")).toMatchObject({
      inputCost: 3,
      outputCost: 4,
    });
    expect(rows.has("litellm/openai/gpt-9")).toBe(false);
  });

  it("(b) every price is the highest candidate; a cache rate only the other feed publishes is adopted only by that feed's own row", () => {
    const rows = build([OR_GLM_52], { "zai/glm-5.2": LL_GLM_52 });

    expect(rows.get("z-ai/glm-5.2")).toMatchObject({
      source: "openrouter",
      inputCost: 1.4,
      outputCost: 4.4,
      cacheReadCost: 0.26,
      cacheWriteCost: null,
    });
    expect(rows.get("litellm/zai/glm-5.2")).toMatchObject({
      source: "litellm",
      inputCost: 1.4,
      outputCost: 4.4,
      cacheReadCost: 0.26,
      cacheWriteCost: 0,
    });
  });

  it("(c) a candidate in another unit never mixes into the row", () => {
    const rows = build(
      [
        {
          id: "google/imagen-5",
          name: "Google: Imagen 5",
          pricing: { prompt: "0.000002", completion: "0.000012" },
          context_length: 32768,
        },
      ],
      {
        "gemini/imagen-5": {
          mode: "image_generation",
          litellm_provider: "gemini",
          input_cost_per_image: 0.04,
        },
      },
    );

    expect(rows.get("litellm/gemini/imagen-5")).toMatchObject({
      costUnit: "image",
      inputCost: 0.04,
      outputCost: null,
    });
    expect(rows.has("google/imagen-5")).toBe(false);
  });

  it("(d) an AWS region key never competes with the unsegmented key", () => {
    const rows = build([], {
      "bedrock_mantle/openai.gpt-5.4": LL_BEDROCK_GPT_54,
      "bedrock_mantle/us-gov-west-1/openai.gpt-5.4": LL_BEDROCK_GOV_GPT_54,
    });

    expect(rows.get("litellm/bedrock_mantle/openai.gpt-5.4")).toMatchObject({
      inputCost: 2.75,
      outputCost: 16.5,
      cacheReadCost: 0.275,
    });
    expect(
      rows.has("litellm/bedrock_mantle/us-gov-west-1/openai.gpt-5.4"),
    ).toBe(false);
  });

  it("(e) sized per-image keys never compete with the unsized row; a model with only sized rows takes the highest sized price", () => {
    const rows = build([], {
      "gpt-image-1": LL_GPT_IMAGE_1,
      "low/1024-x-1024/gpt-image-1": {
        mode: "image_generation",
        litellm_provider: "openai",
        input_cost_per_image: 0.011,
      },
      "medium/1536-x-1024/gpt-image-1": {
        mode: "image_generation",
        litellm_provider: "openai",
        input_cost_per_image: 0.063,
      },
      "high/1024-x-1024/gpt-image-9": {
        mode: "image_generation",
        litellm_provider: "openai",
        input_cost_per_image: 0.19,
      },
      "low/1024-x-1024/gpt-image-9": {
        mode: "image_generation",
        litellm_provider: "openai",
        input_cost_per_image: 0.02,
      },
    });

    expect(rows.get("litellm/gpt-image-1")).toMatchObject({
      costUnit: "1M tokens",
      inputCost: 5,
      outputCost: 40,
      cacheReadCost: 1.25,
    });
    expect(rows.has("litellm/medium/1536-x-1024/gpt-image-1")).toBe(false);
    expect(rows.get("litellm/low/1024-x-1024/gpt-image-9")).toMatchObject({
      costUnit: "image",
      inputCost: 0.19,
    });
    expect(rows.has("litellm/high/1024-x-1024/gpt-image-9")).toBe(false);
  });

  it("(f) identity stays today's winner's; only the four prices change", () => {
    const rows = build([OR_GPT_56_SOL, OR_GEMINI_3_PRO_IMAGE], {
      "gpt-5.6-sol": LL_GPT_56_SOL,
      "gemini/gemini-3-pro-image": LL_GEMINI_3_PRO_IMAGE,
    });

    expect(rows.get("openai/gpt-5.6-sol")).toMatchObject({
      displayName: "GPT-5.6 Sol",
      provider: "openai",
      costUnit: "1M tokens",
      serviceType: "LLM",
      contextWindow: 1050000,
      source: "openrouter",
    });
    expect(rows.has("litellm/gpt-5.6-sol")).toBe(false);
    expect(rows.get("litellm/gemini/gemini-3-pro-image")).toMatchObject({
      serviceType: "Image Generation",
      source: "litellm",
      contextWindow: 65536,
    });
    expect(rows.has("google/gemini-3-pro-image")).toBe(false);
    expect(rows.size).toBe(2 + 2 + BUILT_IN_ROWS.length);
  });

  it("(g) the gpt-image-1.5 token rows store the $32 image output rate; chatgpt-image-latest's pin still yields 32", () => {
    const rows = build([OR_GEMINI_3_PRO_IMAGE], {
      "gpt-image-1.5": LL_GPT_IMAGE_15,
      "standard/1536-x-1024/gpt-image-1.5": {
        mode: "image_generation",
        litellm_provider: "openai",
        input_cost_per_image: 0.013,
      },
      "gpt-image-1.5-2025-12-16": LL_GPT_IMAGE_15,
      "chatgpt-image-latest": LL_CHATGPT_IMAGE_LATEST,
      "gemini/gemini-3-pro-image": LL_GEMINI_3_PRO_IMAGE,
    });

    for (const id of [
      "litellm/gpt-image-1.5",
      "litellm/gpt-image-1.5-2025-12-16",
    ]) {
      expect(rows.get(id), id).toMatchObject({
        costUnit: "1M tokens",
        inputCost: 5,
        outputCost: 32,
        cacheReadCost: 1.25,
      });
    }
    expect(rows.has("litellm/standard/1536-x-1024/gpt-image-1.5")).toBe(false);
    expect(rows.get("litellm/chatgpt-image-latest")).toMatchObject({
      outputCost: 32,
    });
    expect(rows.get("litellm/gemini/gemini-3-pro-image")!.outputCost).toBe(12);
  });

  it("(h) a LiteLLM feed with zero usable entries aborts before any write; an OpenRouter feed with none leaves LiteLLM to price alone", async () => {
    const out = path.join(tempDir, "catalog.json");
    const openRouterFile = path.join(tempDir, "openrouter.json");
    const litellmFile = path.join(tempDir, "litellm.json");

    fs.writeFileSync(openRouterFile, JSON.stringify({ data: [OR_GPT_4O] }));
    fs.writeFileSync(litellmFile, "{}");
    await expect(
      main({ dryRun: true, out, openRouterFile, litellmFile }),
    ).rejects.toThrow(/LiteLLM returned zero usable pricing entries/);
    expect(fs.existsSync(out)).toBe(false);

    fs.writeFileSync(
      openRouterFile,
      JSON.stringify({
        data: [
          {
            id: "openai/unpriced",
            name: "OpenAI: Unpriced",
            pricing: { prompt: "0", completion: "0" },
          },
        ],
      }),
    );
    fs.writeFileSync(litellmFile, JSON.stringify(LL_WHISPER));
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
    await main({ dryRun: true, out, openRouterFile, litellmFile });
    expect(warnings).toHaveBeenCalledWith(
      expect.stringMatching(/OpenRouter returned zero usable pricing entries/),
    );
    const sources = new Set(
      (JSON.parse(fs.readFileSync(out, "utf8")) as CatalogRow[]).map(
        (row) => row.source,
      ),
    );
    expect([...sources].sort()).toEqual(["builtin", "litellm"]);
  });

  it("(i) golden pins hold: claude-4-sonnet-20250514 at $3 in / $15 out, the built-in websearch tool at $10 per 1K requests", () => {
    const rows = build(
      [
        {
          id: "anthropic/claude-sonnet-4",
          name: "Anthropic: Claude Sonnet 4",
          pricing: { prompt: "0.000003", completion: "0.000015" },
          context_length: 1000000,
        },
      ],
      {
        "claude-4-sonnet-20250514": LL_CLAUDE_4_SONNET,
        "anthropic/us-gov-west-1/claude-4-sonnet-20250514": {
          ...LL_CLAUDE_4_SONNET,
          input_cost_per_token: 3.6e-6,
          output_cost_per_token: 1.8e-5,
        },
      },
    );

    expect(rows.get("litellm/claude-4-sonnet-20250514")).toMatchObject({
      inputCost: 3,
      outputCost: 15,
    });
    expect(rows.get("tool/websearch")).toMatchObject({
      inputCost: 10,
      costUnit: "1K requests",
      source: "builtin",
    });
  });

  it("gpt-5.6-sol prices at $4 in / $20 out, cache read 0.4, cache write 5 over OpenRouter's half-price listing", () => {
    const rows = build([OR_GPT_56_SOL], { "gpt-5.6-sol": LL_GPT_56_SOL });

    expect(rows.get("openai/gpt-5.6-sol")).toMatchObject({
      inputCost: 4,
      outputCost: 20,
      cacheReadCost: 0.4,
      cacheWriteCost: 5,
    });
  });

  it("a single-source cache rate is not adopted when its lone publisher isn't the winner, in either direction", () => {
    const rows = build([OR_GPT_55_PRO, OR_GEMINI_3_PRO_IMAGE], {
      "gpt-5.5-pro": LL_GPT_55_PRO,
      "gemini/gemini-3-pro-image": LL_GEMINI_3_PRO_IMAGE,
    });

    expect(rows.get("openai/gpt-5.5-pro")).toMatchObject({
      inputCost: 30,
      outputCost: 180,
      cacheReadCost: null,
    });
    expect(rows.get("litellm/gemini/gemini-3-pro-image")).toMatchObject({
      cacheReadCost: null,
      cacheWriteCost: null,
    });
  });

  it("gemini-flash-latest prices at its gemini-3.5-flash target's $1.50 in / $9 out / $0.15 cache read, not the feeds' stale alias rates", () => {
    const rows = build(
      [
        {
          id: "~google/gemini-flash-latest",
          name: "Google Gemini Flash Latest",
          pricing: {
            prompt: "0.00000075",
            completion: "0.00000375",
            input_cache_read: "0.000000075",
          },
          context_length: 1048576,
        },
        {
          id: "google/gemini-3.5-flash",
          name: "Google: Gemini 3.5 Flash",
          pricing: {
            prompt: "0.0000015",
            completion: "0.000009",
            input_cache_read: "0.00000015",
          },
          context_length: 1048576,
        },
      ],
      {
        "gemini/gemini-flash-latest": {
          mode: "chat",
          litellm_provider: "gemini",
          input_cost_per_token: 3e-7,
          output_cost_per_token: 2.5e-6,
          cache_read_input_token_cost: 3e-8,
        },
      },
    );

    for (const id of [
      "litellm/gemini/gemini-flash-latest",
      "~google/gemini-flash-latest",
      "google/gemini-3.5-flash",
    ]) {
      expect(rows.get(id), id).toMatchObject({
        inputCost: 1.5,
        outputCost: 9,
        cacheReadCost: 0.15,
      });
    }
  });

  it("novita's /community keys price from their own model, not another model sharing the tail", () => {
    const rows = build([], {
      "novita/deepseek/deepseek-v3/community": {
        mode: "chat",
        litellm_provider: "novita",
        input_cost_per_token: 8.9e-7,
        output_cost_per_token: 8.9e-7,
      },
      "novita/deepseek/deepseek-r1/community": {
        mode: "chat",
        litellm_provider: "novita",
        input_cost_per_token: 4e-6,
        output_cost_per_token: 4e-6,
      },
    });

    expect(
      rows.get("litellm/novita/deepseek/deepseek-v3/community"),
    ).toMatchObject({ inputCost: 0.89, outputCost: 0.89 });
  });
});
