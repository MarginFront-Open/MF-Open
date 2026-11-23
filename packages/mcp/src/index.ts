#!/usr/bin/env node

/**
 * MarginFront MCP Server
 *
 * Lets AI agents (Claude, GPT, custom agents) use MarginFront as a tool.
 * Record usage, look up customers, check invoices. No integration code.
 * The agent talks plain English, this server translates it into MarginFront
 * API calls.
 *
 * Transport: stdio (standard for local MCP servers)
 * Auth: API key from MF_API_SECRET_KEY env var
 * API: Calls the MarginFront REST API at MARGINFRONT_API_URL. Required, with no
 * default: this server only ever talks to the one address you set.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient, ApiError } from "./api-client.js";
import { MCP_VERSION } from "./version.js";
import { maskApiKey } from "./transport-policy.js";
import { resolveStartupServer } from "./server-config.js";

// ---------------------------------------------------------------------------
// Config (read from environment variables)
// ---------------------------------------------------------------------------

const API_KEY = process.env.MF_API_SECRET_KEY;

if (!API_KEY) {
  console.error(
    "Missing MF_API_SECRET_KEY environment variable.\n\n" +
      "Set it in your MCP config, or set it in your shell:\n" +
      '  macOS/Linux/WSL:    export MF_API_SECRET_KEY="mf_sk_test_your_key_here"\n' +
      '  Windows PowerShell: $env:MF_API_SECRET_KEY = "mf_sk_test_your_key_here"\n\n' +
      "On Windows PowerShell the $env: prefix is required. Without it the name\n" +
      "reads as an unset PowerShell variable and the key arrives empty.\n\n" +
      "You can find your API key in the MarginFront dashboard under\n" +
      "Build, then API keys.",
  );
  process.exit(1);
}

const STARTUP_SERVER = resolveStartupServer(process.env);
if (!STARTUP_SERVER.ok) {
  console.error(
    `The MarginFront MCP server did not start. ${STARTUP_SERVER.problem}\n\n` +
      "Set it in your MCP config, or set it in your shell:\n" +
      '  macOS/Linux/WSL:    export MARGINFRONT_API_URL="http://localhost:4000/v1"\n' +
      '  Windows PowerShell: $env:MARGINFRONT_API_URL = "http://localhost:4000/v1"',
  );
  process.exit(1);
}
const BASE_URL = STARTUP_SERVER.baseUrl;

const api = new ApiClient(API_KEY, BASE_URL);

// Masked once at load (API_KEY is guaranteed present past the guard above) so the
// startup diagnostic can name which key is in use without ever printing the secret.
const MASKED_API_KEY = maskApiKey(API_KEY);

// ---------------------------------------------------------------------------
// Shared schemas + validation helpers
// ---------------------------------------------------------------------------

/**
 * One service inside a multi-service event. Mirrors the SDK's
 * `ServiceEntry` interface (packages/sdk/src/types.ts) and the backend's
 * `ServiceEntryDto` (apps/api-nest/src/modules/sdk/dto/record-usage.dto.ts)
 * field-for-field. Reused by both `record_usage` and `record_usage_batch`.
 */
const serviceEntrySchema = z.object({
  model: z
    .string()
    .describe(
      "Model identifier for this specific service, e.g. 'claude-sonnet-4-6', 'google-maps-places'",
    ),
  modelProvider: z
    .string()
    .describe(
      "Provider name for this specific service, lowercase, e.g. 'anthropic', 'google'",
    ),
  inputTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Input tokens for this LLM service. Required for LLM, omit for non-LLM.",
    ),
  outputTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Output tokens for this LLM service."),
  cacheReadTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Prompt-cache READ tokens (cache hits) for this LLM service. Priced at the cheaper cache-read rate.",
    ),
  cacheWriteTokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Prompt-cache WRITE tokens (cache creation) for this LLM service. Priced at the cache-write rate.",
    ),
  quantity: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Billing units for this non-LLM service (e.g. 3 for 3 Google Maps queries).",
    ),
});

/**
 * Either-or validator that mirrors the SDK validator + backend
 * IsExactlyOneShape DTO decorator. Returns null on success, an English
 * error message on failure. Caller wraps in errorResponse().
 */
