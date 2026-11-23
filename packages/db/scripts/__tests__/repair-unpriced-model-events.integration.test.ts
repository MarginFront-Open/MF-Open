/**
 * The unpriced-event repair on model (non-tool) children.
 *
 * Real database only: the freeze query, the org mapping lookup and the
 * Decimal(18,6) round trip are exactly what a faked Prisma cannot see. Skipped
 * unless REPAIR_MODEL_TEST_DATABASE_URL is set — a throwaway Postgres database, NEVER
 * production.
 *
 *   REPAIR_MODEL_TEST_DATABASE_URL='<throwaway branch url>' npx vitest run \
 *     --config vitest.config.integration.ts \
 *     scripts/__tests__/repair-unpriced-model-events.integration.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, Prisma } from "@prisma/client";
import {
  isPriceRefused,
  lookupModelInCatalog,
  resolveEventPrice,
} from "../../src/lib/model-pricing";
import { assertEventCostInvariant } from "../../src/lib/signal-event-rollup";
import {
  freezeCandidates,
  rollbackFromSnapshot,
  runRepair,
  runRepairAllOrgs,
} from "../repair-unpriced-tool-children";

const TEST_DB_URL = process.env.REPAIR_MODEL_TEST_DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const ORG_A = "7680de15-0000-4000-8000-00000000000a";
const ORG_B = "7680de15-0000-4000-8000-00000000000b";
const ALL_TEST_ORGS = [ORG_A, ORG_B];

const TOKENS = {
  input: 1834,
  output: 912,
  cacheRead: 150_000,
  cacheWrite: 12_400,
} as const;

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DB_URL ?? "postgresql://unset" } },
});

interface Seeded {
  priceableRow: { id: string; canonicalName: string; provider: string };
  conflictRow: { id: string; canonicalName: string };
  qualifyingChildIds: string[];
  multiServiceParentId: string;
  overrideChildId: string;
  noRowChildId: string;
  missingVolumeChildId: string;
  pricedAtIngestChildId: string;
  statusMissingVolumeChildId: string;
  conflictChildId: string;
  toolChildId: string;
  outcomeChildId: string;
  orgBChildId: string;
}

function uuidFor(org: string, n: number): string {
  return `${org.slice(0, 23)}-${org.slice(-1)}${String(n).padStart(11, "0")}`;
}

async function seedOrg(org: string) {
  const now = new Date();
  await prisma.organizations.create({
    data: {
      id: org,
      name: `Reprice ${org.slice(-1)}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.customers.create({
    data: {
      id: uuidFor(org, 900001),
      name: "reprice customer",
      organizationId: org,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.agents.create({
    data: {
      id: uuidFor(org, 900002),
      name: "reprice agent",
      agentCode: `reprice-agent-${org.slice(-1)}`,
      orgId: org,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.raw_ingest_events.create({
    data: {
      id: uuidFor(org, 900003),
      organizationId: org,
      payload: {},
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

let counter = 0;

interface ChildSpec {
  model: string;
  provider: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  quantity?: number | null;
  status?: "NEEDS_COST_BACKFILL" | "MISSING_VOLUME_DATA" | "PROCESSED";
  servicePricingId?: string | null;
  usageCost?: Prisma.Decimal | null;
  usageCostData?: Prisma.InputJsonValue;
}

async function makeEvent(
  org: string,
  children: ChildSpec[],
): Promise<{ parentId: string; childIds: string[] }> {
  const now = new Date();
  const parentId = uuidFor(org, ++counter);
  const statuses = children.map((c) => c.status ?? "NEEDS_COST_BACKFILL");
  const parentStatus = statuses.includes("NEEDS_COST_BACKFILL")
    ? "NEEDS_COST_BACKFILL"
    : statuses.includes("MISSING_VOLUME_DATA")
      ? "MISSING_VOLUME_DATA"
      : "PROCESSED";
  const resolved = children.filter((c) => c.usageCost != null);
  const parentCostData =
    resolved.length > 0
      ? Object.assign(
          {},
          ...resolved.map((c) => c.usageCostData as Record<string, unknown>),
        )
      : null;
  await prisma.signal_events.create({
    data: {
      id: parentId,
      customerExternalId: "test-repair",
      customerId: uuidFor(org, 900001),
      organizationId: org,
      agentId: uuidFor(org, 900002),
      rawIngestEventId: uuidFor(org, 900003),
      usageDate: now,
      quantity: new Prisma.Decimal(1),
      metadata: {},
      usageCost: null,
      usageCostData: parentCostData ?? Prisma.DbNull,
      eventProcessed: parentStatus,
      createdAt: now,
      updatedAt: now,
    },
  });
  const childIds: string[] = [];
  for (const spec of children) {
    const childId = uuidFor(org, ++counter);
    await prisma.signal_event_services.create({
      data: {
        id: childId,
        signalEventId: parentId,
        model: spec.model,
        modelProvider: spec.provider,
        inputTokens:
          spec.inputTokens === undefined ? TOKENS.input : spec.inputTokens,
        outputTokens:
          spec.outputTokens === undefined ? TOKENS.output : spec.outputTokens,
        cacheReadTokens:
          spec.cacheReadTokens === undefined
            ? TOKENS.cacheRead
            : spec.cacheReadTokens,
        cacheWriteTokens:
          spec.cacheWriteTokens === undefined
            ? TOKENS.cacheWrite
            : spec.cacheWriteTokens,
        quantity:
          spec.quantity == null ? null : new Prisma.Decimal(spec.quantity),
        usageCost: spec.usageCost ?? null,
        usageCostData: spec.usageCostData ?? Prisma.DbNull,
        eventStatus: spec.status ?? "NEEDS_COST_BACKFILL",
        servicePricingId: spec.servicePricingId ?? null,
      },
    });
    childIds.push(childId);
  }
  return { parentId, childIds };
}

async function teardown(): Promise<void> {
  await prisma.signal_event_services.deleteMany({
    where: { signal_events: { organizationId: { in: ALL_TEST_ORGS } } },
  });
  await prisma.signal_events.deleteMany({
    where: { organizationId: { in: ALL_TEST_ORGS } },
  });
  await prisma.org_model_mappings.deleteMany({
    where: { organizationId: { in: ALL_TEST_ORGS } },
  });
  await prisma.raw_ingest_events.deleteMany({
    where: { organizationId: { in: ALL_TEST_ORGS } },
  });
  await prisma.agents.deleteMany({ where: { orgId: { in: ALL_TEST_ORGS } } });
  await prisma.customers.deleteMany({
    where: { organizationId: { in: ALL_TEST_ORGS } },
  });
  await prisma.organizations.deleteMany({
    where: { id: { in: ALL_TEST_ORGS } },
  });
}

async function pickPricedModelRow(excludeId?: string) {
  const row = await prisma.service_pricing.findFirst({
    where: {
      provider: "anthropic",
      costUnit: "1M tokens",
      isActive: true,
      inputCost: { gt: 0 },
      outputCost: { gt: 0 },
      cacheReadCost: { not: null },
      cacheWriteCost: { not: null },
      canonicalName: { not: { contains: ":" } },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    orderBy: { canonicalName: "desc" },
  });
  if (!row) {
    throw new Error(
      "No active anthropic 1M-token row with both cache rates in the test catalog.",
    );
  }
  return row;
}

async function seed(): Promise<Seeded> {
  await seedOrg(ORG_A);
  await seedOrg(ORG_B);

  const priceable = await pickPricedModelRow();
  const conflict = await pickPricedModelRow(priceable.id);
  const model = priceable.canonicalName;

  const qualifyingChildIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const { childIds } = await makeEvent(ORG_A, [
      { model, provider: "anthropic" },
    ]);
    qualifyingChildIds.push(...childIds);
  }

  const toolCostData = {
    "Read/input": { cost: 0, units: 0, costPerUnit: 0 },
  };
  const multi = await makeEvent(ORG_A, [
    { model, provider: "anthropic" },
    {
      model: "Read",
      provider: "tool",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      quantity: 1,
      status: "PROCESSED",
      usageCost: new Prisma.Decimal("0.010000"),
      usageCostData: toolCostData,
    },
  ]);
  qualifyingChildIds.push(multi.childIds[0]);

  const overrideModel = "test-house-alias";
  const override = await makeEvent(ORG_A, [
    { model: overrideModel, provider: "anthropic" },
  ]);
  await prisma.org_model_mappings.create({
    data: {
      organizationId: ORG_A,
      sourceModel: overrideModel,
      sourceProvider: "anthropic",
      targetPricingId: conflict.id,
    },
  });

  const noRow = await makeEvent(ORG_A, [
    { model: "test-model-with-no-row", provider: "anthropic" },
  ]);
  const missingVolume = await makeEvent(ORG_A, [
    { model, provider: "anthropic", inputTokens: null },
  ]);
  const pricedAtIngest = await makeEvent(ORG_A, [
    { model, provider: "anthropic", servicePricingId: priceable.id },
  ]);
  const statusMissingVolume = await makeEvent(ORG_A, [
    {
      model,
      provider: "anthropic",
      outputTokens: null,
      status: "MISSING_VOLUME_DATA",
      servicePricingId: priceable.id,
    },
  ]);

  const conflictChild = await makeEvent(ORG_A, [
    { model: conflict.canonicalName, provider: "anthropic" },
  ]);
  await prisma.org_model_mappings.create({
    data: {
      organizationId: ORG_A,
      sourceModel: conflict.canonicalName,
      sourceProvider: "anthropic",
      targetPricingId: priceable.id,
    },
  });

  const tool = await makeEvent(ORG_A, [
    {
      model: "WebSearch",
      provider: "tool",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      quantity: 1,
    },
  ]);
  const outcome = await makeEvent(ORG_A, [
    {
      model: "work-item",
      provider: "outcome",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      quantity: 1,
    },
  ]);

  const orgB = await makeEvent(ORG_B, [{ model, provider: "anthropic" }]);

  return {
    priceableRow: {
      id: priceable.id,
      canonicalName: priceable.canonicalName,
      provider: priceable.provider,
    },
    conflictRow: { id: conflict.id, canonicalName: conflict.canonicalName },
    qualifyingChildIds,
    multiServiceParentId: multi.parentId,
    overrideChildId: override.childIds[0],
    noRowChildId: noRow.childIds[0],
    missingVolumeChildId: missingVolume.childIds[0],
    pricedAtIngestChildId: pricedAtIngest.childIds[0],
    statusMissingVolumeChildId: statusMissingVolume.childIds[0],
    conflictChildId: conflictChild.childIds[0],
    toolChildId: tool.childIds[0],
    outcomeChildId: outcome.childIds[0],
    orgBChildId: orgB.childIds[0],
  };
}

async function fingerprint(orgs: string[]): Promise<string> {
  const rows = await prisma.$queryRaw<{ fp: string | null }[]>`
    SELECT md5(string_agg(line, '|' ORDER BY line)) AS fp FROM (
      SELECT concat_ws(',', ses.id, coalesce(ses."usageCost"::text, 'NULL'),
               coalesce(ses."usageCostData"::text, 'SQLNULL'),
               ses."eventStatus"::text, coalesce(ses."servicePricingId"::text, '-'),
               coalesce(se."usageCost"::text, 'NULL'), coalesce(se."usageCostData"::text, 'SQLNULL'),
               se."eventProcessed"::text) AS line
      FROM signal_event_services ses
      JOIN signal_events se ON se.id = ses."signalEventId"
      WHERE se."organizationId" = ANY(${orgs}::uuid[])
    ) t
  `;
  return rows[0].fp ?? "";
}

async function child(id: string) {
  return prisma.signal_event_services.findUniqueOrThrow({ where: { id } });
}

suite("unpriced MODEL event repair", () => {
  let seeded: Seeded;
  let snapshotDir: string;

  beforeAll(async () => {
    await teardown();
    seeded = await seed();
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
  }, 300_000);

  afterAll(async () => {
    await teardown();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("plans only rows whose sole problem was a missing catalog row, and reports the rest", async () => {
    const result = await runRepair({
      organizationId: ORG_A,
      prisma,
      provider: "model",
      log: () => {},
    });
    const plannedIds = result.planned.map((p) => p.childId).sort();
    expect(plannedIds).toEqual(
      [...seeded.qualifyingChildIds, seeded.overrideChildId].sort(),
    );

    const reported = new Map(
      result.notQualified.map((n) => [n.childId, n.reason]),
    );
    expect(reported.get(seeded.missingVolumeChildId)).toBe("missing-volume");
    expect(reported.get(seeded.pricedAtIngestChildId)).toBe(
      "priced-row-existed-at-ingest",
    );
    expect(reported.get(seeded.conflictChildId)).toBe("mapping-conflict");

    expect(
      result.skippedNoCatalogRow.find(
        (s) => s.model === "test-model-with-no-row",
      )?.count,
    ).toBe(1);

    for (const excluded of [
      seeded.toolChildId,
      seeded.outcomeChildId,
      seeded.statusMissingVolumeChildId,
    ]) {
      expect(result.frozenChildIds).not.toContain(excluded);
    }
  });

  it("keeps the tool scope as the default and never sweeps the outcome provider", async () => {
    const toolOnly = await runRepair({
      organizationId: ORG_A,
      prisma,
      log: () => {},
    });
    expect(toolOnly.frozenChildIds).toEqual([seeded.toolChildId]);

    const any = await freezeCandidates(prisma, ORG_A, "any");
    const ids = any.map((r) => r.id);
    expect(ids).toContain(seeded.toolChildId);
    expect(ids).toContain(seeded.qualifyingChildIds[0]);
    expect(ids).not.toContain(seeded.outcomeChildId);
  });

  it("prices every row at exactly the cost the ingest path computes", async () => {
    const result = await runRepair({
      organizationId: ORG_A,
      prisma,
      provider: "model",
      log: () => {},
    });
    expect(result.planned.map((p) => p.childId)).toEqual(
      expect.arrayContaining(seeded.qualifyingChildIds),
    );
    for (const change of result.planned) {
      const row = await child(change.childId);
      const entry = await lookupModelInCatalog(
        prisma,
        row.model,
        row.modelProvider,
        ORG_A,
      );
      expect(entry).not.toBeNull();
      const ingest = resolveEventPrice({
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        quantity: row.quantity == null ? 1 : Number(row.quantity),
        entry: entry!,
        cacheReadTokens: row.cacheReadTokens ?? 0,
        cacheWriteTokens: row.cacheWriteTokens ?? 0,
        provider: row.modelProvider,
        cacheWriteTtl: undefined,
        model: row.model,
      });
      if (isPriceRefused(ingest)) throw new Error(ingest.reason);
      expect(change.totalCostUsd.toFixed(6)).toBe(
        ingest.price.totalCostUsd.toFixed(6),
      );
      expect(change.servicePricingId).toBe(entry!.servicePricingId);
    }
  });

  it("resolves a model through the org's override mapping", async () => {
    const result = await runRepair({
      organizationId: ORG_A,
      prisma,
      provider: "model",
      log: () => {},
    });
    const override = result.planned.find(
      (p) => p.childId === seeded.overrideChildId,
    );
    expect(override, "the mapped model was not planned").toBeDefined();
    expect(override!.servicePricingId).toBe(seeded.conflictRow.id);
  });

  it("refuses to write when the plan exceeds --max-total-usd", async () => {
    const before = await fingerprint([ORG_A]);
    const snapshotPath = path.join(snapshotDir, "never.json");
    await expect(
      runRepair({
        organizationId: ORG_A,
        prisma,
        provider: "model",
        apply: true,
        maxTotalUsd: 0.011,
        snapshotPath,
        log: () => {},
      }),
    ).rejects.toThrow(/exceeds the --max-total-usd ceiling/);
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(await fingerprint([ORG_A])).toBe(before);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "refuses an --apply whose ceiling is %s, with no writes",
    async (badCeiling) => {
      const before = await fingerprint(ALL_TEST_ORGS);
      const snapshotPath = path.join(snapshotDir, "bad-ceiling.json");
      await expect(
        runRepair({
          organizationId: ORG_A,
          prisma,
          provider: "model",
          apply: true,
          maxTotalUsd: badCeiling,
          snapshotPath,
          log: () => {},
        }),
      ).rejects.toThrow(/--max-total-usd/);
      await expect(
        runRepairAllOrgs({
          prisma,
          provider: "model",
          apply: true,
          maxTotalUsd: badCeiling,
          snapshotDir,
          log: () => {},
        }),
      ).rejects.toThrow(/--max-total-usd/);
      expect(fs.existsSync(snapshotPath)).toBe(false);
      expect(await fingerprint(ALL_TEST_ORGS)).toBe(before);
    },
    300_000,
  );

  it("refuses a single-org --apply with no ceiling, with no writes", async () => {
    const before = await fingerprint(ALL_TEST_ORGS);
    const snapshotPath = path.join(snapshotDir, "no-ceiling.json");
    await expect(
      runRepair({
        organizationId: ORG_A,
        prisma,
        provider: "model",
        apply: true,
        snapshotPath,
        log: () => {},
      }),
    ).rejects.toThrow(/--max-total-usd/);
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(await fingerprint(ALL_TEST_ORGS)).toBe(before);
  });

  it("all-orgs dry run prints per-org counts and writes nothing", async () => {
    const before = await fingerprint(ALL_TEST_ORGS);
    const lines: string[] = [];
    const result = await runRepairAllOrgs({
      prisma,
      provider: "model",
      log: (line) => lines.push(line),
    });
    const orgA = result.perOrg.find((o) => o.organizationId === ORG_A);
    const orgB = result.perOrg.find((o) => o.organizationId === ORG_B);
    expect(orgA?.planned).toBe(seeded.qualifyingChildIds.length + 1);
    expect(orgB?.planned).toBe(1);
    expect(lines.some((l) => l.includes(ORG_A))).toBe(true);
    expect(await fingerprint(ALL_TEST_ORGS)).toBe(before);
  }, 300_000);

  it("applies within one org only, keeps parents consistent, and rolls back exactly", async () => {
    const beforeA = await fingerprint([ORG_A]);
    const beforeOthers = await fingerprint([ORG_B]);
    const snapshotPath = path.join(snapshotDir, "apply.json");

    const result = await runRepair({
      organizationId: ORG_A,
      prisma,
      provider: "model",
      apply: true,
      maxTotalUsd: 100,
      snapshotPath,
      log: () => {},
    });
    expect(result.applied).toBe(seeded.qualifyingChildIds.length + 1);
    expect(await fingerprint([ORG_B])).toBe(beforeOthers);

    const parent = await prisma.signal_events.findUniqueOrThrow({
      where: { id: seeded.multiServiceParentId },
    });
    const kids = await prisma.signal_event_services.findMany({
      where: { signalEventId: seeded.multiServiceParentId },
    });
    const sum = kids.reduce(
      (acc, k) => acc.add(k.usageCost!),
      new Prisma.Decimal(0),
    );
    expect(parent.eventProcessed).toBe("PROCESSED");
    expect(parent.usageCost!.toFixed(6)).toBe(sum.toFixed(6));
    const parentData = parent.usageCostData as Record<string, unknown>;
    expect(Object.keys(parentData)).toEqual(
      expect.arrayContaining([
        "Read/input",
        `${seeded.priceableRow.canonicalName}/input`,
        `${seeded.priceableRow.canonicalName}/cache_read`,
      ]),
    );
    for (const id of seeded.qualifyingChildIds) {
      const row = await child(id);
      await assertEventCostInvariant(row.signalEventId, prisma);
      expect(row.eventStatus).toBe("PROCESSED");
    }

    for (const untouched of [
      seeded.noRowChildId,
      seeded.missingVolumeChildId,
      seeded.pricedAtIngestChildId,
      seeded.conflictChildId,
    ]) {
      const row = await child(untouched);
      expect(row.usageCost).toBeNull();
      expect(row.eventStatus).toBe("NEEDS_COST_BACKFILL");
    }

    await rollbackFromSnapshot(prisma, snapshotPath, () => {});
    expect(await fingerprint([ORG_A])).toBe(beforeA);
  }, 300_000);
});
