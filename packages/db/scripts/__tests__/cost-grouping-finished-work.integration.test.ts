/**
 * GetCostBreakdown's finishedWork reads against real Postgres.
 *
 * The hermetic script next door (src/lib/cost-grouping-finished-work.test.ts)
 * proves the SQL this function BUILDS. It cannot prove that Postgres groups,
 * case-folds, left-joins and sums the way the page depends on. Everything that
 * can silently go wrong here is a wrong number on a customer's ROI page:
 *   - a case twin shown as two rows, or folded with the wrong casing;
 *   - a bucket with things and no spend vanishing (INNER JOIN) instead of
 *     rendering a dash;
 *   - another org's or another window's events leaking into a bucket;
 *   - the outcome marker matching an event it should not.
 *
 * Skipped unless FINISHED_WORK_TEST_DATABASE_URL is set. NEVER point that at
 * production: this suite writes events and deletes them again.
 *
 *   FINISHED_WORK_TEST_DATABASE_URL='<throwaway branch url>' npx vitest run \
 *     --config vitest.config.integration.ts \
 *     scripts/__tests__/cost-grouping-finished-work.integration.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getCostBreakdown } from "../../src/lib/cost-grouping";

const TEST_DB_URL = process.env.FINISHED_WORK_TEST_DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const WINDOW = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-09-30T23:59:59.999Z"),
};
const IN_WINDOW = new Date("2026-09-15T12:00:00.000Z");
const OUTSIDE_WINDOW = new Date("2026-10-15T12:00:00.000Z");

const DEV_A = "ada@example.test";
const DEV_B = "bo@example.test";

suite("getCostBreakdown finishedWork (real Postgres)", () => {
  let prisma: PrismaClient;
  let orgId: string;
  let otherOrgId: string;
  let meterAgentId: string;
  let codexAgentId: string;
  let sdkAgentId: string;
  let routedMatterId: string;
  const signalIds = new Map<string, string>();

  /** Every id this suite created, newest first, so teardown reverses it. */
  const eventIds: string[] = [];
  const rawIds: string[] = [];

  async function makeSignal(agentId: string, name: string) {
    const key = `${agentId}|${name}`;
    const existing = signalIds.get(key);
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date();
    await prisma.signals.create({
      data: { id, name, agentId, orgId, createdAt: now, updatedAt: now },
    });
    signalIds.set(key, id);
    return id;
  }

  async function makeEvent(opts: {
    org?: string;
    agentId: string;
    customerId: string;
    developer: string;
    signalName: string;
    quantity: number;
    usageCost: number | null;
    usageDate?: Date;
    label?: string | null;
    /** The RESOLVED work item, which beats the raw tag. */
    matterId?: string | null;
    outcome: boolean;
    createdAt?: Date;
  }) {
    const org = opts.org ?? orgId;
    const rawId = randomUUID();
    const now = new Date();
    await prisma.raw_ingest_events.create({
      data: {
        id: rawId,
        organizationId: org,
        payload: { signalName: opts.signalName },
        receivedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    rawIds.push(rawId);

    const id = randomUUID();
    await prisma.signal_events.create({
      data: {
        id,
        organizationId: org,
        agentId: opts.agentId,
        customerId: opts.customerId,
        customerExternalId: opts.developer,
        signalId: await makeSignal(opts.agentId, opts.signalName),
        rawIngestEventId: rawId,
        usageDate: opts.usageDate ?? IN_WINDOW,
        usageCost: opts.usageCost,
        quantity: opts.quantity,
        metadata: opts.label ? { matterId: opts.label } : {},
        matterId: opts.matterId ?? null,
        eventProcessed: "PROCESSED",
        createdAt: opts.createdAt ?? now,
        updatedAt: now,
      },
    });
    eventIds.push(id);

    await prisma.signal_event_services.create({
      data: {
        signalEventId: id,
        model: opts.outcome ? "work-item" : "claude-sonnet-4",
        modelProvider: opts.outcome ? "outcome" : "anthropic",
        quantity: opts.quantity,
        usageCost: opts.usageCost,
        eventStatus: "PROCESSED",
      },
    });
    return id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DB_URL } },
    });
    const now = new Date();

    orgId = randomUUID();
    otherOrgId = randomUUID();
    for (const id of [orgId, otherOrgId]) {
      await prisma.organizations.create({
        data: {
          id,
          name: `finished-work org ${id.slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    meterAgentId = randomUUID();
    sdkAgentId = randomUUID();
    await prisma.agents.create({
      data: {
        id: meterAgentId,
        orgId,
        name: "Claude Code",
        agentCode: "claude-code",
        createdAt: now,
        updatedAt: now,
      },
    });
    await prisma.agents.create({
      data: {
        id: sdkAgentId,
        orgId,
        name: "Billing app",
        agentCode: "billing-app",
        createdAt: now,
        updatedAt: now,
      },
    });
    codexAgentId = randomUUID();
    await prisma.agents.create({
      data: {
        id: codexAgentId,
        orgId,
        name: "Codex",
        agentCode: "codex",
        createdAt: now,
        updatedAt: now,
      },
    });
    const otherAgentId = randomUUID();
    await prisma.agents.create({
      data: {
        id: otherAgentId,
        orgId: otherOrgId,
        name: "Other org agent",
        agentCode: "claude-code",
        createdAt: now,
        updatedAt: now,
      },
    });

    // Matters are also assigned by rule and by operator, neither of which leaves
    // a tag in metadata.
    routedMatterId = randomUUID();
    await prisma.matters.create({
      data: {
        id: routedMatterId,
        orgId,
        matterNumber: `ROUTED-${routedMatterId.slice(0, 8)}`,
        name: "Routed work item",
        clientName: "finished-work client",
        createdAt: now,
        updatedAt: now,
      },
    });

    const customerId = randomUUID();
    await prisma.customers.create({
      data: {
        id: customerId,
        organizationId: orgId,
        name: "finished-work customer",
        externalId: `test-${customerId.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
      },
    });
    const otherCustomerId = randomUUID();
    await prisma.customers.create({
      data: {
        id: otherCustomerId,
        organizationId: otherOrgId,
        name: "finished-work other customer",
        externalId: `test-other-${otherCustomerId.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
      },
    });

    const mk = (o: Parameters<typeof makeEvent>[0]) => makeEvent(o);

    // Ada, work item PROJ-101: 2 finished things (one of them a count of 3)
    // plus $12.00 of coding turns. One record carries the name in a second
    // casing, which must fold into the first.
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_A,
      signalName: "Contract summarized",
      quantity: 1,
      usageCost: 0,
      label: "PROJ-101",
      outcome: true,
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_A,
      signalName: "contract SUMMARIZED",
      quantity: 3,
      usageCost: 0,
      label: "PROJ-101",
      outcome: true,
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
    });
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_A,
      signalName: "claude-code-turn",
      quantity: 1,
      usageCost: 8,
      label: "PROJ-101",
      outcome: false,
    });
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_A,
      signalName: "claude-code-turn",
      quantity: 1,
      usageCost: 4,
      label: "PROJ-101",
      outcome: false,
    });

    // Same person, same work item, OTHER assistant: the $3 lands in
    // Ada's PROJ-101 bucket rather than stranding it.
    await mk({
      agentId: codexAgentId,
      customerId,
      developer: DEV_A,
      signalName: "codex-turn",
      quantity: 1,
      usageCost: 3,
      label: "PROJ-101",
      outcome: false,
    });

    // Ada, NO work item: one finished thing, and $5 spent outside a label.
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_A,
      signalName: "Contract drafted",
      quantity: 1,
      usageCost: 0,
      label: null,
      outcome: true,
    });
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_A,
      signalName: "claude-code-turn",
      quantity: 1,
      usageCost: 5,
      label: null,
      outcome: false,
    });

    // Bo, work item PROJ-102: a finished thing and NO spend at all,
    // the dash case.
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_B,
      signalName: "Release cut",
      quantity: 1,
      usageCost: 0,
      label: "PROJ-102",
      outcome: true,
    });

    // A named signal from a non-meter integration: measured count, measured cost.
    await mk({
      agentId: sdkAgentId,
      customerId,
      developer: DEV_B,
      signalName: "Invoice parsed",
      quantity: 4,
      usageCost: 2.5,
      label: null,
      outcome: false,
    });
    await mk({
      agentId: sdkAgentId,
      customerId,
      developer: DEV_B,
      signalName: "invoice parsed",
      quantity: 6,
      usageCost: 3.5,
      label: null,
      outcome: false,
    });

    // A finished thing recorded through the API on the SAME agent the named
    // signals above are metered on: the pair that must not double-count.
    await mk({
      agentId: sdkAgentId,
      customerId,
      developer: DEV_B,
      signalName: "Report shipped",
      quantity: 1,
      usageCost: 0,
      label: null,
      outcome: true,
    });

    // A coding turn the platform routed to a work item BY RULE: no tag in
    // metadata, a resolved matterId on the row.
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_B,
      signalName: "claude-code-turn",
      quantity: 1,
      usageCost: 7,
      label: null,
      matterId: routedMatterId,
      outcome: false,
    });
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_B,
      signalName: "Brief filed",
      quantity: 1,
      usageCost: 0,
      label: null,
      matterId: routedMatterId,
      outcome: true,
    });

    // Noise that must never appear: outside the window, and another org.
    await mk({
      agentId: meterAgentId,
      customerId,
      developer: DEV_A,
      signalName: "Contract summarized",
      quantity: 99,
      usageCost: 0,
      label: "PROJ-101",
      outcome: true,
      usageDate: OUTSIDE_WINDOW,
    });
    await mk({
      org: otherOrgId,
      agentId: otherAgentId,
      customerId: otherCustomerId,
      developer: DEV_A,
      signalName: "Contract summarized",
      quantity: 50,
      usageCost: 0,
      label: "PROJ-101",
      outcome: true,
    });
  }, 180_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.signal_events.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.raw_ingest_events.deleteMany({
      where: { id: { in: rawIds } },
    });
    await prisma.signals.deleteMany({
      where: { orgId: { in: [orgId, otherOrgId] } },
    });
    await prisma.customers.deleteMany({
      where: { organizationId: { in: [orgId, otherOrgId] } },
    });
    await prisma.agents.deleteMany({
      where: { orgId: { in: [orgId, otherOrgId] } },
    });
    await prisma.organizations.deleteMany({
      where: { id: { in: [orgId, otherOrgId] } },
    });
    await prisma.$disconnect();
  }, 180_000);

  const read = () =>
    getCostBreakdown(
      prisma,
      orgId,
      WINDOW,
      "agent",
      {},
      {
        page: 1,
        pageSize: 500,
        includeOtherRollup: false,
        finishedWork: { agentIds: null },
      },
    );

  it("counts finished things in the window and nowhere else", async () => {
    const result = await read();
    // 6 outcome events in the window: 2 Ada/101, 1 Ada/no-label, 1 Bo/102,
    // 1 Bo through the API, 1 Bo on a rule-routed work item.
    expect(result.totals.eventCountFinishedWork).toBe(6);
    // 13 events in the window in total.
    expect(result.totals.eventCount).toBe(13);
  });

  it("puts the same number on the agent row it puts in the totals", async () => {
    const result = await read();
    const meterRow = result.rows.find((row) => row.key === meterAgentId);
    const sdkRow = result.rows.find((row) => row.key === sdkAgentId);
    expect(meterRow?.eventCountFinishedWork).toBe(5);
    expect(sdkRow?.eventCountFinishedWork).toBe(1);
    const summed = result.rows.reduce(
      (total, row) => total + (row.eventCountFinishedWork ?? 0),
      0,
    );
    expect(summed).toBe(result.totals.eventCountFinishedWork);
  });

  it("folds a case twin into one row and shows the casing that came first", async () => {
    const { things } = (await read()).finishedWork!;
    const paper = things.filter(
      (row) => row.name.toLowerCase().trim() === "contract summarized",
    );
    expect(paper).toHaveLength(1);
    expect(paper[0].name).toBe("Contract summarized");
    expect(paper[0].howMany).toBe(4);
    expect(paper[0].eventCount).toBe(2);
  });

  it("sums quantity, not row count: one record can be a count of three", async () => {
    const { things } = (await read()).finishedWork!;
    const total = things.reduce((sum, row) => sum + row.howMany, 0);
    expect(total).toBe(8);
  });

  it("keeps the no-work-item bucket as a real bucket, not a missing value", async () => {
    const { things, buckets } = (await read()).finishedWork!;
    const contract = things.find((row) => row.name === "Contract drafted");
    expect(contract?.label).toBe("");
    const bucket = buckets.find(
      (row) => row.customerExternalId === DEV_A && row.label === "",
    );
    expect(bucket?.cost).toBe(5);
    expect(bucket?.eventCount).toBe(1);
  });

  it("gives a labeled bucket only the spend that carried that label", async () => {
    const { buckets } = (await read()).finishedWork!;
    const slices = buckets.filter(
      (row) => row.customerExternalId === DEV_A && row.label === "PROJ-101",
    );
    // Two assistants, so two slices, because the checkbox row re-scopes this
    // table in memory. The bucket is their sum.
    expect(slices).toHaveLength(2);
    expect(slices.map((row) => row.agentId).sort()).toEqual(
      [meterAgentId, codexAgentId].sort(),
    );
    expect(slices.reduce((sum, row) => sum + row.cost, 0)).toBe(15);
    expect(slices.reduce((sum, row) => sum + row.eventCount, 0)).toBe(3);
  });

  it("puts the other assistant's spend in the same bucket, not in none", async () => {
    const { buckets } = (await read()).finishedWork!;
    const codex = buckets.find(
      (row) =>
        row.customerExternalId === DEV_A &&
        row.label === "PROJ-101" &&
        row.agentId === codexAgentId,
    );
    expect(codex?.cost).toBe(3);
  });

  it("buckets a rule-routed work item, which never carried a tag", async () => {
    const { things, buckets } = (await read()).finishedWork!;
    const brief = things.find((row) => row.name === "Brief filed");
    expect(brief?.label).toBe(routedMatterId);
    const bucket = buckets.find(
      (row) => row.customerExternalId === DEV_B && row.label === routedMatterId,
    );
    expect(bucket?.cost).toBe(7);
    expect(bucket?.eventCount).toBe(1);
  });

  it("keeps a metered named signal out of a bucket on the same agent", async () => {
    const result = await read();
    const { buckets, namedUsage } = result.finishedWork!;
    // The $6 of "Invoice parsed" is measured on its own row. It must not ALSO
    // be split across the finished thing recorded on that same agent, or one
    // table would show the same money twice and read over the Cost tile.
    const reportShipped = buckets.filter(
      (row) => row.customerExternalId === DEV_B && row.label === "",
    );
    expect(reportShipped.every((row) => row.cost === 0)).toBe(true);
    expect(namedUsage.reduce((sum, row) => sum + row.cost, 0)).toBe(6);
    const everything =
      buckets.reduce((sum, row) => sum + row.cost, 0) +
      namedUsage.reduce((sum, row) => sum + row.cost, 0);
    expect(everything).toBeLessThanOrEqual(result.totals.cost);
  });

  it("returns a bucket with things and no spend rather than dropping it", async () => {
    const { buckets } = (await read()).finishedWork!;
    const bucket = buckets.find(
      (row) => row.customerExternalId === DEV_B && row.label === "PROJ-102",
    );
    expect(bucket).toBeDefined();
    expect(bucket?.eventCount).toBe(0);
    expect(bucket?.cost).toBe(0);
  });

  it("never counts a finished thing as spend in its own bucket", async () => {
    const { buckets } = (await read()).finishedWork!;
    for (const bucket of buckets) {
      expect(bucket.cost).not.toBeNaN();
    }
    const total = buckets.reduce((sum, row) => sum + row.cost, 0);
    expect(total).toBe(27);
  });

  it("lists a named signal from an integration that is not the coding meter", async () => {
    const { namedUsage } = (await read()).finishedWork!;
    expect(namedUsage).toHaveLength(1);
    expect(namedUsage[0]).toMatchObject({
      name: "Invoice parsed",
      agentId: sdkAgentId,
      howMany: 10,
      cost: 6,
      eventCount: 2,
      eventCountWithNullCost: 0,
    });
  });

  it("leaves the coding meter's own turns out of the named list", async () => {
    const { namedUsage } = (await read()).finishedWork!;
    expect(
      namedUsage.some((row) => row.name.includes("claude-code-turn")),
    ).toBe(false);
  });

  it("narrows to the agents it was given", async () => {
    const scoped = await getCostBreakdown(
      prisma,
      orgId,
      WINDOW,
      "agent",
      {},
      {
        page: 1,
        pageSize: 500,
        includeOtherRollup: false,
        finishedWork: { agentIds: [sdkAgentId] },
      },
    );
    expect(scoped.finishedWork!.things).toHaveLength(1);
    expect(scoped.finishedWork!.things[0].name).toBe("Report shipped");
    expect(scoped.finishedWork!.namedUsage).toHaveLength(1);
    // The count the Usage events tile subtracts honors the SAME scope, or the
    // tile drops by events the table below shows none of.
    expect(scoped.totals.eventCountFinishedWork).toBe(1);
  });

  it("counts nothing finished when no agent is checked", async () => {
    const none = await getCostBreakdown(
      prisma,
      orgId,
      WINDOW,
      "agent",
      {},
      {
        page: 1,
        pageSize: 500,
        includeOtherRollup: false,
        finishedWork: { agentIds: [] },
      },
    );
    expect(none.finishedWork).toEqual({
      things: [],
      buckets: [],
      namedUsage: [],
    });
    expect(none.totals.eventCountFinishedWork).toBe(0);
  });

  it("changes nothing for a caller that did not ask", async () => {
    const plain = await getCostBreakdown(
      prisma,
      orgId,
      WINDOW,
      "agent",
      {},
      {
        page: 1,
        pageSize: 500,
        includeOtherRollup: false,
      },
    );
    expect("finishedWork" in plain).toBe(false);
    expect("eventCountFinishedWork" in plain.totals).toBe(false);
    for (const row of plain.rows) {
      expect("eventCountFinishedWork" in row).toBe(false);
    }
    const asked = await read();
    expect(plain.totals.cost).toBe(asked.totals.cost);
    expect(plain.totals.eventCount).toBe(asked.totals.eventCount);
  });

  it("runs the marker off the child index rather than a sequential scan", async () => {
    const plan = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM signal_event_services ses
         WHERE ses."signalEventId" = e.id AND lower(ses."modelProvider") = 'outcome'
       ))
       FROM signal_events e
       WHERE e."organizationId" = '${orgId}'::uuid
         AND e."usageDate" >= '${WINDOW.start.toISOString()}'::timestamptz
         AND e."usageDate" <= '${WINDOW.end.toISOString()}'::timestamptz`,
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    // eslint-disable-next-line no-console -- prints test diagnostics for the reader
    console.log("EXPLAIN (outcome marker):\n" + text);
    expect(text).toContain("idx_signal_event_services_event");
  });
});
