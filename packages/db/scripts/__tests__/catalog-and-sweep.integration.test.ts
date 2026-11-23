/**
 * Catalog-and-sweep integration suite: real database, real sync, real repair script.
 *
 * The hermetic sync test next door (sync-service-pricing.test.ts) fakes Prisma,
 * so it can prove the script ISSUES an upsert but never that a row survives the
 * retire step, and it cannot see a Decimal(18,6) round-trip at all. Both of
 * those are exactly where the catalog can silently fail:
 *   - a catalog row hand-written into the DB is retired by the next sync;
 *   - a $10 / 1K WebSearch rate priced through the wrong costUnit branch bills
 *     $880.00 instead of $0.88 and nothing in the type system objects.
 *
 * So this suite runs against a throwaway Postgres database. It is skipped unless
 * CATALOG_SWEEP_TEST_DATABASE_URL is set — NEVER point that at production.
 *
 *   CATALOG_SWEEP_TEST_DATABASE_URL='<throwaway branch url>' npx vitest run \
 *     scripts/__tests__/catalog-and-sweep.integration.test.ts
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, Prisma } from "@prisma/client";
import { assertEventCostInvariant } from "../../src/lib/signal-event-rollup";
import {
  runRepair,
  rollbackFromSnapshot,
  freezeCandidates,
} from "../repair-unpriced-tool-children";

const TEST_DB_URL = process.env.CATALOG_SWEEP_TEST_DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const SYNC_SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "sync-service-pricing.ts",
);

const NEW_TOOL_EXTERNAL_IDS = [
  "tool/reportfindings",
  "tool/enterworktree",
  "tool/exitworktree",
  "tool/close_agent",
] as const;

const DECOY_EXTERNAL_ID = "api/test-decoy-not-in-script";

// Seeded org id is fixed so a crashed run can be cleaned up by hand.
const TEST_ORG_ID = "c0dec0de-0000-4000-8000-00000000c0de";

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DB_URL ?? "postgresql://unset" } },
});

// execFile, not execFileSync: a sync child blocks this worker's event loop for
// the ~90s the sync takes, and vitest kills the worker for missing heartbeats.
const execFileAsync = promisify(execFile);

async function runSync(): Promise<string> {
  const { stdout } = await execFileAsync("npx", ["tsx", SYNC_SCRIPT], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

suite("catalog rows survive the sync", () => {
  beforeAll(async () => {
    await runSync();
  }, 600_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates all four rows active, with a PRICED ZERO input cost", async () => {
    const rows = await prisma.service_pricing.findMany({
      where: { externalId: { in: [...NEW_TOOL_EXTERNAL_IDS] } },
      orderBy: { externalId: "asc" },
    });
    expect(rows.map((r) => r.externalId).sort()).toEqual(
      [...NEW_TOOL_EXTERNAL_IDS].sort(),
    );
    for (const row of rows) {
      expect(row.isActive).toBe(true);
      expect(row.provider).toBe("tool");
      expect(row.serviceType).toBe("Agent Built-in");
      expect(row.costUnit).toBe("request");
      expect(row.source).toBe("builtin");
      // A priced zero, not an absent price. sdk.service.ts treats null as
      // "no rate" and flags the event NEEDS_COST_BACKFILL; 0 bills $0 and
      // lands PROCESSED. The whole point of the row is the second one.
      expect(row.inputCost).not.toBeNull();
      expect(row.inputCost!.equals(new Prisma.Decimal(0))).toBe(true);
    }
  });

  it("resolves each new tool name through the runtime lookup shape", async () => {
    for (const canonicalName of [
      "reportfindings",
      "enterworktree",
      "exitworktree",
      "close_agent",
    ]) {
      const hit = await prisma.service_pricing.findFirst({
        where: { canonicalName, provider: "tool", isActive: true },
      });
      expect(hit, `no active catalog row for ${canonicalName}`).not.toBeNull();
    }
  });

  it("keeps the four rows across a SECOND sync and retires a row the script does not list", async () => {
    await prisma.service_pricing.upsert({
      where: { externalId: DECOY_EXTERNAL_ID },
      create: {
        externalId: DECOY_EXTERNAL_ID,
        canonicalName: "test-decoy-not-in-script",
        displayName: "Catalog decoy",
        provider: "tool",
        serviceType: "Agent Built-in",
        inputCost: new Prisma.Decimal(0),
        outputCost: null,
        costUnit: "request",
        source: "builtin",
        isApi: true,
        isActive: true,
      },
      update: { isActive: true },
    });

    await runSync();

    const survivors = await prisma.service_pricing.findMany({
      where: { externalId: { in: [...NEW_TOOL_EXTERNAL_IDS] } },
    });
    expect(survivors).toHaveLength(NEW_TOOL_EXTERNAL_IDS.length);
    for (const row of survivors) {
      expect(row.isActive).toBe(true);
      expect(row.inputCost!.equals(new Prisma.Decimal(0))).toBe(true);
    }

    // The executable form of "a built-in row has to live in the script":
    // a built-in row absent from BUILT_IN_ROWS is retired on the next sync.
    const decoy = await prisma.service_pricing.findUnique({
      where: { externalId: DECOY_EXTERNAL_ID },
    });
    expect(decoy?.isActive).toBe(false);
  }, 600_000);
});

// ── Part B ────────────────────────────────────────────────────────────

interface SeededIds {
  websearchChildIds: string[];
  freeToolChildIds: string[];
  unpriceableChildIds: string[];
  llmChildId: string;
  llmParentId: string;
  nonToolChildId: string;
  nonToolParentId: string;
  guardRefusedChildId: string;
  guardControlChildId: string;
  zeroCacheControlChildId: string;
  unpricedCacheRow: CatalogRates;
  pricedCacheRow: CatalogRates;
}

/**
 * A pricing row read off the throwaway catalog, so the money expectations below
 * follow the live feed instead of a hard-coded rate that silently rots.
 */
