/**
 * revenue-metrics on RATED credit pools. Runs under tsx
 * in <1s against an in-memory Prisma stub (packages/db src test convention —
 * standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/revenue-metrics-credit-pool.test.ts
 *
 * WHAT THESE PIN: revenue analytics count a pool's member-signal usage at its
 * burn rate, matching the invoice. Member signals (creditRates keys) carry no
 * strategy rows, so a read that takes only the pool's OWN signal's raw units
 * counts their events as NOTHING and applies no rate, and MRR and every
 * revenue tile would disagree with the invoice the customer receives.
 *
 * WHAT THEY PROVE vs WHAT THEY DON'T: the stub models the two queries these
 * functions issue (subscriptions.findMany, signal_events.findMany) and
 * applies their where-clauses for real, so an implementation that stops
 * asking for member events, or asks with the wrong window, goes red rather
 * than passing on a stub that returns everything. It does NOT prove Prisma
 * itself, the schema, or that creditRates is selected by the real client —
 * `npm run build` (tsc against the generated client) is what proves the
 * select compiles.
 *
 * Covered:
 *   1. Rated agreement with the invoice: getRevenueMetrics' pool quantity ===
 *      the invoice-calculator selection recipe, replicated independently
 *      here, on the 14-credit fixture (2 × rate 4 + 3 × rate 2) — with both
 *      wrong answers (2 = unrated own signal, 8 = own signal rated, member
 *      dropped) named and excluded.
 *   2. Credits-denominated overage: 1,300 credits against a 1,000 pool bills
 *      $99 + 300 × $0.03, which a units-only reader never reaches.
 *   3. UNRATED PIN (the negative control): a creditRates-null pool's ENTIRE
 *      RevenueMetrics object, deep-equal to one hardcoded literal: unrated
 *      arithmetic, byte-identical, no rated path in sight.
 *   4. Non-members and sibling strategies: a non-member signal's events never
 *      inflate the pool, and a flat usage strategy on the same subscription
 *      keeps reading its own raw units.
 *   5. getAgentEarned reads the same rated quantity (it is a slice over
 *      getRevenueMetrics, not a second quantity read), pinned so a divergence
 *      shows.
 *   6. getRunRateMrr (MRR2) projects the same rated credits.
 */

import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";

import {
  getAgentEarned,
  getRevenueMetrics,
  getRunRateMrr,
} from "./revenue-metrics";
import { memberRate } from "./credit-ledger";
import { calcCreditPool, type CalcStrategy } from "./revenue-calc";

// ── fixture ─────────────────────────────────────────────────────────────────

const ORG = "org-1";
const PLAN = "plan-1";
const SUB = "sub-1";
const CUSTOMER = "cust-1";
const AGENT = "agent-1";

const SIGNAL_A = "signal-a"; // the pool's own signal
const SIGNAL_B = "signal-b"; // a member, creditRates only
const SIGNAL_C = "signal-c"; // never a member

/** Pool of 1,000 credits for $99, overage $0.03/credit. */
const POOL_TIERS = [
  { lower: 0, upper: 1000, rate: 99 },
  { lower: 1000, upper: null, rate: 0.03 },
];

const WINDOW = {
  start: new Date("2026-06-15T00:00:00.000Z"),
  end: new Date("2026-07-15T00:00:00.000Z"),
};
const IN_WINDOW = new Date("2026-06-20T00:00:00.000Z");

interface StubStrategy {
  id: string;
  chargeType: string;
  pricingModel: string | null;
  rate: number | null;
  tiers: unknown;
  minimumCommitment: number | null;
  signalId: string | null;
  creditRates?: unknown;
}

interface StubEvent {
  subscriptionId: string | null;
  organizationId: string;
  signalId: string | null;
  quantity: number;
  usageCost: number | null;
  usageDate: Date;
}

