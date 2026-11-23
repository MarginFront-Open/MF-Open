/**
 * credit-balance: the ONE credit-pool read path. Runs under
 * tsx in <1s against an in-memory client stub (packages/db src test
 * convention — standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/credit-balance.test.ts
 *
 * WHAT THESE PROVE vs WHAT THEY DON'T: the stub models the Prisma query
 * semantics this module builds (org/customer/agent/id filters, the
 * credit-pool strategy filter set, drawable-grant windows, and the ledger
 * aggregate's createdAt range) and nothing else. Real Postgres decimal
 * behavior and real concurrency need a live database, not this stub.
 *
 * Covered, each with failure-capable assertions:
 *   1.  THE BINDING DIVERGENCE: a top-up raises remainingUnits
 *       and leaves overageInProgressUnits exactly where it was, because the
 *       overage number is the invoice's own math. NEGATIVE CONTROL replays the
 *       top-up-aware overage the split forbids and shows it disagrees with
 *       what the invoice will bill.
 *   2.  Active period with no minted grant = a FULL untouched pool, never an
 *       exhausted one.
 *   3.  Parity with computeBalance (credit-ledger.ts) on the same fixture —
 *       the in-memory recompute and the ledger's own recompute must agree, so
 *       a change to one that isn't mirrored in the other goes red here.
 *   4.  belowPercent selects near-empty and exhausted pools; a healthy pool
 *       is excluded.
 *   5.  customerId / agentId / subscriptionId filters.
 *   6.  Expired grants are excluded from remainingUnits; a never-expiring
 *       top-up remainder survives the period rollover.
 *   7.  A subscription with no credit-pool strategy is ABSENT, never
 *       zero-filled.
 *   8.  A subscription with no billing period reads FULL and untouched, and is
 *       never selected as running low.
 *   9.  The rollover window (period ended, dispatch has not re-minted yet): a
 *       healthy pool must not flash exhausted.
 *   10. Invoice parity across the four modes where a createdAt-windowed ledger
 *       read would diverge from the bill, plus org / subscription / signal / window
 *       scoping negative controls.
 *   11. Rated pools: consumedUnits is the rated credit sum (per
 *       member signal SUM(quantity) × rate — the invoice recipe), overage is
 *       credits past the pool, non-members never count, and the wire shape
 *       matches a rate-less pool's (pinned key set). Sections 1-10 run on
 *       rate-less pools and are the negative control that the raw-unit read is
 *       untouched.
 */

import assert from "node:assert/strict";

import {
  getCreditBalance,
  getCreditBalances,
  type CreditBalanceQueryClient,
} from "./credit-balance";
import { computeBalance, type CreditLedgerTxClient } from "./credit-ledger";

const ORG = "org-uuid";
const OTHER_ORG = "other-org-uuid";
const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-01T00:00:00.000Z");
const NOW = new Date("2026-07-15T12:00:00.000Z");
const PRIOR_PERIOD_START = new Date("2026-06-01T00:00:00.000Z");

interface StubSubscription {
  id: string;
  name: string;
  organizationId: string;
  customerId: string;
  agentId: string;
  planId: string;
  currentBillingPeriodStart: Date | null;
  currentBillingPeriodEnd: Date | null;
  creditAlertsPaused: boolean;
  deletedAt: Date | null;
  customerName: string | null;
  customerExternalId: string | null;
  planName: string | null;
}

interface StubStrategy {
  planId: string;
  pricingModel: string;
  chargeType: string;
  active: boolean;
  deletedAt: Date | null;
  signalId: string | null;
  tiers: unknown;
  creditRates?: unknown;
  createdAt: Date;
}

interface StubGrant {
  subscriptionId: string;
  amountUnits: number;
  consumedUnits: number;
  periodStart: Date | null;
  effectiveAt: Date;
  expiresAt: Date | null;
}

/** A signal_events row, the invoice's own source for period quantity. */
interface StubEvent {
  organizationId: string;
  subscriptionId: string;
  signalId: string;
  quantity: number;
  usageDate: Date;
}

interface Fixture {
  subscriptions: StubSubscription[];
  strategies: StubStrategy[];
  grants: StubGrant[];
  events: StubEvent[];
}

function poolTiers(poolSize: number, poolPrice: number, overageRate: number) {
  return [
    { lower: 0, upper: poolSize, rate: poolPrice },
    { lower: poolSize, upper: null, rate: overageRate },
  ];
}