interface CatalogRates {
  id: string;
  canonicalName: string;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
}

/**
 * Independent re-implementation of the "1M tokens" branch. Deliberately NOT
 * calculateEventCost — an expectation that calls the code under test proves
 * nothing.
 */
function expectedTokenCostUsd(
  rates: CatalogRates,
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): Prisma.Decimal {
  const term = (rate: number | null, count: number) =>
    new Prisma.Decimal(count).mul(new Prisma.Decimal(rate ?? 0)).div(1_000_000);
  return term(rates.inputCost, tokens.input)
    .add(term(rates.outputCost, tokens.output))
    .add(term(rates.cacheReadCost, tokens.cacheRead))
    .add(term(rates.cacheWriteCost, tokens.cacheWrite));
}

/**
 * A Codex-shaped turn whose row has
 * no cache-WRITE rate. Priced through the unguarded multiplier those tokens
 * cost $0.00 and the child lands PROCESSED.
 */
const GUARD_TOKENS = {
  input: 1200,
  output: 800,
  cacheRead: 0,
  cacheWrite: 250_010,
} as const;

/** Same turn shape, but the resolved row DOES price cache writes. */
const CONTROL_TOKENS = GUARD_TOKENS;

/** A zero cache-write count against the same unpriced rate must still price. */
const ZERO_CACHE_TOKENS = {
  input: 1200,
  output: 800,
  cacheRead: 4000,
  cacheWrite: 0,
} as const;

/**
 * A synthetic NEEDS_COST_BACKFILL row whose provider is "anthropic", not
 * "tool", with the token mix of a long cached session.
 */
const NON_TOOL_CHILD = {
  model: "claude-opus-5",
  provider: "anthropic",
  inputTokens: 30,
  outputTokens: 14_800,
  cacheReadTokens: 1_250_000,
  cacheWriteTokens: 27_500,
} as const;

/**
 * Tool names with no provider="tool" catalog row, so strategy 1 misses and
 * lookupModelInCatalog falls through to org_model_mappings — the table the
 * dashboard's map-model screen writes. Synthetic on purpose: real tool names
 * such as "shell" and "exec" have catalog rows, which would move these
 * children off the mapping path.
 */
const MAPPED_TOOL_MODELS = {
  refused: "test-mapped-shell",
  control: "test-mapped-exec",
  zeroCache: "test-mapped-webrun",
} as const;