function poolStrategy(creditRates: unknown): StubStrategy {
  return {
    id: "strat-pool",
    chargeType: "usage",
    pricingModel: "credit_pool",
    rate: null,
    tiers: POOL_TIERS,
    minimumCommitment: null,
    signalId: SIGNAL_A,
    creditRates,
  };
}

function event(signalId: string, quantity: number): StubEvent {
  return {
    subscriptionId: SUB,
    organizationId: ORG,
    signalId,
    quantity,
    usageCost: null,
    usageDate: IN_WINDOW,
  };
}

/**
 * The two queries revenue-metrics issues, with their where-clauses actually
 * applied. Deliberately NOT a permissive mock: the events filter honors
 * organizationId, the subscriptionId list, the inclusive usageDate window and
 * the optional signalId narrowing, so a call that forgets a member signal or
 * widens the window fails here instead of being absorbed.
 */
function buildStub(opts: {
  strategies: StubStrategy[];
  events: StubEvent[];
  subStatus?: string;
}): PrismaClient {
  const sub = {
    id: SUB,
    customerId: CUSTOMER,
    agentId: AGENT,
    planId: PLAN,
    status: opts.subStatus ?? "active",
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: null,
    billingCycle: "monthly",
    customCycleDays: null,
    seatsCount: 0,
    pricing_plans: { pricing_strategies: opts.strategies },
  };

  return {
    subscriptions: {
      findMany: async ({ where }: any) => {
        if (where?.customers?.organizationId !== ORG) return [];
        if (where?.id && where.id !== SUB) return [];
        if (where?.customerId && where.customerId !== CUSTOMER) return [];
        if (where?.status?.in && !where.status.in.includes(sub.status))
          return [];
        return [sub];
      },
    },
    signal_events: {
      findMany: async ({ where }: any) => {
        const subIds: string[] = where?.subscriptionId?.in ?? [];
        return opts.events.filter(
          (e) =>
            e.organizationId === where.organizationId &&
            (e.subscriptionId ? subIds.includes(e.subscriptionId) : false) &&
            e.usageDate >= where.usageDate.gte &&
            e.usageDate <= where.usageDate.lte &&
            (where.signalId === undefined || e.signalId === where.signalId),
        );
      },
    },
  } as unknown as PrismaClient;
}

/**
 * The invoice-calculator selection recipe, replicated by hand from
 * invoice-calculator.service.ts (pooledCreditQuantity): per pool member
 * signal, SUM(quantity) over the window × its burn rate, summed. Sum FIRST,
 * then one multiply per signal.
 *
 * Hand-written on purpose — an oracle that called the helper under test would
 * prove only that the helper equals itself.
 */
function invoiceSelectedCreditQuantity(
  strategy: { signalId: string | null; creditRates?: unknown },
  events: StubEvent[],
): number {
  const candidates = new Set<string>();
  if (strategy.signalId) candidates.add(strategy.signalId);
  const rates = strategy.creditRates;
  if (rates && typeof rates === "object" && !Array.isArray(rates)) {
    for (const key of Object.keys(rates)) candidates.add(key);
  }
  let credits = 0;
  for (const memberSignalId of candidates) {
    const rate = memberRate(strategy, memberSignalId);
    if (rate === null) continue;
    const quantity = events
      .filter(
        (e) =>
          e.signalId === memberSignalId &&
          e.usageDate >= WINDOW.start &&
          e.usageDate <= WINDOW.end,
      )
      .reduce((sum, e) => sum + e.quantity, 0);
    credits += quantity * rate;
  }
  return credits;
}

function poolCalcStrategy(strategy: StubStrategy): CalcStrategy {
  return {
    id: strategy.id,
    chargeType: "usage",
    pricingModel: "credit_pool",
    rate: strategy.rate,
    tiers: POOL_TIERS as CalcStrategy["tiers"],
    minimumCommitment: null,
    signalId: strategy.signalId,
  };
}