function subscription(over: Partial<StubSubscription> = {}): StubSubscription {
  return {
    id: "sub-1",
    name: "Acme pooled plan",
    organizationId: ORG,
    customerId: "cust-1",
    agentId: "agent-1",
    planId: "plan-1",
    currentBillingPeriodStart: PERIOD_START,
    currentBillingPeriodEnd: PERIOD_END,
    creditAlertsPaused: false,
    deletedAt: null,
    customerName: "Acme",
    customerExternalId: "acme-ext",
    planName: "Pooled",
    ...over,
  };
}

function strategy(over: Partial<StubStrategy> = {}): StubStrategy {
  return {
    planId: "plan-1",
    pricingModel: "credit_pool",
    chargeType: "usage",
    active: true,
    deletedAt: null,
    signalId: "signal-1",
    tiers: poolTiers(5000, 99, 0.03),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

/**
 * A stub honoring exactly the where-fragments credit-balance.ts builds. Any
 * fragment it does NOT model is asserted absent rather than silently ignored,
 * so a query the module grows without a matching stub branch fails loudly.
 */
function buildStub(fx: Fixture): CreditBalanceQueryClient {
  return {
    subscriptions: {
      findMany: (args?: unknown) => {
        const where = (args as { where: any }).where;
        const rows = fx.subscriptions.filter((s) => {
          if (where.organizationId !== s.organizationId) return false;
          if (where.deletedAt === null && s.deletedAt !== null) return false;
          if (where.id !== undefined && where.id !== s.id) return false;
          if (
            where.customerId !== undefined &&
            where.customerId !== s.customerId
          )
            return false;
          if (where.agentId !== undefined && where.agentId !== s.agentId)
            return false;
          return true;
        });
        return Promise.resolve(
          rows.map((s) => ({
            id: s.id,
            name: s.name,
            customerId: s.customerId,
            agentId: s.agentId,
            planId: s.planId,
            currentBillingPeriodStart: s.currentBillingPeriodStart,
            currentBillingPeriodEnd: s.currentBillingPeriodEnd,
            creditAlertsPaused: s.creditAlertsPaused,
            customers: {
              name: s.customerName,
              externalId: s.customerExternalId,
            },
            pricing_plans: { name: s.planName },
          })),
        );
      },
    },
    pricing_strategies: {
      findMany: (args?: unknown) => {
        const where = (args as { where: any }).where;
        const rows = fx.strategies
          .filter((s) => {
            if (!where.planId.in.includes(s.planId)) return false;
            if (where.pricingModel !== s.pricingModel) return false;
            if (where.chargeType !== s.chargeType) return false;
            if (where.active !== s.active) return false;
            if (where.deletedAt === null && s.deletedAt !== null) return false;
            if (where.signalId?.not === null && s.signalId === null)
              return false;
            return true;
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return Promise.resolve(
          rows.map((s) => ({
            planId: s.planId,
            signalId: s.signalId,
            tiers: s.tiers,
            creditRates: s.creditRates ?? null,
          })),
        );
      },
    },
    credit_grants: {
      findMany: (args?: unknown) => {
        const where = (args as { where: any }).where;
        return Promise.resolve(
          fx.grants.filter((g) =>
            where.subscriptionId.in.includes(g.subscriptionId),
          ),
        );
      },
    },
    signal_events: {
      // The invoice-calculator selection recipe, verbatim: org + subscription
      // + signalId + usageDate window (BOTH bounds inclusive), SUM(quantity).
      // Called once per pool member signal. Kept identical to
      // the parity oracle invoiceSelectedCreditQuantity in
      // credit-ledger.test.ts.
      aggregate: (args?: unknown) => {
        const where = (args as { where: any }).where;
        const hits = fx.events.filter(
          (e) =>
            e.organizationId === where.organizationId &&
            e.subscriptionId === where.subscriptionId &&
            e.signalId === where.signalId &&
            e.usageDate >= where.usageDate.gte &&
            e.usageDate <= where.usageDate.lte,
        );
        return Promise.resolve({
          _sum: {
            quantity:
              hits.length === 0
                ? null
                : hits.reduce((sum, e) => sum + e.quantity, 0),
          },
        });
      },
    },
  };
}

/** The credit-ledger-shaped view of the same grants, for the parity check. */
function ledgerStub(fx: Fixture): CreditLedgerTxClient {
  return {
    credit_grants: {
      findMany: (args?: unknown) => {
        const where = (args as { where: any }).where;
        return Promise.resolve(
          fx.grants.filter(
            (g) =>
              g.subscriptionId === where.subscriptionId &&
              g.effectiveAt <= where.effectiveAt.lte &&
              (g.expiresAt === null || g.expiresAt > where.OR[1].expiresAt.gt),
          ),
        );
      },
    },
  } as unknown as CreditLedgerTxClient;
}

function grantFor(subscriptionId: string, consumed: number): StubGrant {
  return {
    subscriptionId,
    amountUnits: 5000,
    consumedUnits: consumed,
    periodStart: PERIOD_START,
    effectiveAt: PERIOD_START,
    expiresAt: PERIOD_END,
  };
}

function eventFor(subscriptionId: string, units: number): StubEvent {
  return {
    organizationId: ORG,
    subscriptionId,
    signalId: "signal-1",
    quantity: units,
    usageDate: new Date("2026-07-10T00:00:00.000Z"),
  };
}

const MIXED: Fixture = {
  subscriptions: [
    subscription({ id: "healthy", customerId: "cust-a", agentId: "agent-a" }),
    subscription({
      id: "near-empty",
      customerId: "cust-b",
      agentId: "agent-b",
    }),
    subscription({ id: "exhausted", customerId: "cust-c", agentId: "agent-c" }),
    subscription({
      id: "paused",
      customerId: "cust-d",
      agentId: "agent-d",
      creditAlertsPaused: true,
    }),
  ],
  strategies: [strategy()],
  grants: [
    grantFor("healthy", 1000),
    grantFor("near-empty", 4900), // 100 left = 2%
    grantFor("exhausted", 5200), // -200 left
    grantFor("paused", 5000), // exactly 0 left
  ],
  events: [
    eventFor("healthy", 1000),
    eventFor("near-empty", 4900),
    eventFor("exhausted", 5200),
    eventFor("paused", 5000),
  ],
};

async function main() {
  // ── 1. THE BINDING DIVERGENCE ───────────────────────────────────────────────

  const OVERDRAWN: Fixture = {
    subscriptions: [subscription()],
    strategies: [strategy()],
    grants: [
      {
        subscriptionId: "sub-1",
        amountUnits: 5000,
        consumedUnits: 5300,
        periodStart: PERIOD_START,
        effectiveAt: PERIOD_START,
        expiresAt: PERIOD_END,
      },
    ],
    events: [
      {
        organizationId: ORG,
        subscriptionId: "sub-1",
        signalId: "signal-1",
        quantity: 5300,
        usageDate: new Date("2026-07-10T00:00:00.000Z"),
      },
    ],
  };

  const TOPPED_UP: Fixture = {
    ...OVERDRAWN,
    grants: [
      {
        subscriptionId: "sub-1",
        amountUnits: 5000,
        consumedUnits: 5000,
        periodStart: PERIOD_START,
        effectiveAt: PERIOD_START,
        expiresAt: PERIOD_END,
      },
      // The manual top-up: periodStart null (unique-safe beside the period
      // grant), expiresAt null (top-ups never expire). Draw order is
      // expiry-soonest-first, so it absorbed the 300 units past the pool.
      {
        subscriptionId: "sub-1",
        amountUnits: 1500,
        consumedUnits: 300,
        periodStart: null,
        effectiveAt: new Date("2026-07-11T00:00:00.000Z"),
        expiresAt: null,
      },
    ],
  };

  const before = await getCreditBalance(
    buildStub(OVERDRAWN),
    ORG,
    "sub-1",
    NOW,
  );
  assert.ok(before, "the overdrawn pool must produce a row");
  assert.equal(before.poolSizeUnits, 5000);
  assert.equal(before.consumedUnits, 5300);
  assert.equal(before.remainingUnits, -300, "overdrawn pools read negative");
  assert.equal(before.overageInProgressUnits, 300);

  const after = await getCreditBalance(buildStub(TOPPED_UP), ORG, "sub-1", NOW);
  assert.ok(after, "the topped-up pool must produce a row");
  assert.equal(
    after.remainingUnits,
    1200,
    "remainingUnits is top-up AWARE: 5000 + 1500 - 5300",
  );
  assert.equal(
    after.overageInProgressUnits,
    300,
    "overageInProgressUnits is top-up BLIND: the top-up must NOT erase it",
  );
  assert.equal(
    after.consumedUnits,
    5300,
    "period consumption is unchanged by a top-up",
  );
  // Both numbers true at once — the sentence every surface has to be able to say.
  assert.ok(after.remainingUnits > 0 && after.overageInProgressUnits > 0);

  // NEGATIVE CONTROL: the top-up-aware overage the split forbids. It reads 0,
  // which contradicts the 300 units calcCreditPool will bill at period close.
  const topUpAwareOverage = Math.max(0, -after.remainingUnits);
  assert.equal(topUpAwareOverage, 0);
  assert.notEqual(
    topUpAwareOverage,
    after.overageInProgressUnits,
    "the forbidden math and the invoice math must visibly disagree here",
  );

  // ── 2. Active period, no minted grant = a FULL untouched pool ───────────────

  const NO_GRANT: Fixture = {
    subscriptions: [subscription()],
    strategies: [strategy()],
    grants: [],
    events: [],
  };

  const untouched = await getCreditBalance(
    buildStub(NO_GRANT),
    ORG,
    "sub-1",
    NOW,
  );
  assert.ok(untouched);
  assert.equal(untouched.remainingUnits, 5000, "no grant yet reads as FULL");
  assert.equal(untouched.implicitFullPool, true);
  assert.equal(untouched.consumedUnits, 0);
  assert.equal(untouched.overageInProgressUnits, 0);
  assert.equal(untouched.remainingPercent, 100);
  assert.ok(
    untouched.remainingUnits > 0,
    "a mint gap must never read as an exhausted pool",
  );

  // ── 3. Parity with computeBalance ───────────────────────────────────────────

  for (const [label, fx] of [
    ["overdrawn", OVERDRAWN],
    ["topped up", TOPPED_UP],
    ["no grant yet", NO_GRANT],
  ] as const) {
    const row = await getCreditBalance(buildStub(fx), ORG, "sub-1", NOW);
    const ledger = await computeBalance(ledgerStub(fx), {
      subscriptionId: "sub-1",
      at: NOW,
      subscription: {
        id: "sub-1",
        organizationId: ORG,
        planId: "plan-1",
        currentBillingPeriodStart: PERIOD_START,
        currentBillingPeriodEnd: PERIOD_END,
      },
      strategy: {
        id: "strat-1",
        signalId: "signal-1",
        tiers: poolTiers(5000, 99, 0.03),
      },
    });
    assert.equal(
      row?.remainingUnits,
      ledger.balanceUnits,
      `remainingUnits must equal computeBalance (${label})`,
    );
    assert.equal(
      row?.implicitFullPool,
      ledger.implicitFullPool,
      `implicitFullPool must equal computeBalance (${label})`,
    );
  }

  // ── 4. belowPercent selection ───────────────────────────────────────────────

  const all = await getCreditBalances(buildStub(MIXED), ORG, {}, NOW);
  assert.equal(all.length, 4);
  assert.deepEqual(
    all.map((r) => r.subscriptionId),
    ["exhausted", "paused", "near-empty", "healthy"],
    "emptiest first",
  );

  const needsAttention = await getCreditBalances(
    buildStub(MIXED),
    ORG,
    { belowPercent: 20 },
    NOW,
  );
  assert.deepEqual(
    needsAttention.map((r) => r.subscriptionId).sort(),
    ["exhausted", "near-empty", "paused"],
    "under 20% left, exhausted included, paused still LISTED",
  );
  assert.equal(
    needsAttention.find((r) => r.subscriptionId === "paused")?.alertsPaused,
    true,
    "paused rows are listed and labeled, never hidden",
  );

  const exhaustedOnly = await getCreditBalances(
    buildStub(MIXED),
    ORG,
    { belowPercent: 0 },
    NOW,
  );
  assert.deepEqual(
    exhaustedOnly.map((r) => r.subscriptionId).sort(),
    ["exhausted", "paused"],
    "belowPercent 0 = remaining at or under zero",
  );

  // ── 5. customer / agent / subscription filters + org scoping ────────────────

  const byCustomer = await getCreditBalances(
    buildStub(MIXED),
    ORG,
    { customerId: "cust-b" },
    NOW,
  );
  assert.deepEqual(
    byCustomer.map((r) => r.subscriptionId),
    ["near-empty"],
  );

  const byAgent = await getCreditBalances(
    buildStub(MIXED),
    ORG,
    { agentId: "agent-c" },
    NOW,
  );
  assert.deepEqual(
    byAgent.map((r) => r.subscriptionId),
    ["exhausted"],
  );

  const foreign = await getCreditBalances(buildStub(MIXED), OTHER_ORG, {}, NOW);
  assert.deepEqual(foreign, [], "another org's pools are never returned");

  // ── 6. Expiry: period grants expire, top-ups survive the rollover ───────────

  const AFTER_ROLLOVER: Fixture = {
    subscriptions: [subscription()],
    strategies: [strategy()],
    grants: [
      // last period's grant, fully drawn and now expired
      {
        subscriptionId: "sub-1",
        amountUnits: 5000,
        consumedUnits: 5000,
        periodStart: PRIOR_PERIOD_START,
        effectiveAt: PRIOR_PERIOD_START,
        expiresAt: PERIOD_START,
      },
      // this period's fresh grant
      {
        subscriptionId: "sub-1",
        amountUnits: 5000,
        consumedUnits: 0,
        periodStart: PERIOD_START,
        effectiveAt: PERIOD_START,
        expiresAt: PERIOD_END,
      },
      // the top-up remainder from last period — never expires, still drawable
      {
        subscriptionId: "sub-1",
        amountUnits: 1500,
        consumedUnits: 300,
        periodStart: null,
        effectiveAt: new Date("2026-06-11T00:00:00.000Z"),
        expiresAt: null,
      },
    ],
    // Last period's usage, dated inside the PRIOR window. The invoice bills it
    // to that period, so this period must read zero used.
    events: [
      {
        organizationId: ORG,
        subscriptionId: "sub-1",
        signalId: "signal-1",
        quantity: 5300,
        usageDate: new Date("2026-06-10T00:00:00.000Z"),
      },
    ],
  };

  const rolled = await getCreditBalance(
    buildStub(AFTER_ROLLOVER),
    ORG,
    "sub-1",
    NOW,
  );
  assert.ok(rolled);
  assert.equal(
    rolled.remainingUnits,
    6200,
    "expired grant excluded; the 1,200-unit top-up remainder survives the rollover",
  );
  assert.equal(
    rolled.consumedUnits,
    0,
    "last period's draws must NOT count against this period",
  );
  assert.equal(rolled.overageInProgressUnits, 0);

  // ── 7. A subscription with no credit pool is ABSENT ─────────────────────────

  const NO_POOL: Fixture = {
    subscriptions: [subscription({ id: "flat", planId: "plan-flat" })],
    strategies: [strategy({ planId: "plan-1" })],
    grants: [],
    events: [],
  };
  assert.deepEqual(
    await getCreditBalances(buildStub(NO_POOL), ORG, {}, NOW),
    [],
    "a plan with no credit pool has no pool number, not a zero one",
  );
  assert.equal(
    await getCreditBalance(buildStub(NO_POOL), ORG, "flat", NOW),
    null,
  );

  // ── 8. noActivePeriod + honest pass-through fields ──────────────────────────

  const NO_PERIOD: Fixture = {
    subscriptions: [
      subscription({
        currentBillingPeriodStart: null,
        currentBillingPeriodEnd: null,
        creditAlertsPaused: true,
      }),
    ],
    strategies: [strategy()],
    grants: [],
    events: [],
  };

  const noPeriod = await getCreditBalance(
    buildStub(NO_PERIOD),
    ORG,
    "sub-1",
    NOW,
  );
  assert.ok(noPeriod);
  assert.equal(noPeriod.noActivePeriod, true);
  assert.equal(noPeriod.periodStart, null);
  assert.equal(noPeriod.periodEnd, null);
  assert.equal(noPeriod.consumedUnits, 0);
  assert.equal(
    noPeriod.remainingUnits,
    5000,
    "an SDK auto-created pool is UNTOUCHED, never exhausted",
  );
  assert.equal(noPeriod.implicitFullPool, true);
  assert.equal(noPeriod.remainingPercent, 100);
  assert.equal(noPeriod.overageInProgressUnits, 0);
  assert.equal(noPeriod.alertsPaused, true);
  assert.equal(noPeriod.overageRatePerUnit, 0.03);
  assert.equal(noPeriod.customerName, "Acme");
  assert.equal(noPeriod.planName, "Pooled");

  // It must also never be SELECTED as running low: nothing is drawing it down.
  assert.deepEqual(
    await getCreditBalances(
      buildStub(NO_PERIOD),
      ORG,
      { belowPercent: 20 },
      NOW,
    ),
    [],
    "a pool that has not started cannot be running low",
  );
  assert.deepEqual(
    await getCreditBalances(
      buildStub(NO_PERIOD),
      ORG,
      { belowPercent: 0 },
      NOW,
    ),
    [],
    "and it is certainly not exhausted",
  );

  // ── 9. The rollover window: period ended, dispatch has not re-minted yet ────
  // Between periodEnd and the 04:00 dispatch mint, every healthy pool has ZERO
  // drawable grants. It must read FULL, not exhausted, on every surface.

  const BETWEEN_PERIODS: Fixture = {
    subscriptions: [subscription()],
    strategies: [strategy()],
    grants: [
      {
        subscriptionId: "sub-1",
        amountUnits: 5000,
        consumedUnits: 1000,
        periodStart: PERIOD_START,
        effectiveAt: PERIOD_START,
        expiresAt: PERIOD_END,
      },
    ],
    events: [],
  };
  const justAfterRollover = new Date(PERIOD_END.getTime() + 60 * 1000);
  const between = await getCreditBalance(
    buildStub(BETWEEN_PERIODS),
    ORG,
    "sub-1",
    justAfterRollover,
  );
  assert.ok(between);
  assert.equal(between.noActivePeriod, true);
  assert.equal(
    between.remainingUnits,
    5000,
    "a healthy pool must NOT flash exhausted while waiting for the re-mint",
  );
  assert.equal(between.implicitFullPool, true);
  assert.deepEqual(
    await getCreditBalances(
      buildStub(BETWEEN_PERIODS),
      ORG,
      { belowPercent: 20 },
      justAfterRollover,
    ),
    [],
    "and it must not appear on the needs-attention page during that window",
  );

  // ── 10. Invoice parity across the four divergence modes ────────────────────
  // Each fixture is a case where a createdAt-windowed LEDGER read would have
  // disagreed with the invoice. The usageDate-windowed signal_events read (the
  // calculator's own recipe) matches all four.

  const parityCases: Array<{
    label: string;
    events: StubEvent[];
    expectedConsumed: number;
    expectedOverage: number;
  }> = [
    {
      // A buffered flush: the event arrived late but names a usageDate inside
      // this period, so the invoice bills it here.
      label: "buffered flush billed to the period it names",
      events: [
        {
          organizationId: ORG,
          subscriptionId: "sub-1",
          signalId: "signal-1",
          quantity: 5300,
          usageDate: new Date("2026-07-31T23:00:00.000Z"),
        },
      ],
      expectedConsumed: 5300,
      expectedOverage: 300,
    },
    {
      // A draw the ingest seam swallowed non-fatally: NO ledger entry exists,
      // but the event is stored and the invoice bills it. Under-reporting this
      // is the surprise-bill direction.
      label: "swallowed draw the invoice still bills",
      events: [
        {
          organizationId: ORG,
          subscriptionId: "sub-1",
          signalId: "signal-1",
          quantity: 6000,
          usageDate: new Date("2026-07-05T00:00:00.000Z"),
        },
      ],
      expectedConsumed: 6000,
      expectedOverage: 1000,
    },
    {
      // A historical import: usageDate inside the window, written today.
      label: "historical-usageDate import",
      events: [
        {
          organizationId: ORG,
          subscriptionId: "sub-1",
          signalId: "signal-1",
          quantity: 5001,
          usageDate: PERIOD_START,
        },
      ],
      expectedConsumed: 5001,
      expectedOverage: 1,
    },
    {
      // The closing instant: the calculator's window is INCLUSIVE at both
      // ends, so an event exactly on periodEnd bills and must count.
      label: "event on the closing instant",
      events: [
        {
          organizationId: ORG,
          subscriptionId: "sub-1",
          signalId: "signal-1",
          quantity: 5200,
          usageDate: PERIOD_END,
        },
      ],
      expectedConsumed: 5200,
      expectedOverage: 200,
    },
  ];

  for (const c of parityCases) {
    const fx: Fixture = {
      subscriptions: [subscription()],
      strategies: [strategy()],
      grants: [
        {
          subscriptionId: "sub-1",
          amountUnits: 5000,
          consumedUnits: 0,
          periodStart: PERIOD_START,
          effectiveAt: PERIOD_START,
          expiresAt: PERIOD_END,
        },
      ],
      events: c.events,
    };
    const row = await getCreditBalance(buildStub(fx), ORG, "sub-1", NOW);
    assert.equal(row?.consumedUnits, c.expectedConsumed, c.label);
    assert.equal(
      row?.overageInProgressUnits,
      c.expectedOverage,
      `${c.label}: overage must match what the invoice will bill`,
    );
  }

  // Scoping negative controls: another org's, another subscription's, and
  // another meter's events must never inflate this pool's bill.
  const LEAKY: Fixture = {
    subscriptions: [subscription()],
    strategies: [strategy()],
    grants: [],
    events: [
      { ...eventFor("sub-1", 100), organizationId: OTHER_ORG },
      eventFor("sub-other", 100),
      { ...eventFor("sub-1", 100), signalId: "other-signal" },
      {
        ...eventFor("sub-1", 100),
        usageDate: new Date("2026-06-15T00:00:00.000Z"),
      },
    ],
  };
  assert.equal(
    (await getCreditBalance(buildStub(LEAKY), ORG, "sub-1", NOW))
      ?.consumedUnits,
    0,
    "org / subscription / signal / window scoping all hold",
  );

  // ── 11. rated pools: consumedUnits is the invoice's credit sum ───

  const RATED_RATES = { "signal-1": 4, "signal-notes": 2 };

  // 2 reports × 4 + 3 notes × 2 = 14 credits.
  const RATED_SMALL: Fixture = {
    subscriptions: [subscription()],
    strategies: [strategy({ creditRates: RATED_RATES })],
    grants: [grantFor("sub-1", 14)],
    events: [
      eventFor("sub-1", 2),
      { ...eventFor("sub-1", 3), signalId: "signal-notes" },
      // NOT a creditRates key and not the pool's signal: must never count.
      { ...eventFor("sub-1", 999), signalId: "signal-x" },
    ],
  };
  const ratedSmall = await getCreditBalance(
    buildStub(RATED_SMALL),
    ORG,
    "sub-1",
    NOW,
  );
  assert.ok(ratedSmall);
  assert.equal(
    ratedSmall.consumedUnits,
    14,
    "rated consumption: 2 × 4 + 3 × 2 = 14 credits, non-member excluded",
  );
  assert.equal(ratedSmall.overageInProgressUnits, 0);
  assert.equal(
    ratedSmall.remainingUnits,
    5000 - 14,
    "the countdown and the rated draws agree on the same fixture",
  );

  // Overage in CREDITS, the invoice recipe: 1,000 × 4 + 700 × 2 = 5,400
  // credits against a 5,000-credit pool -> 400 credits already billing.
  const RATED_OVERAGE: Fixture = {
    subscriptions: [subscription()],
    strategies: [strategy({ creditRates: RATED_RATES })],
    grants: [grantFor("sub-1", 5400)],
    events: [
      eventFor("sub-1", 1000),
      { ...eventFor("sub-1", 700), signalId: "signal-notes" },
    ],
  };
  const ratedOver = await getCreditBalance(
    buildStub(RATED_OVERAGE),
    ORG,
    "sub-1",
    NOW,
  );
  assert.ok(ratedOver);
  assert.equal(ratedOver.consumedUnits, 5400);
  assert.equal(
    ratedOver.overageInProgressUnits,
    400,
    "overage = max(0, rated credits - pool), exactly what calcCreditPool bills",
  );
  assert.equal(ratedOver.remainingUnits, -400);

  // A rated pool's row has the same key set as a rate-less pool's row, so
  // SDK / MCP / portal read rated numbers with no shape difference.
  const legacyRow = await getCreditBalance(
    buildStub(OVERDRAWN),
    ORG,
    "sub-1",
    NOW,
  );
  assert.deepEqual(
    Object.keys(ratedOver).sort(),
    Object.keys(legacyRow as object).sort(),
    "rated and rate-less rows carry the identical field set",
  );
  assert.deepEqual(
    Object.keys(ratedOver).sort(),
    [
      "agentId",
      "alertsPaused",
      "consumedUnits",
      "customerExternalId",
      "customerId",
      "customerName",
      "implicitFullPool",
      "noActivePeriod",
      "overageInProgressUnits",
      "overageRatePerUnit",
      "periodEnd",
      "periodStart",
      "planId",
      "planName",
      "poolSizeUnits",
      "remainingPercent",
      "remainingUnits",
      "subscriptionId",
      "subscriptionName",
    ],
    "CreditBalanceRow wire shape pinned",
  );

  console.log("credit-balance.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