/** A sample WebSearch quantity histogram: 40×1 + 12×2 + 4×3 + 3×4 = 88. */
const WEBSEARCH_QUANTITIES = [
  ...Array(40).fill(1),
  ...Array(12).fill(2),
  ...Array(4).fill(3),
  ...Array(3).fill(4),
] as number[];

async function seedThrowawayOrg(): Promise<SeededIds> {
  const now = new Date();
  await prisma.organizations.create({
    data: {
      id: TEST_ORG_ID,
      name: "Sweep throwaway",
      createdAt: now,
      updatedAt: now,
    },
  });
  const customer = await prisma.customers.create({
    data: {
      id: "c0dec0de-0000-4000-8000-0000000000c1",
      name: "Sweep customer",
      organizationId: TEST_ORG_ID,
      createdAt: now,
      updatedAt: now,
    },
  });
  const agent = await prisma.agents.create({
    data: {
      id: "c0dec0de-0000-4000-8000-0000000000a1",
      name: "Sweep agent",
      agentCode: "test-agent",
      orgId: TEST_ORG_ID,
      createdAt: now,
      updatedAt: now,
    },
  });
  const raw = await prisma.raw_ingest_events.create({
    data: {
      id: "c0dec0de-0000-4000-8000-0000000000f1",
      organizationId: TEST_ORG_ID,
      payload: {},
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });

  let seq = 0;
  const makeId = () =>
    `c0dec0de-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  async function makeEvent(opts: {
    model: string;
    quantity: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    provider?: string;
    priced?: { usageCost: Prisma.Decimal; servicePricingId: string };
  }): Promise<{ parentId: string; childId: string }> {
    const parentId = makeId();
    const childId = makeId();
    const processed = opts.priced != null;
    await prisma.signal_events.create({
      data: {
        id: parentId,
        customerExternalId: "test-sweep",
        customerId: customer.id,
        organizationId: TEST_ORG_ID,
        agentId: agent.id,
        rawIngestEventId: raw.id,
        usageDate: now,
        quantity: new Prisma.Decimal(opts.quantity ?? 1),
        usageCost: processed ? opts.priced!.usageCost : null,
        eventProcessed: processed ? "PROCESSED" : "NEEDS_COST_BACKFILL",
        createdAt: now,
        updatedAt: now,
      },
    });
    await prisma.signal_event_services.create({
      data: {
        id: childId,
        signalEventId: parentId,
        model: opts.model,
        modelProvider: opts.provider ?? "tool",
        // Rows like these carry NULL here, not 0 — the distinction the
        // repair script has to survive.
        inputTokens: opts.inputTokens ?? null,
        outputTokens: opts.outputTokens ?? null,
        cacheReadTokens: opts.cacheReadTokens ?? null,
        cacheWriteTokens: opts.cacheWriteTokens ?? null,
        quantity:
          opts.quantity == null ? null : new Prisma.Decimal(opts.quantity),
        usageCost: processed ? opts.priced!.usageCost : null,
        // JSON null, not SQL NULL — matches how ingest writes these rows.
        usageCostData: Prisma.JsonNull,
        eventStatus: processed ? "PROCESSED" : "NEEDS_COST_BACKFILL",
        servicePricingId: processed ? opts.priced!.servicePricingId : null,
      },
    });
    return { parentId, childId };
  }

  const websearchChildIds: string[] = [];
  for (const quantity of WEBSEARCH_QUANTITIES) {
    const { childId } = await makeEvent({ model: "WebSearch", quantity });
    websearchChildIds.push(childId);
  }

  const freeToolChildIds: string[] = [];
  for (const model of ["StructuredOutput", "ReportFindings", "SendMessage"]) {
    const { childId } = await makeEvent({ model, quantity: null });
    freeToolChildIds.push(childId);
  }

  // Negative control: a tool name with no catalog row on any run.
  const unpriceableChildIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const { childId } = await makeEvent({
      model: "ThisToolHasNoCatalogRowAnywhere",
      quantity: 1,
    });
    unpriceableChildIds.push(childId);
  }

  // Control: a representative Anthropic turn, already PROCESSED
  // with cache tokens (synthetic figures). The stored cost is these counts at
  // $5 input / $25 output / $0.50 cache read / $10 cache write per million.
  const opus = await prisma.service_pricing.findFirst({
    where: {
      canonicalName: "claude-opus-4.8",
      provider: "anthropic",
      isActive: true,
    },
  });
  if (!opus) throw new Error("claude-opus-4.8 missing from the test catalog");
  const llm = await makeEvent({
    model: "claude-opus-4.8",
    provider: "anthropic",
    quantity: null,
    inputTokens: 12000,
    outputTokens: 10500,
    cacheReadTokens: 650000,
    cacheWriteTokens: 50000,
    priced: {
      usageCost: new Prisma.Decimal("1.147500"),
      servicePricingId: opus.id,
    },
  });

  // Scope control: an unpriced NON-tool child in the SAME org, resolvable
  // through the very same catalog the sweep reads. Nothing but the provider
  // filter keeps the sweep off it.
  const nonTool = await makeEvent({
    model: NON_TOOL_CHILD.model,
    provider: NON_TOOL_CHILD.provider,
    quantity: null,
    inputTokens: NON_TOOL_CHILD.inputTokens,
    outputTokens: NON_TOOL_CHILD.outputTokens,
    cacheReadTokens: NON_TOOL_CHILD.cacheReadTokens,
    cacheWriteTokens: NON_TOOL_CHILD.cacheWriteTokens,
  });
  const nonToolTarget = await prisma.service_pricing.findFirst({
    where: {
      canonicalName: NON_TOOL_CHILD.model,
      provider: NON_TOOL_CHILD.provider,
      isActive: true,
    },
  });
  // Without this the "untouched" assertion would pass for the wrong reason —
  // the script skips an unresolvable model whatever its provider filter does.
  if (!nonToolTarget) {
    throw new Error(
      `${NON_TOOL_CHILD.model} is missing from the test catalog, so the scope ` +
        `test cannot distinguish "filtered out" from "not priceable".`,
    );
  }

  const unpricedCacheRow = await readRates({
    provider: "openai",
    cacheWriteCostNull: true,
  });
  const pricedCacheRow = await readRates({
    provider: "openai",
    cacheWriteCostNull: false,
  });

  async function mapToolModel(sourceModel: string, targetPricingId: string) {
    await prisma.org_model_mappings.create({
      data: {
        id: makeId(),
        organizationId: TEST_ORG_ID,
        // lookupModelInCatalog normalizes before the lookup, so the stored
        // key must already be lowercase or strategy 3 never matches.
        sourceModel: sourceModel.toLowerCase(),
        sourceProvider: "tool",
        targetPricingId,
      },
    });
  }

  const guardRefused = await makeEvent({
    model: MAPPED_TOOL_MODELS.refused,
    quantity: null,
    inputTokens: GUARD_TOKENS.input,
    outputTokens: GUARD_TOKENS.output,
    cacheReadTokens: GUARD_TOKENS.cacheRead,
    cacheWriteTokens: GUARD_TOKENS.cacheWrite,
  });
  await mapToolModel(MAPPED_TOOL_MODELS.refused, unpricedCacheRow.id);

  const guardControl = await makeEvent({
    model: MAPPED_TOOL_MODELS.control,
    quantity: null,
    inputTokens: CONTROL_TOKENS.input,
    outputTokens: CONTROL_TOKENS.output,
    cacheReadTokens: CONTROL_TOKENS.cacheRead,
    cacheWriteTokens: CONTROL_TOKENS.cacheWrite,
  });
  await mapToolModel(MAPPED_TOOL_MODELS.control, pricedCacheRow.id);

  const zeroCacheControl = await makeEvent({
    model: MAPPED_TOOL_MODELS.zeroCache,
    quantity: null,
    inputTokens: ZERO_CACHE_TOKENS.input,
    outputTokens: ZERO_CACHE_TOKENS.output,
    cacheReadTokens: ZERO_CACHE_TOKENS.cacheRead,
    cacheWriteTokens: ZERO_CACHE_TOKENS.cacheWrite,
  });
  await mapToolModel(MAPPED_TOOL_MODELS.zeroCache, unpricedCacheRow.id);

  return {
    websearchChildIds,
    freeToolChildIds,
    unpriceableChildIds,
    llmChildId: llm.childId,
    llmParentId: llm.parentId,
    nonToolChildId: nonTool.childId,
    nonToolParentId: nonTool.parentId,
    guardRefusedChildId: guardRefused.childId,
    guardControlChildId: guardControl.childId,
    zeroCacheControlChildId: zeroCacheControl.childId,
    unpricedCacheRow,
    pricedCacheRow,
  };
}

/**
 * Picks a live "1M tokens" row by the SHAPE the test needs rather than by name,
 * so a feed rename does not turn a real assertion into a skipped one, and
 * asserts the shape it got.
 */
async function readRates(want: {
  provider: string;
  cacheWriteCostNull: boolean;
}): Promise<CatalogRates> {
  const row = await prisma.service_pricing.findFirst({
    where: {
      provider: want.provider,
      costUnit: "1M tokens",
      isActive: true,
      inputCost: { gt: 0 },
      outputCost: { gt: 0 },
      cacheReadCost: { not: null },
      cacheWriteCost: want.cacheWriteCostNull ? null : { not: null },
    },
    orderBy: { canonicalName: "asc" },
  });
  if (!row) {
    throw new Error(
      `No active ${want.provider} "1M tokens" row with cacheWriteCost ` +
        `${want.cacheWriteCostNull ? "NULL" : "set"} in the test catalog. ` +
        `The guard tests need both shapes to exist.`,
    );
  }
  const rates: CatalogRates = {
    id: row.id,
    canonicalName: row.canonicalName,
    inputCost: Number(row.inputCost),
    outputCost: Number(row.outputCost),
    cacheReadCost: row.cacheReadCost == null ? null : Number(row.cacheReadCost),
    cacheWriteCost:
      row.cacheWriteCost == null ? null : Number(row.cacheWriteCost),
  };
  expect(rates.cacheWriteCost == null).toBe(want.cacheWriteCostNull);
  expect(rates.cacheReadCost).not.toBeNull();
  return rates;
}

async function teardownThrowawayOrg(): Promise<void> {
  await prisma.signal_event_services.deleteMany({
    where: { signal_events: { organizationId: TEST_ORG_ID } },
  });
  await prisma.signal_events.deleteMany({
    where: { organizationId: TEST_ORG_ID },
  });
  await prisma.raw_ingest_events.deleteMany({
    where: { organizationId: TEST_ORG_ID },
  });
  await prisma.agents.deleteMany({ where: { orgId: TEST_ORG_ID } });
  await prisma.customers.deleteMany({
    where: { organizationId: TEST_ORG_ID },
  });
  await prisma.organizations.deleteMany({ where: { id: TEST_ORG_ID } });
}

async function childRow(id: string) {
  return prisma.signal_event_services.findUniqueOrThrow({ where: { id } });
}

/**
 * Runs the REAL canon assertion (the one api-nest re-exports) over every
 * parent in the throwaway org, not a re-implementation of it.
 */
async function assertInvariantEverywhere(): Promise<void> {
  const parents = await prisma.signal_events.findMany({
    where: { organizationId: TEST_ORG_ID },
    select: { id: true },
  });
  expect(parents.length).toBeGreaterThan(0);
  for (const parent of parents) {
    await assertEventCostInvariant(parent.id, prisma);
  }
}

suite("repair script on a sample org", () => {
  let seeded: SeededIds;
  let snapshotDir: string;
  let llmBefore: Awaited<ReturnType<typeof childRow>>;
  let nonToolBefore: Awaited<ReturnType<typeof childRow>>;

  /** Every child the sweep is allowed to write, priced. */
  const appliedCount = () => WEBSEARCH_QUANTITIES.length + 3 + 2;

  beforeAll(async () => {
    await teardownThrowawayOrg();
    seeded = await seedThrowawayOrg();
    llmBefore = await childRow(seeded.llmChildId);
    nonToolBefore = await childRow(seeded.nonToolChildId);
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
  }, 600_000);

  afterAll(async () => {
    await teardownThrowawayOrg();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("dry run plans the deltas and writes nothing", async () => {
    const result = await runRepair({
      organizationId: TEST_ORG_ID,
      prisma,
      log: () => {},
    });
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.snapshotPath).toBeNull();

    const websearchUsd = result.planned
      .filter((p) => p.model === "WebSearch")
      .reduce((sum, p) => sum.add(p.totalCostUsd), new Prisma.Decimal(0));
    expect(websearchUsd.toFixed(6)).toBe("0.880000");

    const expectedTotal = new Prisma.Decimal("0.88")
      .add(expectedTokenCostUsd(seeded.pricedCacheRow, CONTROL_TOKENS))
      .add(expectedTokenCostUsd(seeded.unpricedCacheRow, ZERO_CACHE_TOKENS));
    expect(result.plannedTotalUsd.toFixed(6)).toBe(expectedTotal.toFixed(6));

    const stillNull = await prisma.signal_event_services.count({
      where: {
        signal_events: { organizationId: TEST_ORG_ID },
        usageCost: null,
      },
    });
    expect(stillNull).toBe(
      WEBSEARCH_QUANTITIES.length +
        seeded.freeToolChildIds.length +
        seeded.unpriceableChildIds.length +
        // nonTool, guardRefused, guardControl, zeroCacheControl
        4,
    );
  });

  it("plans nothing for a non-tool child, whatever its model resolves to", async () => {
    const result = await runRepair({
      organizationId: TEST_ORG_ID,
      prisma,
      log: () => {},
    });
    expect(result.frozenChildIds).not.toContain(seeded.nonToolChildId);
    expect(result.planned.map((p) => p.childId)).not.toContain(
      seeded.nonToolChildId,
    );
    for (const change of result.planned) {
      expect(change.modelProvider.trim().toLowerCase()).toBe("tool");
    }
    // Negative control: the tool children in the SAME org are still swept, so
    // this is a provider filter and not an accidental no-op.
    expect(result.planned.length).toBe(appliedCount());
  });

  it("refuses a cache-bearing child whose row has no cache-write rate", async () => {
    const result = await runRepair({
      organizationId: TEST_ORG_ID,
      prisma,
      log: () => {},
    });
    // In scope — the guard is what stops it, not the provider filter.
    expect(result.frozenChildIds).toContain(seeded.guardRefusedChildId);
    expect(result.planned.map((p) => p.childId)).not.toContain(
      seeded.guardRefusedChildId,
    );

    const refusal = result.refusedByGuard.find(
      (r) => r.childId === seeded.guardRefusedChildId,
    );
    expect(refusal, "the guard refusal was never reported").toBeDefined();
    expect(refusal!.kind).toBe("missing-rate");
    expect(refusal!.missingRates).toEqual(["cacheWriteCost"]);
    expect(refusal!.reason).toContain("usageCost: null");
  });

  it("prices a cache-bearing child normally when the row HAS a cache-write rate", async () => {
    const result = await runRepair({
      organizationId: TEST_ORG_ID,
      prisma,
      log: () => {},
    });
    const control = result.planned.find(
      (p) => p.childId === seeded.guardControlChildId,
    );
    expect(control, "the guard refused a fully-priced row").toBeDefined();
    expect(control!.totalCostUsd.toFixed(6)).toBe(
      expectedTokenCostUsd(seeded.pricedCacheRow, CONTROL_TOKENS).toFixed(6),
    );

    // A ZERO cache-write count against the SAME unpriced rate must price, not
    // refuse: a genuine 0 can never trip the guard.
    const zero = result.planned.find(
      (p) => p.childId === seeded.zeroCacheControlChildId,
    );
    expect(zero, "a zero cache-write count tripped the guard").toBeDefined();
    expect(zero!.totalCostUsd.toFixed(6)).toBe(
      expectedTokenCostUsd(seeded.unpricedCacheRow, ZERO_CACHE_TOKENS).toFixed(
        6,
      ),
    );
    expect(result.refusedByGuard.map((r) => r.childId)).not.toContain(
      seeded.zeroCacheControlChildId,
    );
  });

  it("aborts before writing when the plan blows through --max-total-usd", async () => {
    await expect(
      runRepair({
        organizationId: TEST_ORG_ID,
        prisma,
        apply: true,
        maxTotalUsd: 0.5,
        snapshotPath: path.join(snapshotDir, "never.json"),
        log: () => {},
      }),
    ).rejects.toThrow(/exceeds the --max-total-usd ceiling/);
    expect(fs.existsSync(path.join(snapshotDir, "never.json"))).toBe(false);
    const stillNull = await prisma.signal_event_services.count({
      where: {
        signal_events: { organizationId: TEST_ORG_ID },
        usageCost: null,
      },
    });
    expect(stillNull).toBeGreaterThan(0);
  });

  it("survives a midpoint failure with every committed batch consistent", async () => {
    const snapshotPath = path.join(snapshotDir, "midpoint.json");
    await expect(
      runRepair({
        organizationId: TEST_ORG_ID,
        prisma,
        apply: true,
        maxTotalUsd: 1000,
        batchSize: 10,
        snapshotPath,
        log: () => {},
        afterBatch: async (index) => {
          if (index === 1) throw new Error("simulated crash after batch 1");
        },
      }),
    ).rejects.toThrow("simulated crash after batch 1");

    // Two batches of 10 committed; the rest are untouched.
    const repaired = await prisma.signal_event_services.count({
      where: {
        signal_events: { organizationId: TEST_ORG_ID },
        eventStatus: "PROCESSED",
        usageCost: { not: null },
        model: "WebSearch",
      },
    });
    expect(repaired).toBe(20);
    await assertInvariantEverywhere();

    // The snapshot was written BEFORE the first batch, so it still covers
    // everything the run intended to touch — including the 20 that landed.
    expect(fs.existsSync(snapshotPath)).toBe(true);
    await rollbackFromSnapshot(prisma, snapshotPath, () => {});
    const backToNull = await prisma.signal_event_services.count({
      where: {
        signal_events: { organizationId: TEST_ORG_ID },
        model: "WebSearch",
        usageCost: null,
      },
    });
    expect(backToNull).toBe(WEBSEARCH_QUANTITIES.length);
    await assertInvariantEverywhere();
  }, 300_000);

  it("prices WebSearch at exactly $0.88 for 88 searches, not $880.00", async () => {
    const snapshotPath = path.join(snapshotDir, "apply.json");
    const result = await runRepair({
      organizationId: TEST_ORG_ID,
      prisma,
      apply: true,
      maxTotalUsd: 1000,
      snapshotPath,
      log: () => {},
    });
    expect(result.applied).toBe(appliedCount());

    const rows = await prisma.signal_event_services.findMany({
      where: { id: { in: seeded.websearchChildIds } },
    });
    const total = rows.reduce(
      (sum, row) => sum.add(row.usageCost ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    );
    // $10 per 1,000 searches. The flat branch would return 88 × 10 = $880.
    expect(total.toFixed(6)).toBe("0.880000");
    for (const row of rows) {
      expect(row.eventStatus).toBe("PROCESSED");
      expect(row.servicePricingId).not.toBeNull();
    }
    const singleSearch = rows.find((r) => Number(r.quantity) === 1)!;
    expect(singleSearch.usageCost!.toFixed(6)).toBe("0.010000");
  }, 300_000);

  it("prices the $0 built-ins at zero and flips their parents to PROCESSED", async () => {
    for (const id of seeded.freeToolChildIds) {
      const row = await childRow(id);
      expect(row.eventStatus).toBe("PROCESSED");
      expect(row.usageCost!.equals(new Prisma.Decimal(0))).toBe(true);
      const parent = await prisma.signal_events.findUniqueOrThrow({
        where: { id: row.signalEventId },
      });
      expect(parent.eventProcessed).toBe("PROCESSED");
      expect(parent.usageCost!.equals(new Prisma.Decimal(0))).toBe(true);
    }
    await assertInvariantEverywhere();
  }, 300_000);

  it("leaves a tool with no catalog row exactly as it found it", async () => {
    for (const id of seeded.unpriceableChildIds) {
      const row = await childRow(id);
      expect(row.usageCost).toBeNull();
      expect(row.eventStatus).toBe("NEEDS_COST_BACKFILL");
      expect(row.servicePricingId).toBeNull();
      const parent = await prisma.signal_events.findUniqueOrThrow({
        where: { id: row.signalEventId },
      });
      expect(parent.usageCost).toBeNull();
    }
  });

  it("does not touch the already-priced Anthropic LLM child", async () => {
    const after = await childRow(seeded.llmChildId);
    expect(after).toEqual(llmBefore);
  });

  it("leaves the non-tool child byte-identical after a real --apply", async () => {
    const after = await childRow(seeded.nonToolChildId);
    expect(after).toEqual(nonToolBefore);
    const parent = await prisma.signal_events.findUniqueOrThrow({
      where: { id: seeded.nonToolParentId },
    });
    expect(parent.usageCost).toBeNull();
    expect(parent.eventProcessed).toBe("NEEDS_COST_BACKFILL");
  });

  it("leaves the guard-refused child unpriced rather than PROCESSED at a fabricated $0", async () => {
    const row = await childRow(seeded.guardRefusedChildId);
    expect(row.usageCost).toBeNull();
    expect(row.eventStatus).toBe("NEEDS_COST_BACKFILL");
    expect(row.servicePricingId).toBeNull();
    const parent = await prisma.signal_events.findUniqueOrThrow({
      where: { id: row.signalEventId },
    });
    expect(parent.usageCost).toBeNull();

    // The two priced controls DID land, so the guard is selective.
    for (const id of [
      seeded.guardControlChildId,
      seeded.zeroCacheControlChildId,
    ]) {
      const control = await childRow(id);
      expect(control.eventStatus).toBe("PROCESSED");
      expect(control.usageCost).not.toBeNull();
    }
    await assertInvariantEverywhere();
  }, 300_000);

  it("is idempotent — a second apply changes nothing", async () => {
    const before = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT sum(ses."usageCost")::text AS total
      FROM signal_event_services ses
      JOIN signal_events se ON se.id = ses."signalEventId"
      WHERE se."organizationId" = ${TEST_ORG_ID}::uuid
    `;
    const second = await runRepair({
      organizationId: TEST_ORG_ID,
      prisma,
      apply: true,
      maxTotalUsd: 1000,
      snapshotPath: path.join(snapshotDir, "second.json"),
      log: () => {},
    });
    expect(second.applied).toBe(0);
    expect(second.planned).toHaveLength(0);
    const after = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT sum(ses."usageCost")::text AS total
      FROM signal_event_services ses
      JOIN signal_events se ON se.id = ses."signalEventId"
      WHERE se."organizationId" = ${TEST_ORG_ID}::uuid
    `;
    expect(after[0].total).toBe(before[0].total);
    expect(second.refusedByGuard.map((r) => r.childId)).toEqual([
      seeded.guardRefusedChildId,
    ]);
    const remaining = await freezeCandidates(prisma, TEST_ORG_ID);
    // The non-tool child is still unpriced in the DB but is not a
    // candidate: the filter is on the freeze query, not on the write.
    expect(remaining.map((r) => r.model).sort()).toEqual([
      "ThisToolHasNoCatalogRowAnywhere",
      "ThisToolHasNoCatalogRowAnywhere",
      MAPPED_TOOL_MODELS.refused,
    ]);
  }, 300_000);

  it("rolls back to JSON null, not SQL NULL and not zero", async () => {
    await rollbackFromSnapshot(
      prisma,
      path.join(snapshotDir, "apply.json"),
      () => {},
    );

    const restored = await prisma.$queryRaw<
      {
        id: string;
        is_sql_null: boolean;
        as_text: string | null;
        cost: string | null;
        status: string;
      }[]
    >`
      SELECT id,
             "usageCostData" IS NULL      AS is_sql_null,
             "usageCostData"::text        AS as_text,
             "usageCost"::text            AS cost,
             "eventStatus"::text          AS status
      FROM signal_event_services
      WHERE id = ANY(${seeded.websearchChildIds}::uuid[])
    `;
    expect(restored).toHaveLength(WEBSEARCH_QUANTITIES.length);
    for (const row of restored) {
      expect(row.cost).toBeNull();
      expect(row.status).toBe("NEEDS_COST_BACKFILL");
      // The column held a JSON `null` before the repair. Restoring it as a
      // SQL NULL (or as 0/{}) would be a silent schema-level data change.
      expect(row.is_sql_null).toBe(false);
      expect(row.as_text).toBe("null");
    }
    await assertInvariantEverywhere();
  }, 300_000);
});