const poolLine = (metrics: { byStrategy: Array<{ strategyId: string }> }) =>
  metrics.byStrategy.find((s) => s.strategyId === "strat-pool")!;

// ── tests ───────────────────────────────────────────────────────────────────

async function main() {
  // ─── 1. rated agreement with the invoice ─────────────────────────────────
  {
    const strategy = poolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 });
    const events = [event(SIGNAL_A, 2), event(SIGNAL_B, 3)];
    const metrics = await getRevenueMetrics(
      buildStub({ strategies: [strategy], events }),
      ORG,
      WINDOW,
    );

    const oracle = invoiceSelectedCreditQuantity(strategy, events);
    assert.equal(oracle, 14, "the hand pin: 2 × 4 + 3 × 2");
    assert.equal(
      poolLine(metrics).quantity,
      oracle,
      "analytics selects the credits the invoice bills",
    );
    // The two wrong answers, named so a wrong result can't hide behind a
    // plausible number: 2 is the unrated own-signal read (no rate at all),
    // 8 is the own signal rated with the member's 6 credits dropped.
    assert.notEqual(poolLine(metrics).quantity, 2);
    assert.notEqual(poolLine(metrics).quantity, 8);

    assert.equal(
      metrics.usageRevenue,
      calcCreditPool(poolCalcStrategy(strategy), oracle),
      "revenue is the pool's own math on the rated quantity",
    );
    assert.equal(metrics.usageRevenue, 99, "14 credits sit inside the pool");
    assert.equal(metrics.eventCount, 2);
    assert.equal(
      metrics.byStrategy.length,
      1,
      "members never grow strategy rows of their own",
    );
  }

  // ─── 2. overage is denominated in credits ────────────────────────────────
  {
    const strategy = poolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 });
    // 200 × 4 + 250 × 2 = 1,300 credits: 300 past a 1,000 pool. Neither raw
    // count (200, 250, or 450) reaches the pool boundary at all, so a
    // units-only reader reports $99 and the customer's bill says $108.
    const events = [event(SIGNAL_A, 200), event(SIGNAL_B, 250)];
    const metrics = await getRevenueMetrics(
      buildStub({ strategies: [strategy], events }),
      ORG,
      WINDOW,
    );

    assert.equal(poolLine(metrics).quantity, 1300);
    assert.equal(metrics.usageRevenue, 99 + 300 * 0.03);
    assert.notEqual(metrics.usageRevenue, 99);
  }

  // ─── 3. UNRATED PIN: rate-less pools are byte-identical to unrated ───────
  // The whole RevenueMetrics object against one hardcoded literal. Nothing
  // here is re-derived from the code under test.
  {
    const LEGACY_PIN = {
      revenue: 106.5,
      cost: 0,
      margin: 106.5,
      marginPercent: 100,
      usageRevenue: 106.5,
      recurringRevenue: 0,
      seatRevenue: 0,
      onetimeRevenue: 0,
      eventCount: 1,
      eventCountWithNullCost: 1,
      bySubscription: [
        {
          subscriptionId: SUB,
          customerId: CUSTOMER,
          agentId: AGENT,
          planId: PLAN,
          revenue: 106.5,
          cost: 0,
          margin: 106.5,
          usageRevenue: 106.5,
          recurringRevenue: 0,
          seatRevenue: 0,
          onetimeRevenue: 0,
          eventCount: 1,
        },
      ],
      byStrategy: [
        {
          strategyId: "strat-pool",
          chargeType: "usage",
          pricingModel: "credit_pool",
          signalId: SIGNAL_A,
          revenue: 106.5,
          quantity: 1250,
        },
      ],
    };

    for (const rateless of [null, undefined, {}]) {
      const strategy = poolStrategy(rateless);
      const metrics = await getRevenueMetrics(
        buildStub({ strategies: [strategy], events: [event(SIGNAL_A, 1250)] }),
        ORG,
        WINDOW,
      );
      assert.deepEqual(
        metrics,
        LEGACY_PIN,
        `rate-less pool (creditRates ${JSON.stringify(rateless)}) matches the unrated pin`,
      );
    }

    // Degenerate creditRates JSON reads as NO rate stored, never a fabricated
    // one — the pool falls back to its own signal at rate 1, same literal.
    for (const rotten of [
      { [SIGNAL_A]: "four" },
      { [SIGNAL_A]: 0 },
      { [SIGNAL_A]: -4 },
      { [SIGNAL_B]: null },
      [4, 2],
      "not-json-object",
    ]) {
      const metrics = await getRevenueMetrics(
        buildStub({
          strategies: [poolStrategy(rotten)],
          events: [event(SIGNAL_A, 1250)],
        }),
        ORG,
        WINDOW,
      );
      assert.deepEqual(
        metrics,
        LEGACY_PIN,
        `degenerate creditRates ${JSON.stringify(rotten)} never fabricates a rate`,
      );
    }
  }

  // ─── 4. non-members, and the untouched non-pool branch ───────────────────
  {
    const pool = poolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 });
    const flat: StubStrategy = {
      id: "strat-flat",
      chargeType: "usage",
      pricingModel: "flat",
      rate: 0.5,
      tiers: [],
      minimumCommitment: null,
      signalId: SIGNAL_C,
    };
    const metrics = await getRevenueMetrics(
      buildStub({
        strategies: [pool, flat],
        events: [event(SIGNAL_A, 2), event(SIGNAL_B, 3), event(SIGNAL_C, 10)],
      }),
      ORG,
      WINDOW,
    );

    assert.equal(
      poolLine(metrics).quantity,
      14,
      "SIGNAL_C is billed by its own strategy, never drawn into the pool",
    );
    const flatLine = metrics.byStrategy.find(
      (s) => s.strategyId === "strat-flat",
    )!;
    assert.equal(
      flatLine.quantity,
      10,
      "a flat strategy still reads raw units",
    );
    assert.equal(flatLine.revenue, 5);
    assert.equal(metrics.usageRevenue, 99 + 5);
  }

  // ─── 5. getAgentEarned inherits, it does not re-read ─────────────────────
  {
    const strategy = poolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 });
    const db = buildStub({
      strategies: [strategy],
      events: [event(SIGNAL_A, 2), event(SIGNAL_B, 3)],
    });
    const earned = await getAgentEarned(db, ORG, WINDOW);
    const metrics = await getRevenueMetrics(db, ORG, WINDOW);

    assert.equal(earned.byStrategy.length, 1);
    assert.equal(earned.byStrategy[0].quantity, 14);
    assert.equal(
      earned.revenue,
      metrics.usageRevenue,
      "Earned is a slice over getRevenueMetrics, never a second quantity read",
    );
  }

  // ─── 6. Run-Rate MRR projects the rated credits too ──────────────────────
  {
    const NOW = new Date("2026-07-01T00:00:00.000Z");
    const recent = (signalId: string, quantity: number): StubEvent => ({
      ...event(signalId, quantity),
      usageDate: new Date("2026-06-25T00:00:00.000Z"),
    });

    const rated = await getRunRateMrr(
      buildStub({
        strategies: [poolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 })],
        events: [recent(SIGNAL_A, 200), recent(SIGNAL_B, 250)],
      }),
      ORG,
      {},
      NOW,
    );
    assert.equal(
      rated.mrr,
      99 + 300 * 0.03,
      "MRR2 runs the 1,300-credit overage, not 450 raw units",
    );

    const legacy = await getRunRateMrr(
      buildStub({
        strategies: [poolStrategy(null)],
        events: [recent(SIGNAL_A, 1250)],
      }),
      ORG,
      {},
      NOW,
    );
    assert.equal(
      legacy.mrr,
      99 + 250 * 0.03,
      "a rate-less pool's run-rate is the unrated one",
    );
  }

  console.log("revenue-metrics-credit-pool.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