function validateRecordShape(record: {
  model?: unknown;
  modelProvider?: unknown;
  services?: unknown;
}): string | null {
  const hasServices = Array.isArray(record.services);
  const hasSingle =
    (record.model !== undefined &&
      record.model !== null &&
      record.model !== "") ||
    (record.modelProvider !== undefined &&
      record.modelProvider !== null &&
      record.modelProvider !== "");

  if (!hasServices && !hasSingle) {
    return (
      "Provide either model + modelProvider for a single-service event, " +
      "or services[] for multi-service. Got neither."
    );
  }
  if (hasServices && hasSingle) {
    return (
      "Cannot mix shapes: provide model + modelProvider OR services[], " +
      "not both. Pick model + modelProvider for one underlying service " +
      "(common case), or services[] when one business outcome is backed " +
      "by multiple services (e.g. an LLM call plus a Google Maps query)."
    );
  }
  if (
    hasServices &&
    Array.isArray(record.services) &&
    record.services.length === 0
  ) {
    return (
      "services[] is empty. Add at least one entry, or use " +
      "model + modelProvider for a single-service event."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: "marginfront",
    version: MCP_VERSION,
  },
  {
    instructions: [
      "MarginFront is a usage-based billing platform for AI agents.",
      "Use these tools to record what your customers are using, look up who they are, and check their bills.",
      "",
      "Start with `verify` to confirm the API key works.",
      "",
      "For usage recording:",
      "- `record_usage` for a single event",
      "- `record_usage_batch` for multiple events (up to 100)",
      "",
      "If a response mentions NEEDS_COST_BACKFILL, it means the model isn't in the pricing table yet.",
      "The event is saved (don't retry!). Offer to call `get_needs_attention` to see all unmapped models,",
      "then `map_model` to fix them.",
      "",
      "Required fields for usage: customerExternalId, agentCode, signalName, plus EITHER:",
      "- single-service shape: model + modelProvider (and tokens for LLM, quantity for non-LLM)",
      "- multi-service shape: services: [{model, modelProvider, ...volume}, ...]",
      "",
      "Multi-service is for one business outcome backed by multiple underlying services. Example:",
      "one report-generated event that called Claude (1500 input + 800 output tokens) AND made 3 Google",
      "Maps queries. That's ONE record_usage call with services: [claude_entry, maps_entry], NOT two",
      "separate calls. The dashboard shows one event with both costs rolled up.",
      "",
      "Top-level quantity stays signal-level (one report = quantity 1) regardless of how many services",
      "the report called. Per-service volume lives inside each services[] entry.",
      "",
      "For pricing setup, from zero:",
      "- `create_agent` to register the agent you bill for (skip if it already exists)",
      "- `create_signal` to define that agent's billing unit. Do this before pricing:",
      "  usage and credit-pool strategies need the signalId up front.",
      "- `create_pricing_plan` to create a plan container",
      "- `create_pricing_strategy` to add pricing rules (usage, recurring, credit pool, etc.)",
      "  For a credit pool, pass creditPool: {poolSize, poolPrice, overageRate} instead of",
      "  hand-building tiers. Example: 5,000 tasks for $99 a cycle, then $0.03 each. Nothing",
      "  stops when the pool empties; the overage keeps billing.",
      "- `link_plan_to_agent` to connect the plan to an agent",
      "- `create_subscription` to assign a customer to the plan",
      "- `get_credit_balances` to read how many pool units a customer has left.",
      "  Remember: nothing stops at zero. The pool is a meter, not a breaker, so a customer",
      "  past their pool keeps working and the overage keeps billing.",
      "",
      "If usage was recorded first, the agent and signal already exist: recording auto-creates",
      "them, so `create_agent` / `create_signal` will report a conflict. That's normal. Call",
      "`list_agents` / `list_signals` to look up the existing UUIDs and keep going.",
      "",
      "Matters: a matter is the job AI work is billed against, a case for a firm, a project or ticket for anyone else.",
      "- Tag usage with metadata.matterId (the matter number, exact match) and it attaches at ingest.",
      "- `list_matters` / `create_matter` / `update_matter` / `delete_matter` manage the record.",
      "- `list_unassigned_events` shows usage no matter claimed; fix one with",
      "  `assign_event_to_matter`, or in bulk with `apply_matter_rules` after setting up",
      "  `upsert_matter_rule` matchers (agent code, customer ID, signal-name substring).",
      "- `export_matter_audit` is the audit record: per-matter actual cost + Unassigned + totals.",
      "- Matter tools need a key role of legal, finance, admin, or owner.",
      "",
      "To wire usage tracking into the user's own product code (instead of chat), use the SDK.",
      "Setup guide and worked examples: packages/sdk/README.md in the MarginFront source repository.",
      "",
      "Full documentation (files in the MarginFront source repository):",
      "- MCP setup and tools reference: packages/mcp/README.md",
      "- LLM-friendly docs (for agents): packages/mcp/llms-mcp.txt",
    ].join("\n"),
  },
);

// ---------------------------------------------------------------------------
// Helper: turn any error into a clean MCP tool response
// ---------------------------------------------------------------------------

function errorResponse(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  let message: string;

  if (error instanceof ApiError) {
    // Translate HTTP errors into plain English
    if (error.status === 401) {
      message =
        "Authentication failed. The API key is invalid or missing. " +
        "Check the MF_API_SECRET_KEY environment variable.";
    } else if (error.code === "insufficient_key_role") {
      // Two senders share this code. OrgRoleGuard lists the roles that would work on
      // that route, and its message does not always repeat them, so the list is the
      // remedy there. The global ingest-scope guard sends an EMPTY list on
      // purpose: every role above ingest clears that guard, but the route's own
      // OrgRoleGuard is usually narrower, so any list rendered as "Allowed roles" would
      // send the reader to mint a key that 403s again. Defer to its own message instead.
      if (error.requiredRoles?.length) {
        message =
          `This API key's role ('${error.keyRole ?? "unknown"}') can't do that. ` +
          `Allowed roles: ${error.requiredRoles.join(", ")}. ` +
          "Call the `verify` tool to confirm which organization this key belongs to, " +
          "then ask an owner or admin to mint a key with one of the allowed roles " +
          "(in the dashboard under Build, then API keys).";
      } else {
        // The server's own sentence already ends with the remedy and the nav path, so
        // this adds the one thing it can't know: WHICH of the reader's organizations to
        // create the key in.
        message =
          `${error.message} ` +
          "Call the `verify` tool first: it names the organization this key belongs " +
          "to, so you mint a key in that same account rather than another one you " +
          "administer.";
      }
    } else if (error.status === 403) {
      message =
        "Permission denied. You might be using a publishable key (mf_pk_*) " +
        "for an operation that requires a secret key (mf_sk_*).";
    } else if (error.status === 404) {
      message = `Not found: ${error.message}`;
    } else if (error.status === 429) {
      message = "Rate limited. Too many requests. Wait a moment and try again.";
    } else {
      message = `API error (${error.status}): ${error.message}`;
    }
  } else if (error instanceof Error) {
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("ECONNREFUSED")
    ) {
      message =
        "Could not reach the MarginFront API. " +
        `Is the server running at ${BASE_URL}? ` +
        "If testing locally, make sure `cd apps/api-nest && npm run dev` is running.";
    } else {
      message = error.message;
    }
  } else {
    message = String(error);
  }

  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Helper: format JSON responses as readable text for the LLM
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Tool 1: verify
// ---------------------------------------------------------------------------

server.registerTool(
  "verify",
  {
    title: "Verify API Key",
    description:
      "Check that the API key is valid and see which organization it belongs to. " +
      "Call this first to make sure everything is connected. " +
      "Works with every key role, including an ingest-only key.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    try {
      const result = await api.get("/verify");
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 2: record_usage
// ---------------------------------------------------------------------------

server.registerTool(
  "record_usage",
  {
    title: "Record Usage Event",
    description:
      "Record a single usage event (one measurement of a customer using your AI agent). " +
      "This is how MarginFront learns what to bill for. Two shapes are accepted: " +
      "single-service (top-level model + modelProvider + volume fields, the common case), " +
      "or multi-service (services: [{model, modelProvider, ...volume}, ...] when one " +
      "business outcome is backed by N underlying services, e.g. one report that called " +
      "Claude AND queried Google Maps). Provide exactly one shape, never both, never neither. " +
      "Required role: works with every key role, including an ingest-only key — this is the " +
      "ingest floor's whole reason to exist.",
    inputSchema: {
      customerExternalId: z
        .string()
        .describe("Your customer's ID in your system, e.g. 'acme-001'"),
      agentCode: z
        .string()
        .describe(
          "The agent/product code from the dashboard, e.g. 'cs-bot-v2'",
        ),
      signalName: z
        .string()
        .describe(
          "The metric being tracked, e.g. 'messages' or 'pages_processed'",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Single-service shape: the model identifier, e.g. 'gpt-4o', 'claude-sonnet-4-6', 'twilio-sms'. Required when 'services' is absent. Omit when sending services[].",
        ),
      modelProvider: z
        .string()
        .optional()
        .describe(
          "Single-service shape: the provider name in lowercase, e.g. 'openai', 'anthropic', 'google', 'twilio'. Required when 'services' is absent. Omit when sending services[].",
        ),
      inputTokens: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Single-service shape: input/prompt tokens (LLM only)."),
      outputTokens: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Single-service shape: output/completion tokens (LLM only)."),
      cacheReadTokens: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Single-service shape: prompt-cache READ tokens (cache hits, LLM only). Priced at the cheaper cache-read rate.",
        ),
      cacheWriteTokens: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Single-service shape: prompt-cache WRITE tokens (cache creation, LLM only). Priced at the cache-write rate.",
        ),
      quantity: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Single-service shape: billing units for non-LLM events. " +
            "Multi-service shape: signal-level count (one report = 1, default 1).",
        ),
      services: z
        .array(serviceEntrySchema)
        .min(1)
        .optional()
        .describe(
          "Multi-service shape: array of {model, modelProvider, ...volume} entries when " +
            "one event is backed by multiple underlying services. Each entry becomes one " +
            "child cost row; the parent rolls up the sum. Mutually exclusive with " +
            "top-level model + modelProvider.",
        ),
      usageDate: z
        .string()
        .optional()
        .describe(
          "ISO 8601 date for backdating events, e.g. '2026-04-01T00:00:00Z'",
        ),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe(
          "Custom key-value pairs stored with the event (not used for billing)",
        ),
    },
  },
  async (params) => {
    try {
      // Either-or shape check mirrors the SDK validator + backend
      // IsExactlyOneShape DTO. Reject before hitting the API so the
      // LLM-side error message points at the right thing.
      const shapeError = validateRecordShape(params);
      if (shapeError) {
        return errorResponse(new Error(shapeError));
      }
      const result = await api.post("/usage/record", {
        records: [params],
      });
      return formatUsageResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 3: record_usage_batch
// ---------------------------------------------------------------------------

server.registerTool(
  "record_usage_batch",
  {
    title: "Record Usage Events (Batch)",
    description:
      "Record multiple usage events at once (1-100 per request). " +
      "Each record has the same fields as record_usage and accepts EITHER " +
      "single-service shape (model + modelProvider + volume) OR multi-service " +
      "shape (services: [{model, modelProvider, ...volume}, ...]). You can mix " +
      "LLM, non-LLM, single-service, and multi-service records in the same batch. " +
      "Required role: works with every key role, including an ingest-only key.",
    inputSchema: {
      records: z
        .array(
          z.object({
            customerExternalId: z.string().describe("Customer's external ID"),
            agentCode: z.string().describe("Agent/product code"),
            signalName: z.string().describe("Metric being tracked"),
            model: z
              .string()
              .optional()
              .describe(
                "Single-service shape: model identifier. Required when 'services' is absent.",
              ),
            modelProvider: z
              .string()
              .optional()
              .describe(
                "Single-service shape: provider name, lowercase. Required when 'services' is absent.",
              ),
            inputTokens: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Single-service shape: input tokens (LLM only)."),
            outputTokens: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Single-service shape: output tokens (LLM only)."),
            cacheReadTokens: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "Single-service shape: prompt-cache READ tokens (cache hits, LLM only).",
              ),
            cacheWriteTokens: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "Single-service shape: prompt-cache WRITE tokens (cache creation, LLM only).",
              ),
            quantity: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe(
                "Single-service: billing units for non-LLM. Multi-service: signal-level count.",
              ),
            services: z
              .array(serviceEntrySchema)
              .min(1)
              .optional()
              .describe(
                "Multi-service shape: array of {model, modelProvider, ...volume} entries " +
                  "when one event is backed by multiple underlying services. Mutually " +
                  "exclusive with top-level model + modelProvider.",
              ),
            usageDate: z
              .string()
              .optional()
              .describe("ISO 8601 date for backdating"),
            metadata: z
              .record(z.unknown())
              .optional()
              .describe("Custom key-value pairs"),
          }),
        )
        .min(1)
        .max(100)
        .describe("Array of usage records to send (1-100)"),
    },
  },
  async ({ records }) => {
    try {
      // Per-record either-or shape check. Mirrors the SDK validator's
      // batch-error format ("Invalid record at index N: ..."). Reject the
      // whole batch on the first bad record so the LLM gets a precise
      // pointer to which entry to fix.
      for (let i = 0; i < records.length; i++) {
        const shapeError = validateRecordShape(records[i]);
        if (shapeError) {
          return errorResponse(
            new Error(`Invalid record at index ${i}: ${shapeError}`),
          );
        }
      }
      const result = await api.post("/usage/record", { records });
      return formatUsageResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

/**
 * Format the usage recording response into something an LLM can relay clearly.
 * The API always returns 200 even if some records failed, so we surface
 * both successes and failures in plain language.
 *
 * Supports both single-service shape (top-level model on success,
 * record.model on failed) and multi-service shape (services[] on success,
 * servicesStatus[] on failed). The LLM sees a per-service breakdown so it
 * can give the user a concrete next step (which specific service to map
 * or fill volume for).
 */
function formatUsageResponse(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  type SuccessRecord = {
    customerExternalId: string;
    model?: string;
    modelProvider?: string;
    services?: Array<{
      model: string;
      modelProvider: string;
      usageCost?: string | null;
      eventStatus?: string;
    }>;
    totalCostUsd: string;
    eventId: string;
  };
  type FailedRecord = {
    record: {
      customerExternalId?: string;
      model?: string;
      services?: Array<{ model?: string; modelProvider?: string }>;
    };
    code: string;
    stored: boolean;
    error: string;
    servicesStatus?: Array<{
      model: string;
      modelProvider: string;
      eventStatus: string;
    }>;
  };
  const data = result as {
    processed?: number;
    successful?: number;
    failed?: number;
    results?: {
      success?: SuccessRecord[];
      failed?: FailedRecord[];
    };
  };

  const lines: string[] = [];

  // Summary line
  lines.push(
    `Processed ${data.processed ?? 0} event(s): ` +
      `${data.successful ?? 0} succeeded, ${data.failed ?? 0} failed.`,
  );

  // Success details. Multi-service entries show a summary line plus a
  // per-service breakdown so the LLM (and the user it's relaying to)
  // can see how the parent total split across each underlying service.
  if (data.results?.success?.length) {
    lines.push("");
    lines.push("Successful:");
    for (const s of data.results.success) {
      const cost = s.totalCostUsd ? `$${s.totalCostUsd}` : "cost pending";
      if (s.services && s.services.length > 0) {
        const modelList = s.services.map((sv) => sv.model).join(", ");
        lines.push(
          `  - ${s.customerExternalId} (multi-service: ${modelList}): ${cost} (event: ${s.eventId})`,
        );
        for (const sv of s.services) {
          const svcCost = sv.usageCost ? `$${sv.usageCost}` : "cost pending";
          lines.push(`      - ${sv.model} / ${sv.modelProvider}: ${svcCost}`);
        }
      } else {
        const model = s.model ?? "unknown";
        lines.push(
          `  - ${s.customerExternalId} / ${model}: ${cost} (event: ${s.eventId})`,
        );
      }
    }
  }

  // Failed details. This is critical info the LLM needs to relay.
  if (data.results?.failed?.length) {
    lines.push("");
    lines.push("Needs attention:");
    for (const f of data.results.failed) {
      const customer = f.record?.customerExternalId ?? "unknown";

      // Build the target description. Single-service: just the model.
      // Multi-service: list models + (when available) the per-service
      // status so the LLM can see exactly which entries are unresolved.
      const isMulti =
        Array.isArray(f.record?.services) && f.record.services.length > 0;
      let target: string;
      let perServiceDetail = "";
      if (isMulti) {
        const list = f
          .record!.services!.map((sv) => sv.model ?? "?")
          .join(", ");
        target = `multi-service: ${list}`;
        if (f.servicesStatus && f.servicesStatus.length > 0) {
          const failingModels = f.servicesStatus
            .filter((ss) => ss.eventStatus !== "PROCESSED")
            .map((ss) => `${ss.model} (${ss.eventStatus})`)
            .join(", ");
          if (failingModels) {
            perServiceDetail = ` Per-service status: ${failingModels}.`;
          }
        }
      } else {
        target = f.record?.model ?? "unknown";
      }

      if (f.code === "NEEDS_COST_BACKFILL") {
        lines.push(
          `  - ${customer} / ${target}: Event SAVED but cost unknown. ` +
            `The model isn't in the pricing table yet.${perServiceDetail} ` +
            `DO NOT retry. Use get_needs_attention and map_model to fix this. ` +
            `[code: NEEDS_COST_BACKFILL]`,
        );
      } else if (f.code === "MISSING_VOLUME_DATA") {
        lines.push(
          `  - ${customer} / ${target}: Event SAVED but cost unknown. ` +
            `Required volume fields are missing (tokens for LLM, quantity for non-LLM).${perServiceDetail} ` +
            `DO NOT retry. Use get_missing_volume and fill_volume to fix this. ` +
            `[code: MISSING_VOLUME_DATA]`,
        );
      } else if (f.stored) {
        lines.push(
          `  - ${customer} / ${target}: ${f.error} (event saved, don't retry) [code: ${f.code}]`,
        );
      } else {
        lines.push(
          `  - ${customer} / ${target}: ${f.error} (NOT saved, safe to retry) [code: ${f.code}]`,
        );
      }
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Tool 4: list_customers
// ---------------------------------------------------------------------------

server.registerTool(
  "list_customers",
  {
    title: "List Customers",
    description:
      "List your customers with optional search and pagination. " +
      "Returns customer names, IDs, and status. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 20)"),
      search: z.string().optional().describe("Search by name or external ID"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/customers", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 5: get_customer
// ---------------------------------------------------------------------------

server.registerTool(
  "get_customer",
  {
    title: "Get Customer",
    description:
      "Get detailed information about a single customer by their ID " +
      "(the MarginFront internal UUID, not the externalId). " +
      "Optionally pass startDate + endDate to also get scoped revenue, cost, " +
      "and margin for that customer over the window (no extra call needed). " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      customerId: z.string().describe("The customer's MarginFront UUID"),
      startDate: z
        .string()
        .optional()
        .describe(
          "If provided with endDate, include revenue/cost/margin for the window (ISO 8601, e.g. '2026-04-01')",
        ),
      endDate: z
        .string()
        .optional()
        .describe(
          "If provided with startDate, include revenue/cost/margin for the window (ISO 8601, e.g. '2026-04-30')",
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ customerId, startDate, endDate }) => {
    try {
      const customer = await api.get(`/customers/${customerId}`);

      // If both dates supplied, attach canonical revenue metrics for the window.
      // This is a single extra call. The shape is additive, so callers
      // without dates get the plain customer record.
      if (startDate && endDate) {
        try {
          const revenue = await api.get("/analytics/revenue", {
            customerId,
            startDate,
            endDate,
          });
          return jsonResponse({ ...(customer as object), revenue });
        } catch (revenueErr) {
          // If revenue lookup fails, still return the customer. The revenue
          // block is additive and should not break the core lookup.
          return jsonResponse({
            ...(customer as object),
            revenue: null,
            revenueError:
              revenueErr instanceof Error
                ? revenueErr.message
                : String(revenueErr),
          });
        }
      }

      return jsonResponse(customer);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 6: create_customer
// ---------------------------------------------------------------------------

server.registerTool(
  "create_customer",
  {
    title: "Create Customer",
    description:
      "Create a new customer in MarginFront. " +
      "Only 'name' is required. Everything else is optional. " +
      "Set externalId to your own system's customer ID so you can reference it in usage events. " +
      "Required role: Developer (Admin/Owner also work).",
    inputSchema: {
      name: z.string().describe("Customer's display name, e.g. 'Acme Corp'"),
      externalId: z
        .string()
        .optional()
        .describe("Your system's ID for this customer, e.g. 'acme-001'"),
      email: z.string().email().optional().describe("Customer's email address"),
      phone: z.string().optional().describe("Customer's phone number"),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/customers", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 7: list_invoices
// ---------------------------------------------------------------------------

server.registerTool(
  "list_invoices",
  {
    title: "List Invoices",
    description:
      "List invoices with optional filters. " +
      "Shows invoice status (draft, pending, paid, overdue, void, refunded), amounts, and customers. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: 'draft', 'pending', 'paid', 'overdue', 'void', or 'refunded'",
        ),
      customerId: z
        .string()
        .optional()
        .describe(
          "Filter by customer UUID (the MarginFront UUID from list_customers / get_customer, NOT the external ID you use in your own system).",
        ),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 20)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/invoices", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 8: get_invoice
// ---------------------------------------------------------------------------

server.registerTool(
  "get_invoice",
  {
    title: "Get Invoice",
    description:
      "Get detailed information about a single invoice, " +
      "including line items and payment status. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      invoiceId: z.string().describe("The invoice's UUID"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ invoiceId }) => {
    try {
      const result = await api.get(`/invoices/${invoiceId}`);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 8b: generate_invoice
// ---------------------------------------------------------------------------

server.registerTool(
  "generate_invoice",
  {
    title: "Generate Invoice From Subscription",
    description:
      "Build a real draft invoice from a subscription's actual usage events. " +
      "Returns a draft invoice with line items computed from the period's signal_events, " +
      "totals stamped in, ready to preview / edit / send. " +
      "When billingPeriodStart/End are omitted, uses the subscription's current period " +
      "(the right default for 'bill now' flows). This is the canonical way to turn tracked " +
      "usage into something a customer can pay — call this instead of creating an invoice by hand. " +
      "Required role: Finance (Admin/Owner also work).",
    inputSchema: {
      customerId: z
        .string()
        .describe(
          "Customer UUID (the MarginFront UUID from list_customers / get_customer, NOT the external ID).",
        ),
      subscriptionId: z.string().describe("Subscription UUID to bill for."),
      billingPeriodStart: z
        .string()
        .optional()
        .describe(
          "Optional ISO date string. Defaults to the subscription's current billing period start.",
        ),
      billingPeriodEnd: z
        .string()
        .optional()
        .describe(
          "Optional ISO date string. Defaults to the subscription's current billing period end.",
        ),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/invoices/generate", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 8c: send_invoice
// ---------------------------------------------------------------------------
// Lets an agent deliver a draft made with `generate_invoice` to the customer
// without the dashboard "Send" button or a REST call outside the MCP. This
// tool wraps the canonical
// POST /v1/invoices/{id}/send so the agent can complete the full flow in
// one conversation: generate -> review -> send.

server.registerTool(
  "send_invoice",
  {
    title: "Send Invoice Email",
    description:
      "Email an invoice to the customer with a Stripe Checkout pay-now button. " +
      "Use this after `generate_invoice` to actually deliver the draft, or to re-send " +
      "an already-issued invoice. By default the customer's stored email is used; " +
      "override with `recipientEmail` if needed (e.g. routing to a different billing " +
      "contact). Side effect: if the invoice is still a `draft`, sending it auto-finalizes " +
      "the status to `issued` (matching the dashboard Send button + cron behavior). " +
      "After the customer pays via the Stripe Checkout link in the email, the invoice " +
      "auto-flips to `paid` via webhook — no follow-up tool call needed. " +
      "Required role: Finance (Admin/Owner also work).",
    inputSchema: {
      invoiceId: z
        .string()
        .describe(
          "The invoice's MarginFront UUID (from list_invoices / get_invoice / generate_invoice).",
        ),
      recipientEmail: z
        .string()
        .email()
        .optional()
        .describe(
          "Override the destination address. Defaults to the customer's stored email.",
        ),
      subject: z
        .string()
        .optional()
        .describe(
          "Custom subject line. Default: 'Invoice {number} from {your business name}'.",
        ),
      message: z
        .string()
        .optional()
        .describe(
          "Optional note shown in a callout above the invoice details. Useful for " +
            "context like 'auto-charging your card on file in 5 days' or 'second notice'.",
        ),
    },
  },
  async ({ invoiceId, recipientEmail, subject, message }) => {
    try {
      const body: Record<string, unknown> = {};
      if (recipientEmail) body.recipientEmail = recipientEmail;
      if (subject) body.subject = subject;
      if (message) body.message = message;
      const result = await api.post(`/invoices/${invoiceId}/send`, body);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 9: list_events
// ---------------------------------------------------------------------------

server.registerTool(
  "list_events",
  {
    title: "List Usage Events",
    description:
      "List usage events (what your customers actually used) with optional filters. " +
      "Shows model, tokens, cost, customer, and timestamp. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 20)"),
      customerExternalId: z
        .string()
        .optional()
        .describe(
          "Filter by customer external ID (the ID in your system, e.g. 'acme-001'). Not the MarginFront UUID.",
        ),
      agentId: z
        .string()
        .optional()
        .describe("Filter by agent UUID (from list_customers or /agents)"),
      signalId: z
        .string()
        .optional()
        .describe("Filter by signal UUID (from /signals)"),
      startDate: z
        .string()
        .optional()
        .describe("Filter events after this ISO 8601 date"),
      endDate: z
        .string()
        .optional()
        .describe("Filter events before this ISO 8601 date"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/events", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 10: get_usage_analytics
// ---------------------------------------------------------------------------

server.registerTool(
  "get_usage_analytics",
  {
    title: "Get Usage Analytics",
    description:
      "Get aggregated usage analytics for a date range. " +
      "Shows totals, breakdowns by agent/customer/signal, and trends over time. " +
      "Includes totalMargin + totalMarginPercent (canonical revenue minus cost). " +
      "Pass customerExternalId to scope to a single customer using your own system's ID. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      startDate: z
        .string()
        .describe("Start of date range (ISO 8601), e.g. '2026-04-01'"),
      endDate: z
        .string()
        .describe("End of date range (ISO 8601), e.g. '2026-04-12'"),
      groupBy: z
        .string()
        .optional()
        .describe(
          "Group results by: 'agent', 'customer', 'signal', 'model', or 'day'",
        ),
      customerExternalId: z
        .string()
        .optional()
        .describe(
          "Scope to a single customer by their external ID (the ID in your system, e.g. 'acme-001'). Resolves to the MarginFront UUID automatically.",
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const { customerExternalId, ...rest } = params;

      // If the caller scoped by external ID, resolve it to the internal UUID.
      // The /customers search hits externalId so we can find the customer, then
      // pass the UUID to the downstream analytics endpoints.
      let customerId: string | undefined;
      if (customerExternalId) {
        const searchResult = (await api.get("/customers", {
          search: customerExternalId,
          limit: 10,
        })) as { results?: Array<{ id: string; externalId?: string }> };
        const match = searchResult.results?.find(
          (c) => c.externalId === customerExternalId,
        );
        if (!match) {
          return errorResponse(
            new Error(
              `No customer found with externalId '${customerExternalId}'. Check the ID or use create_customer first.`,
            ),
          );
        }
        customerId = match.id;
      }

      // Pull usage analytics + canonical revenue metrics in parallel. The
      // revenue call supplies totalMargin / totalMarginPercent that usage
      // analytics alone doesn't carry, so "what's our margin on customer X
      // this month" is answered in one tool call.
      const usageParams = customerId ? { ...rest, customerId } : rest;
      const revenueParams = {
        startDate: params.startDate,
        endDate: params.endDate,
        ...(customerId ? { customerId } : {}),
      };

      const [usage, revenue] = await Promise.all([
        api.get("/analytics/usage", usageParams),
        api.get("/analytics/revenue", revenueParams).catch(() => null),
      ]);

      // The revenue endpoint returns different shapes depending on whether
      // it's narrowed by customer. Both shapes carry enough info to pull
      // margin out, so we defensively pick either `margin`+`marginPercent`
      // (canonical RevenueMetrics) or compute from totals if available.
      let totalMargin: number | null = null;
      let totalMarginPercent: number | null = null;
      if (revenue) {
        const r = revenue as {
          margin?: number;
          marginPercent?: number;
          revenue?: number;
          cost?: number;
        };
        if (typeof r.margin === "number") {
          totalMargin = r.margin;
        } else if (
          typeof r.revenue === "number" &&
          typeof r.cost === "number"
        ) {
          totalMargin = r.revenue - r.cost;
        }
        if (typeof r.marginPercent === "number") {
          totalMarginPercent = r.marginPercent;
        } else if (
          typeof r.revenue === "number" &&
          typeof r.cost === "number" &&
          r.revenue > 0
        ) {
          totalMarginPercent = ((r.revenue - r.cost) / r.revenue) * 100;
        }
      }

      return jsonResponse({
        ...(usage as object),
        totalMargin,
        totalMarginPercent,
      });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 11: list_subscriptions
// ---------------------------------------------------------------------------

server.registerTool(
  "list_subscriptions",
  {
    title: "List Subscriptions",
    description:
      "List customer subscriptions (which customer is on which pricing plan). " +
      "Shows status, plan details, and billing dates. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: 'active', 'canceled', 'past_due', 'trialing'",
        ),
      customerId: z
        .string()
        .optional()
        .describe(
          "Filter by customer UUID (the MarginFront UUID from list_customers / get_customer, NOT the external ID you use in your own system).",
        ),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 20)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/subscriptions", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 12: get_needs_attention
// ---------------------------------------------------------------------------

server.registerTool(
  "get_needs_attention",
  {
    title: "Get Events Needing Attention",
    description:
      "List usage events where the model+provider combination isn't in the pricing table. " +
      "These events are saved with cost=null and need model mapping. " +
      "Shows groups by model and provider with event counts. " +
      "Use map_model to fix them. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      startDate: z
        .string()
        .optional()
        .describe(
          "Filter events after this date (ISO 8601, default: 30 days ago)",
        ),
      endDate: z
        .string()
        .optional()
        .describe("Filter events before this date (ISO 8601, default: now)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/events/needs-cost-backfill", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 13: map_model
// ---------------------------------------------------------------------------

server.registerTool(
  "map_model",
  {
    title: "Map Unknown Model",
    description:
      "Map an unknown model to a known one in the pricing table and backfill costs " +
      "for all affected events. This creates a permanent mapping. Future events with " +
      "the same model+provider auto-resolve. " +
      "You can identify the target by either targetPricingId OR targetModel+targetProvider. " +
      "Required role: Developer (Admin/Owner also work).",
    inputSchema: {
      sourceModel: z
        .string()
        .describe("The unknown model name to map FROM, e.g. 'my-custom-llm'"),
      sourceProvider: z
        .string()
        .describe("The unknown provider to map FROM, e.g. 'custom'"),
      targetPricingId: z
        .string()
        .optional()
        .describe("UUID of the target service_pricing row to map TO"),
      targetModel: z
        .string()
        .optional()
        .describe(
          "Known model name to map TO, e.g. 'gpt-4o' (use with targetProvider)",
        ),
      targetProvider: z
        .string()
        .optional()
        .describe(
          "Known provider to map TO, e.g. 'openai' (use with targetModel)",
        ),
    },
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.post("/events/map-model", params);

      const data = result as { backfilled?: number; mappingId?: string };
      const lines = [
        `Model mapped successfully.`,
        `  Source: ${params.sourceModel} (${params.sourceProvider})`,
        `  Target: ${params.targetModel ?? params.targetPricingId} ${params.targetProvider ? `(${params.targetProvider})` : ""}`,
        `  Events backfilled: ${data.backfilled ?? 0}`,
        `  Mapping ID: ${data.mappingId ?? "n/a"}`,
        "",
        "Future events with this model+provider will auto-resolve. No manual step needed.",
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 14: create_pricing_plan
// ---------------------------------------------------------------------------

server.registerTool(
  "create_pricing_plan",
  {
    title: "Create Pricing Plan",
    description:
      "Create a new pricing plan. A plan is a container for pricing strategies " +
      "(the actual rates, tiers, and charge types). After creating a plan, add " +
      "strategies with create_pricing_strategy, then link it to an agent with " +
      "link_plan_to_agent. " +
      "Required role: Finance (Admin/Owner also work).",
    inputSchema: {
      name: z.string().describe("Plan name, e.g. 'Pro Plan'"),
      description: z.string().optional().describe("Plan description"),
      agentId: z
        .string()
        .optional()
        .describe(
          "Agent UUID to link on creation (optional; can also use link_plan_to_agent later)",
        ),
      isActive: z
        .boolean()
        .optional()
        .describe("Whether the plan is active (default: true)"),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/pricing-plans", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 15: list_pricing_plans
// ---------------------------------------------------------------------------

server.registerTool(
  "list_pricing_plans",
  {
    title: "List Pricing Plans",
    description:
      "List pricing plans for the organization. Set includeStrategies=true " +
      "to see the pricing rules inside each plan. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      agentId: z
        .string()
        .optional()
        .describe(
          "Filter by agent UUID (the MarginFront UUID from the dashboard or /agents endpoint).",
        ),
      isActive: z.boolean().optional().describe("Filter by active status"),
      includeStrategies: z
        .boolean()
        .optional()
        .describe(
          "Include nested pricing strategies in the response (default: false)",
        ),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 10, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/pricing-plans", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 16: get_pricing_plan
// ---------------------------------------------------------------------------

server.registerTool(
  "get_pricing_plan",
  {
    title: "Get Pricing Plan",
    description:
      "Get a single pricing plan by ID, including linked agents and strategies. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      planId: z.string().describe("The plan's UUID"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ planId }) => {
    try {
      const result = await api.get(`/pricing-plans/${planId}`);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 17: create_pricing_strategy
// ---------------------------------------------------------------------------

server.registerTool(
  "create_pricing_strategy",
  {
    title: "Create Pricing Strategy",
    description:
      "Add a pricing strategy (the actual pricing rules) to a plan. " +
      "Charge types: usage (pay per event), recurring (fixed monthly/yearly fee), " +
      "onetime (setup fee), seat_based (per seat). " +
      "Pricing models: flat (same rate per unit), graduated (tiered rates like tax brackets), " +
      "volume (total quantity picks one rate for all units), " +
      "credit_pool (flat fee for a pool of units, then per-unit overage). " +
      "Required role: Finance (Admin/Owner also work).",
    inputSchema: {
      planId: z.string().describe("The plan's UUID to add this strategy to"),
      name: z.string().describe("Strategy name, e.g. 'API Call Pool'"),
      agentId: z.string().describe("Agent UUID this strategy belongs to"),
      chargeType: z
        .enum(["usage", "recurring", "onetime", "seat_based"])
        .describe("How this strategy charges"),
      pricingModel: z
        .enum(["flat", "graduated", "volume", "credit_pool"])
        .optional()
        .describe(
          "How the rate math works (required for usage and seat_based)",
        ),
      signalId: z
        .string()
        .optional()
        .describe("Signal UUID (required if chargeType is 'usage')"),
      rate: z
        .number()
        .optional()
        .describe(
          "Flat rate per unit (used when pricingModel is 'flat' or no tiers)",
        ),
      tiers: z
        .array(
          z.object({
            lower: z.number().describe("Tier lower bound"),
            upper: z
              .number()
              .nullable()
              .describe("Tier upper bound (null = unlimited)"),
            rate: z.number().describe("Rate for this tier"),
          }),
        )
        .optional()
        .describe(
          "Tier configuration. For credit_pool prefer the creditPool shortcut below; " +
            "if you do build tiers by hand, tiers[0] is the pool (rate = flat pool price) " +
            "and tiers[1] is overage (rate = per-unit overage rate)",
        ),
      creditPool: z
        .object({
          poolSize: z
            .number()
            .describe("How many units the pool covers each billing cycle"),
          poolPrice: z
            .number()
            .describe("Flat fee charged every cycle for the pool, used or not"),
          overageRate: z
            .number()
            .describe("Per-unit price once the pool runs out"),
        })
        .optional()
        .describe(
          "Credit-pool shortcut, e.g. {poolSize: 5000, poolPrice: 99, overageRate: 0.03} for " +
            "'5,000 tasks for $99 a cycle, then 3 cents each'. Compiled into tiers server-side, " +
            "so send this OR tiers, never both. Only valid when pricingModel is credit_pool. " +
            "Nothing stops when the pool empties; the overage keeps billing.",
        ),
      billingFrequency: z
        .enum(["monthly", "yearly"])
        .optional()
        .describe("Billing frequency (default: monthly)"),
      minimumCommitment: z
        .number()
        .optional()
        .describe(
          "Minimum units/seats to bill for, even if actual usage is lower",
        ),
      active: z
        .boolean()
        .optional()
        .describe("Whether this strategy is active (default: true)"),
    },
  },
  async (params) => {
    try {
      const { planId, ...strategyBody } = params;
      // The controller expects an array of strategies
      const result = await api.post(
        `/pricing-plans/${planId}/pricing-strategies`,
        [strategyBody],
      );
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 18: list_pricing_strategies
// ---------------------------------------------------------------------------

server.registerTool(
  "list_pricing_strategies",
  {
    title: "List Pricing Strategies",
    description:
      "List pricing strategies for a specific plan. Shows the actual pricing " +
      "rules (charge types, models, tiers, rates) inside the plan. Credit-pool " +
      "strategies also carry a `creditPool` field with the same three numbers you " +
      "create them with; it's null when the stored tiers aren't a clean pool shape. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      planId: z.string().describe("The plan's UUID"),
      chargeType: z
        .enum(["usage", "recurring", "onetime", "seat_based"])
        .optional()
        .describe("Filter by charge type"),
      pricingModel: z
        .enum(["flat", "graduated", "volume", "credit_pool"])
        .optional()
        .describe("Filter by pricing model"),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 10, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const { planId, ...queryParams } = params;
      const result = await api.get(
        `/pricing-plans/${planId}/pricing-strategies`,
        queryParams,
      );
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 19: link_plan_to_agent
// ---------------------------------------------------------------------------

server.registerTool(
  "link_plan_to_agent",
  {
    title: "Link Plan to Agent",
    description:
      "Link a pricing plan to an agent. A plan can be linked to multiple " +
      "agents, and an agent can have multiple plans. This is required before " +
      "creating subscriptions. " +
      "Required role: Finance (Admin/Owner also work).",
    inputSchema: {
      planId: z.string().describe("The plan's UUID"),
      agentId: z.string().describe("The agent's UUID to link"),
    },
  },
  async ({ planId, agentId }) => {
    try {
      const result = await api.post(`/pricing-plans/${planId}/agents`, {
        agentId,
      });
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 20: create_subscription
// ---------------------------------------------------------------------------

server.registerTool(
  "create_subscription",
  {
    title: "Create Subscription",
    description:
      "Create a subscription that ties a customer to an agent through a pricing plan. " +
      "This is the last pricing-setup step: after creating a plan with strategies, linking " +
      "it to an agent, and creating a customer, this assigns the customer to be billed " +
      "under that plan. The customer, agent, and plan must all exist first. " +
      "Required role: Finance (Admin/Owner also work).",
    inputSchema: {
      name: z
        .string()
        .describe("Subscription name, e.g. 'Acme Corp - Monthly'"),
      planId: z.string().describe("The pricing plan's UUID"),
      agentId: z.string().describe("The agent's UUID"),
      customerId: z.string().describe("The customer's UUID"),
      startDate: z
        .string()
        .describe(
          "When the subscription begins (ISO 8601, e.g. '2026-05-01T00:00:00Z')",
        ),
      billingCycle: z
        .enum(["monthly", "yearly", "custom"])
        .optional()
        .describe("Billing cycle (default: monthly)"),
      billingModel: z
        .enum(["subscription", "usage", "hybrid"])
        .optional()
        .describe(
          "What to bill: 'subscription' = recurring only, 'usage' = usage only, " +
            "'hybrid' = both (default: subscription)",
        ),
      seatsCount: z
        .number()
        .int()
        .optional()
        .describe("Number of seats (for seat-based pricing)"),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/subscriptions", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 21: get_missing_volume
// ---------------------------------------------------------------------------

server.registerTool(
  "get_missing_volume",
  {
    title: "Get Events Missing Volume Data",
    description:
      "List usage events where required volume fields were missing (tokens for LLM models, " +
      "quantity for non-LLM services). These events are saved with cost=null. " +
      "Shows groups by model and provider with event counts and costUnit (so you know " +
      "whether to provide tokens or quantity). Use fill_volume to fix them. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      startDate: z
        .string()
        .optional()
        .describe(
          "Filter events after this date (ISO 8601, default: 30 days ago)",
        ),
      endDate: z
        .string()
        .optional()
        .describe("Filter events before this date (ISO 8601, default: now)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/events/missing-volume", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 22: fill_volume
// ---------------------------------------------------------------------------

server.registerTool(
  "fill_volume",
  {
    title: "Fill Missing Volume Data",
    description:
      "Provide volume data for events that were missing it and recalculate costs. " +
      "The model is already known; you just need to supply the volume. " +
      "For LLM models (costUnit = '1M tokens'): provide inputTokens + outputTokens. " +
      "For non-LLM services: provide quantity. " +
      "All matching events for the model+provider are updated in one operation. " +
      "Required role: Developer (Admin/Owner also work).",
    inputSchema: {
      sourceModel: z
        .string()
        .describe("The model name with missing volume events, e.g. 'gpt-4o'"),
      sourceProvider: z.string().describe("The provider, e.g. 'openai'"),
      inputTokens: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Input (prompt) tokens to apply (required for LLM models)"),
      outputTokens: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Output (completion) tokens to apply (required for LLM models)",
        ),
      quantity: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Billing units to apply (required for non-LLM services)"),
    },
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.post("/events/fill-volume", params);

      const data = result as { backfilled?: number };
      const lines = [
        `Volume filled successfully.`,
        `  Model: ${params.sourceModel} (${params.sourceProvider})`,
        ...(params.inputTokens != null
          ? [`  Input tokens: ${params.inputTokens}`]
          : []),
        ...(params.outputTokens != null
          ? [`  Output tokens: ${params.outputTokens}`]
          : []),
        ...(params.quantity != null ? [`  Quantity: ${params.quantity}`] : []),
        `  Events backfilled: ${data.backfilled ?? 0}`,
        "",
        "These events now have calculated costs. Future events still need correct volume fields in the request.",
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 23: get_customer_revenue
// ---------------------------------------------------------------------------
// Canonical revenue metrics for a single customer over a date window.
// Wraps GET /v1/analytics/revenue?customerId=... which returns the canonical
// RevenueMetrics shape (revenue, cost, margin, marginPercent plus breakdowns).
//
// Input is customerId UUID because that is what the canonical analytics
// endpoint accepts. If an agent only has the external ID, call list_customers
// or get_customer first to resolve it.

server.registerTool(
  "get_customer_revenue",
  {
    title: "Get Customer Revenue",
    description:
      "Get canonical revenue metrics (revenue, cost, margin, marginPercent) for a single customer over a date window. " +
      "Also returns per-strategy-type breakdown. " +
      "Use this when an agent asks 'what revenue / margin did we get from customer X this month?' " +
      "Pass customerId as the MarginFront UUID (from list_customers or get_customer), not the external ID. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      customerId: z
        .string()
        .describe(
          "Customer MarginFront UUID (from list_customers or get_customer, not the external ID).",
        ),
      startDate: z
        .string()
        .describe("Window start (ISO 8601, e.g. '2026-04-01')"),
      endDate: z.string().describe("Window end (ISO 8601, e.g. '2026-04-30')"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ customerId, startDate, endDate }) => {
    try {
      const result = await api.get("/analytics/revenue", {
        customerId,
        startDate,
        endDate,
      });
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 24: get_cost_metrics
// ---------------------------------------------------------------------------
// Canonical cost metrics. Wraps GET /v1/analytics/cost which returns the full
// CostMetrics shape (total + breakdowns by agent / customer / signal / day /
// plan / model). Optional customerId + agentId narrow the scope.

server.registerTool(
  "get_cost_metrics",
  {
    title: "Get Cost Metrics",
    description:
      "Get canonical cost metrics over a date window. Returns total cost plus breakdowns " +
      "by agent, customer, signal, day, plan, and model. " +
      "Optional customerId or agentId narrows the scope. " +
      "Use this when an agent asks 'what did we spend on model providers this month?' or " +
      "'what was our total cost for customer X?' " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      startDate: z
        .string()
        .describe("Window start (ISO 8601, e.g. '2026-04-01')"),
      endDate: z.string().describe("Window end (ISO 8601, e.g. '2026-04-30')"),
      customerId: z
        .string()
        .optional()
        .describe(
          "Optional: scope to a single customer by MarginFront UUID (from list_customers, not external ID).",
        ),
      agentId: z
        .string()
        .optional()
        .describe(
          "Optional: scope to a single agent by MarginFront UUID (from the dashboard or /agents).",
        ),
      includePriorWindow: z
        .boolean()
        .optional()
        .describe(
          "When true, include a 'prior' field with cost data from the same-length previous window for trend comparison (default: false).",
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/analytics/cost", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 25: get_mrr
// ---------------------------------------------------------------------------
// Canonical MRR. Wraps GET /v1/analytics/mrr. Three canon variants:
//   canonical (MRR1): contracted monthly recurring revenue of active
//                     subscriptions, today.
//   runRate   (MRR2): contract commitments + last-30-days usage, monthly-
//                     normalized. Trajectory if current pace continues.
//   committed (MRR3): contractual floor. Minimum commitments only.
//   all:              returns all three in one response.

server.registerTool(
  "get_mrr",
  {
    title: "Get MRR",
    description:
      "Get canonical MRR (monthly recurring revenue). Three variants exist: " +
      "'canonical' (MRR1, contracted monthly recurring revenue of active subscriptions, today), " +
      "'runRate' (MRR2, trajectory based on last 30 days of usage + recurring commitments), " +
      "'committed' (MRR3, contractual floor from minimum commitments only), " +
      "or 'all' to get all three at once. " +
      "Optional customerId narrows to one customer; subscriptionId narrows to one subscription. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      variant: z
        .enum(["canonical", "runRate", "committed", "all"])
        .optional()
        .describe(
          "Which MRR variant to return. Default is 'canonical' (MRR1).",
        ),
      customerId: z
        .string()
        .optional()
        .describe(
          "Optional: narrow to a single customer by MarginFront UUID (from list_customers, not external ID).",
        ),
      subscriptionId: z
        .string()
        .optional()
        .describe(
          "Optional: narrow to a single subscription by MarginFront UUID.",
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/analytics/mrr", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 26: list_catalog_services
// ---------------------------------------------------------------------------

server.registerTool(
  "list_catalog_services",
  {
    title: "List Catalog Services",
    description:
      "List entries from the global service_pricing catalog. Use this BEFORE " +
      "sending events with new model+modelProvider combinations to discover the " +
      "canonical names MarginFront recognizes for cost calculation. If your " +
      "service is not in the catalog, the event will land but cost stays null " +
      "(NEEDS_COST_BACKFILL) until the catalog is updated. The map_model tool " +
      "can then redirect to an existing entry; it cannot create new rates. " +
      "Filter by provider (e.g. 'google'), serviceType ('LLM', 'Embeddings', " +
      "'Web Search', 'Agent Built-in'), isApi (true for non-LLM), " +
      "or full-text search across canonicalName + displayName. " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      provider: z
        .string()
        .optional()
        .describe(
          "Filter by lowercase provider name (e.g. 'google', 'openai', 'anthropic', 'tool').",
        ),
      serviceType: z
        .string()
        .optional()
        .describe(
          "Filter by service category (e.g. 'LLM', 'Embeddings', 'Web Search', 'Agent Built-in').",
        ),
      isApi: z
        .boolean()
        .optional()
        .describe(
          "Filter to non-LLM API entries only (true) or LLM-only (false). Omit to return both.",
        ),
      search: z
        .string()
        .optional()
        .describe(
          "Case-insensitive search across canonicalName and displayName.",
        ),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 50, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/services", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: create_portal_session
// ---------------------------------------------------------------------------

server.registerTool(
  "create_portal_session",
  {
    title: "Create Customer Portal Link",
    description:
      "Mint a single-use portal link for a customer. The customer opens the URL, " +
      "the link is consumed, and they're logged into a 1-hour read-only portal " +
      "showing their plan, agents, tasks, and invoices. The URL expires in 1 hour " +
      "from creation. After the link is opened once, it cannot be reused. " +
      "Requires a secret key. Every key role except ingest-only and legal can call it; " +
      "ingest-only and legal keys get a 403.",
    inputSchema: {
      customerId: z
        .string()
        .optional()
        .describe(
          "Internal MarginFront customer ID (UUID). Provide either this or customerExternalId.",
        ),
      customerExternalId: z
        .string()
        .optional()
        .describe(
          "Your system's customer ID. Provide either this or customerId.",
        ),
      returnUrl: z
        .string()
        .url()
        .optional()
        .describe(
          "Optional URL to attach to the session for tracking purposes (the portal does not redirect back to it).",
        ),
      features: z
        .array(z.enum(["invoices", "subscriptions", "usage", "profile"]))
        .optional()
        .describe(
          "Features to enable. The portal renders all four together on a single page; this field is informational.",
        ),
    },
  },
  async ({ customerId, customerExternalId, returnUrl, features }) => {
    if (!customerId && !customerExternalId) {
      return errorResponse(
        new Error(
          "Either customerId or customerExternalId is required. " +
            "Use customerExternalId if you only have your own system's customer ID.",
        ),
      );
    }
    try {
      const body: Record<string, unknown> = {};
      if (customerId) body.customerId = customerId;
      if (customerExternalId) body.customerExternalId = customerExternalId;
      if (returnUrl) body.returnUrl = returnUrl;
      if (features) body.features = features;
      const result = await api.post("/portal-sessions", body);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: get_portal_session
// ---------------------------------------------------------------------------

server.registerTool(
  "get_portal_session",
  {
    title: "Get Portal Session",
    description:
      "Look up a portal session by its ID. Returns metadata (customer, expiry, " +
      "redeem status). Useful for checking whether a link has been used or has expired. " +
      "Requires a secret key. Every key role except ingest-only and legal can call it; " +
      "ingest-only and legal keys get a 403.",
    inputSchema: {
      sessionId: z
        .string()
        .describe("The portal session ID returned from create_portal_session."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ sessionId }) => {
    if (!sessionId) {
      return errorResponse(new Error("sessionId is required."));
    }
    try {
      const result = await api.get(
        `/portal-sessions/${encodeURIComponent(sessionId)}`,
      );
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: list_portal_sessions
// ---------------------------------------------------------------------------

server.registerTool(
  "list_portal_sessions",
  {
    title: "List Portal Sessions",
    description:
      "List portal sessions, optionally filtered by customer. Returns metadata only — " +
      "tokens are intentionally NOT included in the response (security control: " +
      "tokens are surfaced only once at creation). " +
      "Requires a secret key. Every key role except ingest-only and legal can call it; " +
      "ingest-only and legal keys get a 403.",
    inputSchema: {
      customerId: z
        .string()
        .optional()
        .describe("Filter by customer ID (internal UUID)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results to return (default 10)."),
      includeExpired: z
        .boolean()
        .optional()
        .describe("Include expired sessions. Default: false."),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ customerId, limit, includeExpired }) => {
    try {
      const params: Record<string, string> = {};
      if (customerId) params.customerId = customerId;
      if (typeof limit === "number") params.limit = String(limit);
      if (typeof includeExpired === "boolean")
        params.includeExpired = String(includeExpired);
      const result = await api.get("/portal-sessions", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: revoke_portal_session
// ---------------------------------------------------------------------------

server.registerTool(
  "revoke_portal_session",
  {
    title: "Revoke Portal Session",
    description:
      "Immediately invalidate a portal session. Useful if you sent a link to the " +
      "wrong customer or need to cut access early. Hard delete — the session row is removed. " +
      "Requires a secret key. Every key role except ingest-only and legal can call it; " +
      "ingest-only and legal keys get a 403.",
    inputSchema: {
      sessionId: z.string().describe("The portal session ID to revoke."),
    },
  },
  async ({ sessionId }) => {
    if (!sessionId) {
      return errorResponse(new Error("sessionId is required."));
    }
    try {
      await api.delete(`/portal-sessions/${encodeURIComponent(sessionId)}`);
      return jsonResponse({ revoked: true, sessionId });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Spend controls: read and manage internal code-spend caps.
// Reads compose the three /control/* reads; writes hit the SAME owner/finance-
// gated api-nest endpoints as the dashboard (the role rides the API key, not the
// tool). A non-manager key gets the server's own 403, translated by errorResponse
// into "which role you have / which would work / mint a key".
// ---------------------------------------------------------------------------

// Closed cap vocabularies, mirrored from @marginfront/db cap-policy (the MCP can't
// value-import that package's Prisma chain). Server re-validates authoritatively.
const capPeriodSchema = z.enum(["day", "week", "month"]);
const capModeSchema = z.enum(["track", "enforce"]);

/**
 * A cap-write response, leading with the cap's plain sentence (built server-side,
 * never re-derived here) so the human sees exactly what changed, then
 * the full JSON for the agent.
 */
function capWriteResponse(
  leadLine: string,
  data: { sentence?: string } & Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const sentence = data.sentence ?? "(no sentence returned)";
  return {
    content: [
      {
        type: "text",
        text: `${leadLine}: ${sentence}\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool: get_spend_controls
// ---------------------------------------------------------------------------

server.registerTool(
  "get_spend_controls",
  {
    title: "Get Spend Controls",
    description:
      "Read the internal code-spend caps in one call: the cap policies (each with its plain " +
      "sentence), spend-so-far for a period, and cap-check coverage. Use when an agent asks " +
      "'what are our spend caps?', 'how much have we spent against the cap this week?', or " +
      "'how many teammates are capped?'. " +
      "ANSWERING A COVERAGE QUESTION: report coverage.claudeCode and coverage.codex " +
      "SEPARATELY, never as one blended number. Each carries armed / notArmed / unknown / " +
      "total for the teammates who used that tool in the trailing 7 days. 'unknown' means we " +
      "could not tell whether the cap check is running (a meter build that doesn't " +
      "report it, a Codex trust check that did not answer, or no coding turn to read a verdict off), and it's NEVER " +
      "covered: say we can't tell, not that they're fine. A teammate who uses both tools " +
      "is counted in both, so the per-tool totals don't sum to coverage.total. " +
      "coverage.armed and coverage.total blend both tools into one count; " +
      "don't quote them as the team's coverage. spentUsd is null when there's no " +
      "priced usage yet (honest absence, not $0). Read-only. Works with every key role, " +
      "including an ingest-only key: the on-device brake reads these three with the same " +
      "ingest key it sends usage with.",
    inputSchema: {
      period: capPeriodSchema
        .optional()
        .describe(
          "Which period the spend total covers: 'day', 'week', or 'month'. Default 'month'.",
        ),
      customerExternalId: z
        .string()
        .optional()
        .describe(
          "Optional: a teammate's customerExternalId (email) to also get that teammate's spend.",
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ period, customerExternalId }) => {
    try {
      const p = period ?? "month";
      const [caps, spend, coverage] = await Promise.all([
        api.get("/control/caps"),
        api.get("/control/spend", { period: p, customerExternalId }),
        api.get("/control/coverage"),
      ]);
      return jsonResponse({ caps, spend, coverage });
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: get_internal_spend_breakdown
// ---------------------------------------------------------------------------

// No 'pr' grain: usage records carry repo/branch/commit, not PR numbers, and
// a PR grain that silently meant "branch" would mislead.
const spendBreakdownDimensionSchema = z.enum(["repo", "branch"]);

server.registerTool(
  "get_internal_spend_breakdown",
  {
    title: "Get Internal Spend Breakdown",
    description:
      "Break down internal coding-agent spend (Claude Code and Codex events only, never " +
      "customer billing) for the current period, grouped by git repo or branch. Branch spend " +
      "is the closest stand-in for cost per pull request; events outside a tracked repo appear " +
      "in the no-repo bucket (noMetadata), and coveragePercent says how much of the activity " +
      "carries repo/branch metadata. spentUsd is null when there's no priced usage (honest " +
      "absence, not $0). Read-only. Required role: owner, admin, or finance. Any other " +
      "key, developer and ingest-only included, gets a 403; get_spend_controls is the " +
      "read that stays open to them.",
    inputSchema: {
      period: capPeriodSchema.describe(
        "Which period to sum: 'day', 'week', or 'month'. The server computes the current window in UTC.",
      ),
      dimension: spendBreakdownDimensionSchema.describe(
        "Group by 'repo' (one row per repository) or 'branch' (one row per repo#branch, " +
          "so a branch named main in two repos stays two rows).",
      ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ period, dimension }) => {
    try {
      const result = await api.get("/control/spend/breakdown", {
        period,
        dimension,
      });
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: create_spend_cap
// ---------------------------------------------------------------------------

server.registerTool(
  "create_spend_cap",
  {
    title: "Create Spend Cap",
    description:
      "Create an internal code-spend cap covering all AI tools. A dev cap can never exceed " +
      "the org ceiling — the server rejects it with a plain message. Required role: owner or " +
      "finance (the same gate the dashboard uses; a key without it gets a clean 403). The " +
      "response leads with the new cap's plain sentence.",
    inputSchema: {
      scope: z
        .enum(["org", "dev"])
        .describe(
          "Who the cap governs: 'org' (a ceiling) or 'dev' (one teammate). " +
            "MarginFront has no teams.",
        ),
      scopeValue: z
        .string()
        .optional()
        .describe(
          "The target: the teammate's customerExternalId/email. Omit for org.",
        ),
      amountUsd: z.number().describe("Cap amount in US dollars, e.g. 200."),
      period: capPeriodSchema.describe(
        "Reset cadence: 'day', 'week', or 'month'. Rolls at UTC.",
      ),
      mode: capModeSchema.describe(
        "'track' watches and alerts (blocks nothing); 'enforce' hard-stops armed machines.",
      ),
      coolOffHours: z
        .number()
        .int()
        .optional()
        .describe(
          "Optional cool-off window in hours after a cap trips before it re-evaluates.",
        ),
      alertThresholds: z
        .array(z.number().int())
        .optional()
        .describe(
          "Optional alert ladder as whole percents of the cap (default 50, 80, 100).",
        ),
    },
  },
  async (params) => {
    try {
      const result = (await api.post("/control/caps", {
        providerScope: "all",
        ...params,
      })) as {
        sentence?: string;
      } & Record<string, unknown>;
      return capWriteResponse("Cap created", result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: update_spend_cap
// ---------------------------------------------------------------------------

server.registerTool(
  "update_spend_cap",
  {
    title: "Update Spend Cap",
    description:
      "Adjust an existing cap's amount, period, mode, cool-off, or alert ladder. A cap's identity " +
      "(scope, target, provider) is immutable — change those by deleting and recreating. Required " +
      "role: owner or finance. The response leads with the updated cap's plain sentence.",
    inputSchema: {
      id: z.string().describe("The cap's ID (from get_spend_controls)."),
      amountUsd: z
        .number()
        .optional()
        .describe("New cap amount in US dollars."),
      period: capPeriodSchema.optional().describe("New reset cadence."),
      mode: capModeSchema.optional().describe("New enforcement posture."),
      coolOffHours: z
        .number()
        .int()
        .optional()
        .describe("New cool-off window in hours. Send 0 to clear."),
      alertThresholds: z
        .array(z.number().int())
        .optional()
        .describe("New alert ladder as whole percents of the cap."),
    },
  },
  async ({ id, ...patch }) => {
    try {
      const result = (await api.patch(
        `/control/caps/${encodeURIComponent(id)}`,
        patch,
      )) as { sentence?: string } & Record<string, unknown>;
      return capWriteResponse("Cap updated", result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: delete_spend_cap
// ---------------------------------------------------------------------------

server.registerTool(
  "delete_spend_cap",
  {
    title: "Delete Spend Cap",
    description:
      "Delete a cap. Deleting an org ceiling is refused if it would leave a child cap above the " +
      "'all'-provider fallback (the server says so plainly). Required role: owner or finance. The " +
      "response leads with the removed cap's plain sentence so you can confirm what was deleted.",
    inputSchema: {
      id: z.string().describe("The cap's ID (from get_spend_controls)."),
    },
  },
  async ({ id }) => {
    try {
      const result = (await api.delete(
        `/control/caps/${encodeURIComponent(id)}`,
      )) as { sentence?: string } & Record<string, unknown>;
      return capWriteResponse("Cap removed", result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Customer Watch Alerts — per-customer cost/revenue tripwires.
// Reads AND writes ride the same MANAGE_MONEY_ROLES-gated api-nest endpoints
// as the dashboard (unlike the spend-control reads, there is no open-read
// posture here: a watch exposes per-customer money). An API key has no human
// behind it, so create REQUIRES notifyEmail — the org member (owner, admin,
// or finance) the alerts deliver to; the server validates membership + role.
// ---------------------------------------------------------------------------

const customerAlertMetricSchema = z.enum(["cost", "revenue"]);
const customerAlertWindowSchema = z.enum(["month", "rolling", "custom"]);

// ---------------------------------------------------------------------------
// Tool: get_customer_alerts
// ---------------------------------------------------------------------------

server.registerTool(
  "get_customer_alerts",
  {
    title: "Get Customer Alerts",
    description:
      "List the organization's customer watches — per-customer cost/revenue tripwires " +
      "('email me when Acme's cost passes $500 this month'). Each row carries the watched " +
      "customer (name + internal id), the metric ('cost' = what the customer costs us, " +
      "'revenue' = what they owe us), the dollar threshold, the window ('month' = current " +
      "UTC calendar month, re-arms monthly; 'rolling' = last 30 days, fires once per " +
      "crossing; 'custom' = a fixed range, fires at most once and expires at range end), " +
      "and who the alert emails. Required role: owner, admin, or finance — a key without " +
      "a money role gets a clean 403 (watches expose per-customer money, so unlike the " +
      "spend-control reads there is no open-read posture).",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    try {
      const result = await api.get("/customer-alerts");
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: create_customer_alert
// ---------------------------------------------------------------------------

server.registerTool(
  "create_customer_alert",
  {
    title: "Create Customer Alert",
    description:
      "Create a customer watch: email a named org member when this customer's cost or " +
      "revenue passes a dollar threshold for the chosen window. notifyEmail is REQUIRED " +
      "here because an API key has no person behind it — it must be the email of a " +
      "current org member with a money role (owner, admin, or finance; the server " +
      "rejects anyone else in plain English). The customer is the INTERNAL customer id " +
      "(from list_customers), never your own external id. Customers that hold internal " +
      "coding-agent spend (recorded by Code Cost Clarity) are refused — use the " +
      "spend-cap tools for coding-agent spend. Creating sends the " +
      "recipient a confirmation email. Required role: owner, admin, or finance.",
    inputSchema: {
      customerId: z
        .string()
        .describe(
          "The customer's INTERNAL id (UUID, from list_customers) — not customerExternalId.",
        ),
      metric: customerAlertMetricSchema.describe(
        "'cost' (what this customer costs us) or 'revenue' (what they owe us).",
      ),
      thresholdUsd: z
        .number()
        .describe("The tripwire in US dollars, e.g. 500."),
      windowMode: customerAlertWindowSchema.describe(
        "'month' (current UTC calendar month, re-arms monthly), 'rolling' (last 30 " +
          "days, fires once per crossing), or 'custom' (fixed range, fires at most " +
          "once, expires at range end).",
      ),
      customStartDate: z
        .string()
        .optional()
        .describe(
          "Custom mode only: range start, ISO 8601 (e.g. 2026-08-01T00:00:00Z).",
        ),
      customEndDate: z
        .string()
        .optional()
        .describe("Custom mode only: range end, ISO 8601."),
      notifyEmail: z
        .string({
          required_error:
            "notifyEmail is required: pass the email of an org member with a money role " +
            "(owner, admin, or finance) — that person gets the alert emails and the " +
            "in-app notifications.",
        })
        .describe(
          "Who gets the alerts. Must be a current org member with a money role " +
            "(owner, admin, or finance).",
        ),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/customer-alerts", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: update_customer_alert
// ---------------------------------------------------------------------------

server.registerTool(
  "update_customer_alert",
  {
    title: "Update Customer Alert",
    description:
      "Adjust an existing customer watch's metric, threshold, or window. The watched " +
      "customer and the recipient are fixed at create — change those by deleting and " +
      "recreating. A fired custom/month window never re-fires for that same window even " +
      "after an edit (the dedup ledger is permanent by design). Required role: owner, " +
      "admin, or finance.",
    inputSchema: {
      id: z.string().describe("The watch's id (from get_customer_alerts)."),
      metric: customerAlertMetricSchema
        .optional()
        .describe("New metric: 'cost' or 'revenue'."),
      thresholdUsd: z
        .number()
        .optional()
        .describe("New tripwire in US dollars."),
      windowMode: customerAlertWindowSchema
        .optional()
        .describe(
          "New window mode. Flipping to 'custom' needs both dates in the same call.",
        ),
      customStartDate: z
        .string()
        .optional()
        .describe("Custom mode only: range start, ISO 8601."),
      customEndDate: z
        .string()
        .optional()
        .describe("Custom mode only: range end, ISO 8601."),
    },
  },
  async ({ id, ...patch }) => {
    try {
      const result = await api.patch(
        `/customer-alerts/${encodeURIComponent(id)}`,
        patch,
      );
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: delete_customer_alert
// ---------------------------------------------------------------------------

server.registerTool(
  "delete_customer_alert",
  {
    title: "Delete Customer Alert",
    description:
      "Delete a customer watch. Its in-app notification history goes with it (the feed " +
      "rows cascade). Required role: owner, admin, or finance.",
    inputSchema: {
      id: z.string().describe("The watch's id (from get_customer_alerts)."),
    },
  },
  async ({ id }) => {
    try {
      const result = await api.delete(
        `/customer-alerts/${encodeURIComponent(id)}`,
      );
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Credit Pool Balances — read how many pool units a customer has
// left. Read-only on purpose: adding units and pausing pool emails are
// money writes that live in the dashboard behind an owner/admin/finance seat.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool: get_credit_balances
// ---------------------------------------------------------------------------

server.registerTool(
  "get_credit_balances",
  {
    title: "Get Credit Balances",
    description:
      "Read your customers' credit-pool countdowns: pool size, units used this period, units " +
      "left, and units already billing as overage. Use when someone asks 'who is running out " +
      "of credits?', 'how many units does this customer have left?', or 'who is in overage " +
      "this month?'. Two numbers are deliberately different and both are true: remainingUnits " +
      "counts manual top-ups, overageInProgressUnits is the invoice's own math (usage past the " +
      "pool size, top-up blind), so a topped-up pool can show units left AND overage at once. " +
      "The invoice always matches overageInProgressUnits. NOTHING STOPS AT ZERO: the pool is a " +
      "meter, not a breaker, so a customer past their pool keeps working and the overage keeps " +
      "billing. Subscriptions whose plan sells no credit pool are absent, never listed with a " +
      "zero. Read-only. Every key role except ingest-only and legal can call it; " +
      "ingest-only and legal keys get a 403.",
    inputSchema: {
      subscriptionId: z
        .string()
        .optional()
        .describe(
          "Optional: one subscription's balance instead of the whole list.",
        ),
      customerId: z
        .string()
        .optional()
        .describe("Optional: only pools belonging to this customer."),
      agentId: z
        .string()
        .optional()
        .describe("Optional: only pools on subscriptions for this agent."),
      belowPercent: z
        .number()
        .optional()
        .describe(
          "Optional: only pools with this percent of the pool (or less) still left. " +
            "20 finds the ones worth a heads-up; 0 finds the ones already past zero.",
        ),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ subscriptionId, customerId, agentId, belowPercent }) => {
    try {
      if (subscriptionId) {
        const balance = await api.get(
          `/subscriptions/${encodeURIComponent(subscriptionId)}/credit-balance`,
        );
        return jsonResponse(balance);
      }
      const result = await api.get("/credit-balances", {
        customerId,
        agentId,
        belowPercent,
      });
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Agents & Signals — create/list for the two records everything
// else hangs off, so pricing setup can start from zero. Usage ingestion
// auto-creates both on first event and the conflict body carries no id, so
// the list tools are the designed recovery path when a create reports 409.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool 39: create_agent
// ---------------------------------------------------------------------------

server.registerTool(
  "create_agent",
  {
    title: "Create Agent",
    description:
      "Create an agent: the billable thing you meter (a chatbot, a report generator, a pipeline). " +
      "Pricing plans link to agents and subscriptions bill per agent, so this comes first when " +
      "setting up from zero. agentCode is the stable identifier your product sends as agentCode " +
      "when recording usage. If the code already exists, the API returns a conflict (recording " +
      "usage auto-creates agents, so this is common). Don't retry; call `list_agents` to fetch " +
      "the existing agent's UUID and keep going. " +
      "Required role: Developer (Admin/Owner also work).",
    inputSchema: {
      name: z
        .string()
        .describe("Agent display name, e.g. 'Customer Support Agent'"),
      agentCode: z
        .string()
        .describe(
          "Unique code for this agent, e.g. 'cs-bot'. The same value your product sends as " +
            "agentCode when recording usage.",
        ),
      description: z.string().optional().describe("What this agent does"),
      isActive: z
        .boolean()
        .optional()
        .describe("Whether the agent is active (default: true)"),
      context: z
        .record(z.unknown())
        .optional()
        .describe(
          "Custom key-value pairs stored with the agent, e.g. {department: 'support'}",
        ),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/agents", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 40: create_signal
// ---------------------------------------------------------------------------

server.registerTool(
  "create_signal",
  {
    title: "Create Signal",
    description:
      "Create a signal: the billing unit an agent tracks, e.g. 'messages' or 'reports-generated'. " +
      "The signal name is the line item the customer reads on their invoice, so pick the unit the " +
      "user actually bills by (ask if unclear: 'per report' and 'per page' are different signals). " +
      "Create the signal before pricing: usage and credit-pool strategies need its UUID up front, " +
      "and this tool returns it. If the name already exists on that agent (recording usage " +
      "auto-creates signals), the API returns a conflict; call `list_signals` to fetch the " +
      "existing signal's UUID instead of retrying. " +
      "Required role: Developer (Admin/Owner also work).",
    inputSchema: {
      name: z
        .string()
        .describe(
          "Signal name, e.g. 'messages'. This is the billing unit on the customer's invoice; " +
            "match the user's language ('per page' → 'pages'). Avoid internal-sounding names " +
            "like 'llm_call' or 'api-requests'.",
        ),
      agentId: z
        .string()
        .describe("The agent's UUID (from create_agent or list_agents)"),
      shortName: z.string().optional().describe("Short name, e.g. 'api_calls'"),
      type: z
        .enum(["usage", "volume"])
        .optional()
        .describe(
          "'usage' = billed per result (OUTCOME), 'volume' = billed per attempt (ACTIVITY)",
        ),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/signals", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 41: list_agents
// ---------------------------------------------------------------------------

server.registerTool(
  "list_agents",
  {
    title: "List Agents",
    description:
      "List your agents with optional search and filters. Each row's id is the agentId that " +
      "create_signal, create_pricing_strategy, link_plan_to_agent, and create_subscription need. " +
      "Use this to look up agents that already exist, including ones auto-created by recording " +
      "usage (their agentCode is the code the first event used). " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      search: z
        .string()
        .optional()
        .describe("Search across name, description, and agent code"),
      agentCode: z
        .string()
        .optional()
        .describe("Filter by agent code (case-insensitive partial match)"),
      isActive: z.boolean().optional().describe("Filter by active status"),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 10, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/agents", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 42: list_signals
// ---------------------------------------------------------------------------

server.registerTool(
  "list_signals",
  {
    title: "List Signals",
    description:
      "List signals with optional filters. Each row's id is the signalId that " +
      "create_pricing_strategy needs for usage charge types and credit pools. Use this to look " +
      "up signals that already exist, including ones auto-created by recording usage (their " +
      "name is the signalName the first event used). " +
      "Read-only. Every key role except ingest-only and legal can call it; ingest-only and legal keys get a 403.",
    inputSchema: {
      agentId: z
        .string()
        .optional()
        .describe("Filter to one agent's signals (UUID from list_agents)"),
      name: z
        .string()
        .optional()
        .describe("Filter by signal name (case-insensitive partial match)"),
      type: z
        .enum(["usage", "volume"])
        .optional()
        .describe("Filter by signal type"),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 10, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/signals", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Matter tools
//
// Full parity with the dashboard's Law tab: everything a person can do there,
// an agent can do here, behind the same role entitlements. All twelve call the
// /v1/matters + /v1/matter-rules REST surface (apps/api-nest/src/modules/
// matters). Required role on every one: Legal (Finance/Admin/Owner also work).
// ---------------------------------------------------------------------------

server.registerTool(
  "list_matters",
  {
    title: "List Matters",
    description:
      "List the organization's matters with each one's all-time actual AI cost " +
      "and usage-event count. A matter is the job AI work is billed against, a case " +
      "for a firm, a project or ticket for anyone else; " +
      "the cost shown is the sum of its events' actual costs (never an estimate). " +
      "Each matter's eventsMissingCost counts events still awaiting a resolved cost; " +
      "they add 0 to the total, so a nonzero value means the true cost is higher. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 10, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/matters", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "get_matter",
  {
    title: "Get Matter",
    description:
      "One matter with its all-time cost, event count, and its 100 most recent usage " +
      "events (the response's eventsCap field states the cap). eventsMissingCost " +
      "counts events still awaiting a resolved cost; they add 0 to actualCost. For " +
      "the complete event record, use export_matter_audit. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      matterId: z.string().describe("The matter's UUID (from list_matters)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ matterId }) => {
    try {
      const result = await api.get(`/matters/${matterId}`);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "create_matter",
  {
    title: "Create Matter",
    description:
      "Create a matter. matterNumber is your own identifier for the job, unique " +
      "per organization; usage events that arrive with metadata.matterId equal to it " +
      "(trimmed, exact) attach to this matter automatically. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      matterNumber: z
        .string()
        .describe(
          "Your own identifier for the job, e.g. 'PROJ-123' or 'CASE-0042'. Unique per organization.",
        ),
      name: z.string().describe("Matter name, e.g. what this job is called"),
      clientName: z
        .string()
        .describe("The client or team this matter is billed to"),
      status: z
        .enum(["open", "closed"])
        .optional()
        .describe("Defaults to 'open'"),
      responsibleUserId: z
        .string()
        .optional()
        .describe("Responsible timekeeper (user UUID), optional"),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/matters", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "update_matter",
  {
    title: "Update Matter",
    description:
      "Update a matter. Only the fields you provide change; the rest keep their " +
      "values. Closing a matter (status 'closed') stops nothing at ingest, it only " +
      "labels the matter. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      matterId: z.string().describe("The matter's UUID (from list_matters)"),
      matterNumber: z
        .string()
        .optional()
        .describe("New matter number (unique per org)"),
      name: z.string().optional().describe("New matter name"),
      clientName: z.string().optional().describe("New client or team"),
      status: z.enum(["open", "closed"]).optional(),
      responsibleUserId: z
        .string()
        .nullable()
        .optional()
        .describe("Responsible timekeeper (user UUID); null clears it"),
    },
  },
  async ({ matterId, ...fields }) => {
    try {
      const result = await api.patch(`/matters/${matterId}`, fields);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "delete_matter",
  {
    title: "Delete Matter",
    description:
      "Delete a matter. Its usage events survive and return to Unassigned (the " +
      "response counts them), so the billing record can be re-assigned. The " +
      "matter's routing rules go with it. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      matterId: z.string().describe("The matter's UUID (from list_matters)"),
    },
    annotations: {
      destructiveHint: true,
    },
  },
  async ({ matterId }) => {
    try {
      const result = await api.delete(`/matters/${matterId}`);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "list_unassigned_events",
  {
    title: "List Unassigned Events",
    description:
      "Usage events not attributed to any matter. totalResults is the true all-time " +
      "unassigned count and totalCost sums the whole set, whatever page you fetch " +
      "(eventsMissingCost counts events with unresolved cost; they add 0 to totalCost). " +
      "Work this list toward zero: assign events with assign_event_to_matter, or in " +
      "bulk with apply_matter_rules. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 10, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/matters/unassigned", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "assign_event_to_matter",
  {
    title: "Assign Event to Matter",
    description:
      "Manually put one usage event on a matter, or pull it off (matterId null). " +
      "Manual assignment is the top of the attribution order: it overrides a tag or " +
      "rule, and a manually unassigned event is never re-swept by apply_matter_rules. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      eventId: z
        .string()
        .describe("The usage event's UUID (from list_unassigned_events)"),
      matterId: z
        .string()
        .nullable()
        .describe("Target matter UUID, or null to unassign the event"),
    },
  },
  async (params) => {
    try {
      const result = await api.post("/matters/assign", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "list_matter_rules",
  {
    title: "List Matter Routing Rules",
    description:
      "The organization's matter routing rules in EVALUATION order (priority " +
      "ascending, ties by creation time): the order shown is the order that runs, at " +
      "ingest and in apply_matter_rules. A rule matches when every matcher it sets " +
      "matches. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number (default: 1)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default: 10, max: 100)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/matter-rules", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "upsert_matter_rule",
  {
    title: "Create or Update Matter Routing Rule",
    description:
      "Create a routing rule (no ruleId) or update one (with ruleId). A rule assigns " +
      "untagged usage events to a matter when EVERY matcher it sets matches: " +
      "agentCode exact, customerExternalId exact, signalPattern case-insensitive " +
      "substring. At least one matcher is required. Lower priority runs first. On " +
      "update, only provided fields change; null clears a matcher. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      ruleId: z
        .string()
        .optional()
        .describe("Update this rule (from list_matter_rules). Omit to create."),
      matterId: z
        .string()
        .optional()
        .describe(
          "The matter the rule assigns events to. Required when creating.",
        ),
      priority: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Evaluation priority; lower runs first (default 100)"),
      agentCode: z
        .string()
        .nullable()
        .optional()
        .describe("Exact agent code to match; null clears it on update"),
      customerExternalId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Exact customer external ID to match; null clears it on update",
        ),
      signalPattern: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Case-insensitive signal-name substring; null clears it on update",
        ),
    },
  },
  async ({ ruleId, ...fields }) => {
    try {
      if (!ruleId && !fields.matterId) {
        return errorResponse(
          new Error(
            "matterId is required when creating a rule (no ruleId given).",
          ),
        );
      }
      const result = ruleId
        ? await api.patch(`/matter-rules/${ruleId}`, fields)
        : await api.post("/matter-rules", fields);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "delete_matter_rule",
  {
    title: "Delete Matter Routing Rule",
    description:
      "Delete a routing rule. Events the rule already assigned keep their matter; " +
      "only future matching stops. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      ruleId: z.string().describe("The rule's UUID (from list_matter_rules)"),
    },
    annotations: {
      destructiveHint: true,
    },
  },
  async ({ ruleId }) => {
    try {
      const result = await api.delete(`/matter-rules/${ruleId}`);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "apply_matter_rules",
  {
    title: "Apply Matter Rules to Unassigned",
    description:
      "Sweep the Unassigned list through the routing rules, in priority order, and " +
      "assign every event a rule matches. Touches ONLY events with no matter and no " +
      "attribution history: it never overrides a tag, an earlier rule, or a manual " +
      "decision (including a manual unassignment). Returns how many events were " +
      "assigned. " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await api.post("/matter-rules/apply", {});
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

server.registerTool(
  "export_matter_audit",
  {
    title: "Export Matter Audit",
    description:
      "The audit record you hand a client or an auditor: every matter's actual AI " +
      "cost for a date window. format 'summary' (default) returns one row per matter " +
      "plus an Unassigned row plus org totals, and reconciles exactly with the " +
      "dashboard's CSV export for the same window; 'detail' adds one row per event " +
      "with agent, signal, models, cost, and attribution source. Events with " +
      "unresolved cost count 0 in sums and are flagged in eventsMissingCost, never " +
      "invented. Optional matterId slices to one matter (that view has no Unassigned " +
      "row and no org totals). " +
      "Required role: Legal (Finance/Admin/Owner also work).",
    inputSchema: {
      start: z
        .string()
        .optional()
        .describe(
          "Window start, 'YYYY-MM-DD' (start of day UTC) or full ISO timestamp. " +
            "Defaults to 30 days back.",
        ),
      end: z
        .string()
        .optional()
        .describe(
          "Window end, 'YYYY-MM-DD' (end of day UTC, capped at now) or full ISO " +
            "timestamp. Defaults to now.",
        ),
      format: z
        .enum(["summary", "detail"])
        .optional()
        .describe("'summary' (default) or 'detail' (adds per-event rows)"),
      matterId: z.string().optional().describe("Slice to one matter (UUID)"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async (params) => {
    try {
      const result = await api.get("/matters/audit", params);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr; stdout is the MCP protocol wire
  console.error("MarginFront MCP server running on stdio");
  console.error(`API: ${BASE_URL}`);
  console.error(`Key: ${MASKED_API_KEY}`);
}

main().catch((error) => {
  console.error("Fatal error starting MarginFront MCP server:", error);
  process.exit(1);
});
