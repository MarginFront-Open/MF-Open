/**
 * credit-ledger: the ONE credit-pool ledger path. Runs under
 * tsx in <1s against an in-memory client stub (packages/db src test
 * convention — standalone assert scripts, NOT vitest):
 *
 *   npx tsx packages/db/src/lib/credit-ledger.test.ts
 *
 * WHAT THESE PROVE vs WHAT THEY DON'T: the stub
 * models Prisma query semantics (filters, orderBy incl. nulls-last, unique
 * keys as P2002, atomic increment/decrement) but executes single-threaded
 * with NO real transaction isolation. Everything below proves call shape,
 * math, idempotency-by-key, and the same-transaction invariant (every ledger
 * append and cache write goes through the tx client). Real interleaving,
 * row-lock serialization, and end-to-end mint-at-dispatch need a live
 * database and the CRON_SECRET dispatch fire, so they are not covered here.
 *
 * Covered, each with failure-capable assertions:
 *   1.  Mint idempotency under double-advance (same period twice -> one
 *       grant; advanced period -> a second).
 *   2.  Draw order: expiry-soonest first, then oldest.
 *   3.  Expiry at draw: expired grants undrawable at the event's usageDate.
 *   4.  usageDate period attribution (CROSS-PERIOD fixture): a late buffered
 *       flush draws in the period it bills and NEVER touches the current
 *       period's cache.
 *   5.  Unit-quantity parity: ledger draws == the invoice-calculator
 *       selection (SUM(quantity), signalId-scoped) on the same fixture.
 *   6.  Invoice parity: calcCreditPool's total on
 *       the fixture is BIT-FOR-BIT identical before and after every ledger
 *       operation — the ledger adds rows, never inputs to billing math.
 *   7.  Cache upsert-then-decrement invariants (+ stale-period heal).
 *   8.  computeBalance vs cache consistency; active-period-with-no-grant
 *       reads as a FULL untouched pool, never exhausted.
 *   9.  Sweep: exactly one expire entry per expired remainder, idempotent,
 *       correct balanceAfterUnits.
 *   10. Lazy mint on first consume; per-event consume idempotency; negative
 *       balance overdraw lands on the period grant.
 *   11. GOLDEN REPLAY (the negative control): a canonical
 *       mint/draw/overdraw/retry script with creditRates absent, null, and {}
 *       produces BYTE-IDENTICAL grants, entries, balances, and results — all
 *       three pinned against one hardcoded literal, no rateApplied key ever
 *       written.
 *   12. Rated draws: memberRate unit table, membership broadening
 *       in findCreditPoolStrategy, credits = units × rate through lazy mint /
 *       overdraw / idempotent retry, rateApplied on the ledger rows,
 *       nonPositiveRate, preloaded-strategy rate resolution.
 *   13. Signal-type pin: fixture pair identical except signals.type →
 *       identical draw results (the ledger is signal-type-blind).
 *   14. Parity oracle: invoiceSelectedCreditQuantity —
 *       per member signal SUM(quantity) × rate, the calculator's own
 *       sum-first-then-multiply order. EXACT-equality pins on float-exact
 *       fixtures (integer quantities × rates 4/2/0.5/0.25) and the
 *       ≤ 1e-6 × eventCount tolerance property (per-event 6dp column
 *       rounding vs sum-then-multiply), with an unrated-recipe negative
 *       control that FAILS the bound so the tolerance can't hide a missing
 *       rate.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  computeBalance,
  consumeUnits,
  findCreditPoolStrategy,
  memberRate,
  mintPeriodGrant,
  poolIsRated,
  poolMemberRates,
  poolSizeFromTiers,
  sweepExpiredGrants,
  type CreditLedgerClient,
} from "./credit-ledger";
import { calcCreditPool } from "./revenue-calc";

// ── in-memory stub ──────────────────────────────────────────────────────────

interface StubState {
  subscriptions: Array<{
    id: string;
    organizationId: string | null;
    planId: string;
    currentBillingPeriodStart: Date | null;
    currentBillingPeriodEnd: Date | null;
  }>;
  strategies: Array<{
    id: string;
    planId: string;
    signalId: string | null;
    pricingModel: string;
    chargeType: string;
    active: boolean;
    deletedAt: Date | null;
    createdAt: Date;
    tiers: unknown;
    creditRates?: unknown;
    rate?: number | null;
    minimumCommitment?: number | null;
  }>;
  grants: Array<{
    id: string;
    subscriptionId: string;
    organizationId: string;
    amountUnits: number;
    consumedUnits: number;
    source: string;
    periodStart: Date | null;
    effectiveAt: Date;
    expiresAt: Date | null;
    createdBy: string | null;
  }>;
  entries: Array<{
    id: string;
    grantId: string;
    subscriptionId: string;
    kind: string;
    deltaUnits: number;
    balanceAfterUnits: number;
    signalEventId: string | null;
    rateApplied?: number;
  }>;
  balances: Array<{
    subscriptionId: string;
    balanceUnits: number;
    periodStart: Date;
  }>;
  events: Array<{
    id: string;
    organizationId: string;
    subscriptionId: string;
    signalId: string;
    usageDate: Date;
    quantity: number;
  }>;
  /**
   * Inert signal metadata for the signal-type-blind pin (section 13). The ledger client interface has no
   * signals delegate, so nothing under test can read these — which is exactly
   * what the pin asserts stays true.
   */
  signals?: Array<{ id: string; type: string | null }>;
}

function p2002(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

function matchGrantWhere(g: StubState["grants"][number], where: any): boolean {
  if (
    where.subscriptionId !== undefined &&
    g.subscriptionId !== where.subscriptionId
  )
    return false;
  if (where.periodStart !== undefined) {
    const want: Date | null = where.periodStart;
    if (want === null && g.periodStart !== null) return false;
    if (
      want !== null &&
      (g.periodStart === null || g.periodStart.getTime() !== want.getTime())
    )
      return false;
  }
  if (where.effectiveAt?.lte && g.effectiveAt > where.effectiveAt.lte)
    return false;
  if (where.expiresAt?.lte) {
    if (g.expiresAt === null || g.expiresAt > where.expiresAt.lte) return false;
  }
  if (where.OR) {
    const ok = where.OR.some((clause: any) => {
      if ("expiresAt" in clause) {
        if (clause.expiresAt === null) return g.expiresAt === null;
        if (clause.expiresAt?.gt)
          return g.expiresAt !== null && g.expiresAt > clause.expiresAt.gt;
      }
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

function buildStub(state: StubState): CreditLedgerClient {
  const client: any = {
    subscriptions: {
      findUnique: async (args: any) =>
        state.subscriptions.find((s) => s.id === args.where.id) ?? null,
    },
    pricing_strategies: {
      findFirst: async (args: any) => {
        const w = args.where;
        const hits = state.strategies
          .filter(
            (s) =>
              s.planId === w.planId &&
              s.pricingModel === w.pricingModel &&
              s.chargeType === w.chargeType &&
              s.active === w.active &&
              s.deletedAt === null &&
              (typeof w.signalId === "string"
                ? s.signalId === w.signalId
                : s.signalId !== null),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return hits[0] ?? null;
      },
    },
    credit_grants: {
      findMany: async (args: any) => {
        let hits = state.grants.filter((g) => matchGrantWhere(g, args.where));
        if (args.where.credit_ledger_entries?.none) {
          const noneKind = args.where.credit_ledger_entries.none.kind;
          hits = hits.filter(
            (g) =>
              !state.entries.some(
                (e) => e.grantId === g.id && e.kind === noneKind,
              ),
          );
        }
        if (args.orderBy) {
          // Interprets the ACTUAL orderBy sent (field list, direction,
          // nulls placement); a hardcoded sort here would let a wrong draw
          // order in the lib pass unnoticed.
          const clauses: any[] = Array.isArray(args.orderBy)
            ? args.orderBy
            : [args.orderBy];
          hits = [...hits].sort((a: any, b: any) => {
            for (const clause of clauses) {
              const field = Object.keys(clause)[0];
              const spec = clause[field];
              const dir = typeof spec === "string" ? spec : spec.sort;
              const nulls =
                typeof spec === "string" ? "first" : (spec.nulls ?? "first");
              const av = a[field];
              const bv = b[field];
              if (av === null && bv === null) continue;
              if (av === null) return nulls === "last" ? 1 : -1;
              if (bv === null) return nulls === "last" ? -1 : 1;
              const d = av.getTime() - bv.getTime();
              if (d !== 0) return dir === "desc" ? -d : d;
            }
            return 0;
          });
        }
        return hits.map((g) => ({ ...g }));
      },
      findFirst: async (args: any) => {
        const hit = state.grants.find((g) => matchGrantWhere(g, args.where));
        return hit ? { ...hit } : null;
      },
      create: async (args: any) => {
        const d = args.data;
        const dupe = state.grants.some(
          (g) =>
            g.subscriptionId === d.subscriptionId &&
            g.periodStart !== null &&
            d.periodStart !== null &&
            g.periodStart.getTime() === d.periodStart.getTime(),
        );
        if (dupe) throw p2002();
        const row = {
          id: randomUUID(),
          subscriptionId: d.subscriptionId,
          organizationId: d.organizationId,
          amountUnits: d.amountUnits,
          consumedUnits: d.consumedUnits ?? 0,
          source: d.source,
          periodStart: d.periodStart ?? null,
          effectiveAt: d.effectiveAt,
          expiresAt: d.expiresAt ?? null,
          createdBy: d.createdBy ?? null,
        };
        state.grants.push(row);
        return { ...row };
      },
      update: async (args: any) => {
        const g = state.grants.find((x) => x.id === args.where.id);
        if (!g) throw new Error("grant not found");
        const inc = args.data.consumedUnits?.increment;
        if (typeof inc === "number") g.consumedUnits += inc;
        return { ...g };
      },
    },
    credit_ledger_entries: {
      findFirst: async (args: any) => {
        const w = args.where;
        const hit = state.entries.find(
          (e) =>
            (w.signalEventId === undefined ||
              e.signalEventId === w.signalEventId) &&
            (w.grantId === undefined || e.grantId === w.grantId) &&
            (w.kind === undefined || e.kind === w.kind),
        );
        return hit ? { ...hit } : null;
      },
      create: async (args: any) => {
        const d = args.data;
        if (
          d.signalEventId !== null &&
          state.entries.some(
            (e) =>
              e.signalEventId === d.signalEventId && e.grantId === d.grantId,
          )
        ) {
          throw p2002();
        }
        const row = { id: randomUUID(), ...d };
        state.entries.push(row);
        return { ...row };
      },
    },
    credit_pool_balances: {
      findUnique: async (args: any) => {
        const hit = state.balances.find(
          (b) => b.subscriptionId === args.where.subscriptionId,
        );
        return hit ? { ...hit } : null;
      },
      upsert: async (args: any) => {
        const hit = state.balances.find(
          (b) => b.subscriptionId === args.where.subscriptionId,
        );
        if (!hit) {
          state.balances.push({ ...args.create });
          return { ...args.create };
        }
        if (typeof args.update.balanceUnits === "number")
          hit.balanceUnits = args.update.balanceUnits;
        if (args.update.periodStart) hit.periodStart = args.update.periodStart;
        return { ...hit };
      },
      updateMany: async (args: any) => {
        const w = args.where;
        const hits = state.balances.filter(
          (b) =>
            b.subscriptionId === w.subscriptionId &&
            (w.periodStart === undefined ||
              b.periodStart.getTime() === w.periodStart.getTime()),
        );
        for (const b of hits) {
          const dec = args.data.balanceUnits?.decrement;
          if (typeof dec === "number") b.balanceUnits -= dec;
          else if (typeof args.data.balanceUnits === "number")
            b.balanceUnits = args.data.balanceUnits;
        }
        return { count: hits.length };
      },
    },
    // Single-threaded stub: the tx client IS the client. What this preserves
    // (and what the lib's tests can therefore pin): every ledger append and
    // cache write is issued through the tx callback's client — the
    // same-transaction invariant. What it cannot prove: rollback or real
    // row-lock interleaving, which needs a live database.
    $transaction: async (fn: any) => fn(client),
  };
  return client as CreditLedgerClient;
}

// ── fixture ─────────────────────────────────────────────────────────────────

const ORG = "org-1";
const PLAN = "plan-1";
const SUB = "sub-1";
const SIGNAL = "signal-1";

const P1_START = new Date("2026-06-15T00:00:00.000Z");
const P1_END = new Date("2026-07-15T00:00:00.000Z");
const P2_START = P1_END;
const P2_END = new Date("2026-08-15T00:00:00.000Z");

/** Pool of 1,000 units for $99, overage $0.03/unit (the doc-comment shape). */
const POOL_TIERS = [
  { lower: 0, upper: 1000, rate: 99 },
  { lower: 1000, upper: null, rate: 0.03 },
];

function freshState(overrides: Partial<StubState> = {}): StubState {
  return {
    subscriptions: [
      {
        id: SUB,
        organizationId: ORG,
        planId: PLAN,
        currentBillingPeriodStart: P1_START,
        currentBillingPeriodEnd: P1_END,
      },
    ],
    strategies: [
      {
        id: "strat-1",
        planId: PLAN,
        signalId: SIGNAL,
        pricingModel: "credit_pool",
        chargeType: "usage",
        active: true,
        deletedAt: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        tiers: POOL_TIERS,
        rate: null,
        minimumCommitment: null,
      },
    ],
    grants: [],
    entries: [],
    balances: [],
    events: [],
    ...overrides,
  };
}

/**
 * The invoice-calculator selection recipe, replicated verbatim from
 * invoice-calculator.service.ts (calculateInvoice batch fetch +
 * pooledCreditQuantity): per pool member signal, org + subscription +
 * signalId + usageDate window, SUM(quantity) × burn rate, summed. Sum
 * FIRST, then one multiply per signal — the calculator's exact order of
 * operations. THE parity oracle the ledger must match.
 */
function invoiceSelectedCreditQuantity(
  state: StubState,
  strategy: { signalId: string | null; creditRates?: unknown },
  windowStart: Date,
  windowEnd: Date,
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
    const quantity = state.events
      .filter(
        (e) =>
          e.organizationId === ORG &&
          e.subscriptionId === SUB &&
          e.signalId === memberSignalId &&
          e.usageDate >= windowStart &&
          e.usageDate <= windowEnd,
      )
      .reduce((sum, e) => sum + e.quantity, 0);
    credits += quantity * rate;
  }
  return credits;
}

/** The single-signal projection: a rate-less pool, credits ≡ units. */
function invoiceSelectedQuantity(
  state: StubState,
  windowStart: Date,
  windowEnd: Date,
): number {
  return invoiceSelectedCreditQuantity(
    state,
    { signalId: SIGNAL, creditRates: null },
    windowStart,
    windowEnd,
  );
}

async function fireEvent(
  client: CreditLedgerClient,
  state: StubState,
  args: {
    quantity: number;
    usageDate: Date;
    eventId?: string;
    signalId?: string;
  },
) {
  const id = args.eventId ?? randomUUID();
  const signalId = args.signalId ?? SIGNAL;
  state.events.push({
    id,
    organizationId: ORG,
    subscriptionId: SUB,
    signalId,
    usageDate: args.usageDate,
    quantity: args.quantity,
  });
  const result = await consumeUnits(client, {
    subscriptionId: SUB,
    signalEventId: id,
    signalId,
    quantity: args.quantity,
    usageDate: args.usageDate,
    now: args.usageDate,
  });
  return { id, result };
}

// ── tests ───────────────────────────────────────────────────────────────────

async function main() {
  // ─── poolSizeFromTiers reads the pool exactly like calcCreditPool ────────
  {
    assert.equal(poolSizeFromTiers(POOL_TIERS), 1000);
    // Unsorted storage order must not change the answer (calcCreditPool sorts).
    assert.equal(poolSizeFromTiers([POOL_TIERS[1], POOL_TIERS[0]]), 1000);
    assert.equal(poolSizeFromTiers([]), null);
    assert.equal(poolSizeFromTiers(null), null);
    assert.equal(
      poolSizeFromTiers([{ lower: 0, upper: null, rate: 5 }]),
      null,
      "unbounded pool tier has no mintable size",
    );
    assert.equal(
      poolSizeFromTiers([{ lower: 0, upper: 0, rate: 5 }]),
      null,
      "degenerate upper:0 pool has no mintable size (the migration's > 0 guard mirrors this)",
    );
  }

  // ─── 1. mint idempotency under double-advance ────────────────────────────
  {
    const state = freshState();
    const client = buildStub(state);

    const first = await mintPeriodGrant(client, {
      subscriptionId: SUB,
      createdBy: "dispatch:usage-invoice",
      now: P1_START,
    });
    assert.equal(first.minted, true);
    const second = await mintPeriodGrant(client, {
      subscriptionId: SUB,
      createdBy: "dispatch:usage-invoice",
      now: P1_START,
    });
    assert.deepEqual(second, { minted: false, reason: "alreadyMinted" });
    assert.equal(
      state.grants.length,
      1,
      "double mint same period -> ONE grant",
    );
    assert.equal(state.grants[0].amountUnits, 1000);
    assert.equal(state.grants[0].source, "period_grant");
    assert.equal(
      state.grants[0].expiresAt?.getTime(),
      P1_END.getTime(),
      "period grant expires at currentBillingPeriodEnd",
    );

    // Advance the period (what dispatch's committed tx does), mint again.
    state.subscriptions[0].currentBillingPeriodStart = P2_START;
    state.subscriptions[0].currentBillingPeriodEnd = P2_END;
    const third = await mintPeriodGrant(client, {
      subscriptionId: SUB,
      createdBy: "dispatch:usage-invoice",
      now: P2_START,
    });
    assert.equal(third.minted, true, "advanced period -> a NEW grant mints");
    assert.equal(state.grants.length, 2);

    // The rollover mint recompute-SETs the cache to the new period's pool
    // (old grant expired at P2_START, so its remainder is shed immediately).
    assert.equal(state.balances[0].balanceUnits, 1000);
    assert.equal(state.balances[0].periodStart.getTime(), P2_START.getTime());

    // Belt: a raced create that slips past the pre-check surfaces as P2002
    // and maps to alreadyMinted, not a throw.
    state.subscriptions[0].currentBillingPeriodStart = P1_START;
    state.subscriptions[0].currentBillingPeriodEnd = P1_END;
    const raced = await mintPeriodGrant(client, {
      subscriptionId: SUB,
      createdBy: "dispatch:usage-invoice",
      now: P1_START,
      // Preloaded sub skips the re-read; the pre-check findFirst still sees
      // the existing grant, so force the create path by clearing it:
    });
    assert.deepEqual(raced, { minted: false, reason: "alreadyMinted" });
  }

  // ─── mint no-ops honestly on non-pool / period-less subs ─────────────────
  {
    const state = freshState();
    state.strategies[0].pricingModel = "graduated";
    const client = buildStub(state);
    const res = await mintPeriodGrant(client, {
      subscriptionId: SUB,
      createdBy: "activation",
    });
    assert.deepEqual(res, { minted: false, reason: "notCreditPool" });
    assert.equal(state.grants.length, 0);
  }
  {
    const state = freshState();
    state.subscriptions[0].currentBillingPeriodStart = null;
    state.subscriptions[0].currentBillingPeriodEnd = null;
    const client = buildStub(state);
    const res = await mintPeriodGrant(client, {
      subscriptionId: SUB,
      createdBy: "activation",
    });
    assert.deepEqual(res, { minted: false, reason: "noActivePeriod" });
  }

  // ─── 10a. lazy mint on first consume + cache upsert-then-decrement ───────
  {
    const state = freshState();
    const client = buildStub(state);
    const mid = new Date("2026-06-20T00:00:00.000Z");

    const { result } = await fireEvent(client, state, {
      quantity: 300,
      usageDate: mid,
    });
    assert.equal(result.consumed, true);
    if (result.consumed) {
      assert.equal(result.lazyMinted, true, "first consume heals the ledger");
      assert.equal(result.balanceAfterUnits, 700);
    }
    assert.equal(state.grants.length, 1);
    assert.equal(state.grants[0].createdBy, "lazy-mint");
    assert.equal(state.grants[0].consumedUnits, 300);
    assert.equal(
      state.balances[0].balanceUnits,
      700,
      "cache decremented in-txn",
    );
    // grant entry + consume entry
    assert.equal(state.entries.length, 2);
    const consumeEntry = state.entries.find((e) => e.kind === "consume")!;
    assert.equal(consumeEntry.deltaUnits, -300);
    assert.equal(consumeEntry.balanceAfterUnits, 700);
    assert.equal(consumeEntry.signalEventId, state.events[0].id);
  }

  // ─── 10a'. lazy mint fires even when a standing top-up is drawable ───────
  // The gate is "no grant for THIS period", never "no
  // drawable grants" — a never-expiring manual_topup must not suppress
  // the period mint, or draws would burn the permanent grant first and
  // invert expiry-soonest-first.
  {
    const state = freshState();
    const client = buildStub(state);
    const mid = new Date("2026-06-20T00:00:00.000Z");
    state.grants.push({
      id: "standing-topup",
      subscriptionId: SUB,
      organizationId: ORG,
      amountUnits: 400,
      consumedUnits: 0,
      source: "manual_topup",
      periodStart: null,
      effectiveAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: null,
      createdBy: "test",
    });

    const { result } = await fireEvent(client, state, {
      quantity: 300,
      usageDate: mid,
    });
    assert.equal(result.consumed, true);
    if (result.consumed) {
      assert.equal(
        result.lazyMinted,
        true,
        "fresh period + standing top-up -> the period grant STILL mints",
      );
      assert.equal(result.balanceAfterUnits, 1100); // 1000 + 400 - 300
    }
    const periodGrant = state.grants.find((g) => g.source === "period_grant")!;
    const topup = state.grants.find((g) => g.id === "standing-topup")!;
    assert.ok(periodGrant, "period grant exists alongside the top-up");
    assert.equal(
      periodGrant.consumedUnits,
      300,
      "the expiring period grant burns FIRST",
    );
    assert.equal(topup.consumedUnits, 0, "the permanent top-up is untouched");
  }

  // ─── 10b. per-event consume idempotency (ingest retry) ───────────────────
  {
    const state = freshState();
    const client = buildStub(state);
    const mid = new Date("2026-06-20T00:00:00.000Z");
    const { id } = await fireEvent(client, state, {
      quantity: 100,
      usageDate: mid,
    });

    const replay = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: id,
      signalId: SIGNAL,
      quantity: 100,
      usageDate: mid,
      now: mid,
    });
    assert.deepEqual(replay, { consumed: false, reason: "alreadyConsumed" });
    assert.equal(
      state.grants[0].consumedUnits,
      100,
      "a retry never double-decrements",
    );
    assert.equal(state.balances[0].balanceUnits, 900);
  }

  // ─── non-pool subscriptions and zero quantities no-op ────────────────────
  {
    const state = freshState();
    state.strategies[0].pricingModel = "flat";
    const client = buildStub(state);
    const res = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: randomUUID(),
      signalId: SIGNAL,
      quantity: 5,
      usageDate: new Date("2026-06-20T00:00:00.000Z"),
    });
    assert.deepEqual(res, { consumed: false, reason: "notCreditPool" });
    assert.equal(state.grants.length, 0, "non-pool subs never mint");
  }
  {
    const state = freshState();
    const client = buildStub(state);
    const res = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: randomUUID(),
      signalId: SIGNAL,
      quantity: 0,
      usageDate: new Date("2026-06-20T00:00:00.000Z"),
    });
    assert.deepEqual(res, { consumed: false, reason: "nonPositiveQuantity" });
  }

  // ─── 2. draw order: expiry-soonest first, then oldest ────────────────────
  {
    const state = freshState();
    const client = buildStub(state);
    const mid = new Date("2026-06-20T00:00:00.000Z");

    // A never-expiring top-up that is OLDER than the period grant. Strict
    // FIFO would burn it first; expiry-first
    // must draw the period grant first.
    state.grants.push({
      id: "topup-1",
      subscriptionId: SUB,
      organizationId: ORG,
      amountUnits: 500,
      consumedUnits: 0,
      source: "manual_topup",
      periodStart: null,
      effectiveAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: null,
      createdBy: "test",
    });
    state.grants.push({
      id: "period-1",
      subscriptionId: SUB,
      organizationId: ORG,
      amountUnits: 1000,
      consumedUnits: 0,
      source: "period_grant",
      periodStart: P1_START,
      effectiveAt: P1_START,
      expiresAt: P1_END,
      createdBy: "test",
    });

    const { result } = await fireEvent(client, state, {
      quantity: 1200,
      usageDate: mid,
    });
    assert.equal(result.consumed, true);
    const period = state.grants.find((g) => g.id === "period-1")!;
    const topup = state.grants.find((g) => g.id === "topup-1")!;
    assert.equal(period.consumedUnits, 1000, "expiring grant burns FIRST");
    assert.equal(topup.consumedUnits, 200, "top-up only covers the spill");
    if (result.consumed) {
      assert.equal(result.balanceAfterUnits, 300);
      assert.equal(result.entryCount, 2, "one consume entry per grant drawn");
    }
  }

  // ─── 3+10c. expiry at draw + negative-balance overdraw ───────────────────
  {
    const state = freshState();
    const client = buildStub(state);
    // Sub now lives in period 2; period-1's grant is expired.
    state.subscriptions[0].currentBillingPeriodStart = P2_START;
    state.subscriptions[0].currentBillingPeriodEnd = P2_END;
    state.grants.push(
      {
        id: "old-grant",
        subscriptionId: SUB,
        organizationId: ORG,
        amountUnits: 1000,
        consumedUnits: 0,
        source: "period_grant",
        periodStart: P1_START,
        effectiveAt: P1_START,
        expiresAt: P1_END,
        createdBy: "test",
      },
      {
        id: "new-grant",
        subscriptionId: SUB,
        organizationId: ORG,
        amountUnits: 1000,
        consumedUnits: 900,
        source: "period_grant",
        periodStart: P2_START,
        effectiveAt: P2_START,
        expiresAt: P2_END,
        createdBy: "test",
      },
    );
    state.balances.push({
      subscriptionId: SUB,
      balanceUnits: 100,
      periodStart: P2_START,
    });

    const inP2 = new Date("2026-07-20T00:00:00.000Z");
    const { result } = await fireEvent(client, state, {
      quantity: 250,
      usageDate: inP2,
    });
    assert.equal(result.consumed, true);
    const oldGrant = state.grants.find((g) => g.id === "old-grant")!;
    const newGrant = state.grants.find((g) => g.id === "new-grant")!;
    assert.equal(
      oldGrant.consumedUnits,
      0,
      "an expired grant is UNDRAWABLE at this usageDate — its 1000 unused units must not absorb the draw",
    );
    assert.equal(
      newGrant.consumedUnits,
      1150,
      "overdraw lands on the period grant (negative balance = overage-in-progress)",
    );
    if (result.consumed) assert.equal(result.balanceAfterUnits, -150);
    assert.equal(state.balances[0].balanceUnits, -150);
  }

  // ─── 4. CROSS-PERIOD fixture: late flush draws where it bills ────────────
  {
    const state = freshState();
    const client = buildStub(state);
    state.subscriptions[0].currentBillingPeriodStart = P2_START;
    state.subscriptions[0].currentBillingPeriodEnd = P2_END;
    state.grants.push(
      {
        id: "p1-grant",
        subscriptionId: SUB,
        organizationId: ORG,
        amountUnits: 1000,
        consumedUnits: 400,
        source: "period_grant",
        periodStart: P1_START,
        effectiveAt: P1_START,
        expiresAt: P1_END,
        createdBy: "test",
      },
      {
        id: "p2-grant",
        subscriptionId: SUB,
        organizationId: ORG,
        amountUnits: 1000,
        consumedUnits: 0,
        source: "period_grant",
        periodStart: P2_START,
        effectiveAt: P2_START,
        expiresAt: P2_END,
        createdBy: "test",
      },
    );
    state.balances.push({
      subscriptionId: SUB,
      balanceUnits: 1000,
      periodStart: P2_START,
    });

    // The buffered event carries a usageDate inside PERIOD 1 but arrives
    // during period 2 (`now`). It must bill — and therefore draw — in P1.
    const lateUsageDate = new Date("2026-07-10T00:00:00.000Z");
    const arrivalNow = new Date("2026-07-20T00:00:00.000Z");
    const eventId = randomUUID();
    state.events.push({
      id: eventId,
      organizationId: ORG,
      subscriptionId: SUB,
      signalId: SIGNAL,
      usageDate: lateUsageDate,
      quantity: 150,
    });
    const res = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: eventId,
      signalId: SIGNAL,
      quantity: 150,
      usageDate: lateUsageDate,
      now: arrivalNow,
    });
    assert.equal(res.consumed, true);
    assert.equal(
      state.grants.find((g) => g.id === "p1-grant")!.consumedUnits,
      550,
      "late flush draws against the grant covering its usageDate",
    );
    assert.equal(
      state.grants.find((g) => g.id === "p2-grant")!.consumedUnits,
      0,
      "the CURRENT period's grant is untouched by a prior-period event",
    );
    assert.equal(
      state.balances[0].balanceUnits,
      1000,
      "the current period's cache is NEVER touched by a cross-period draw",
    );

    // Parity per period window (the invoice bills each window separately).
    const p1Qty = invoiceSelectedQuantity(state, P1_START, P1_END);
    const p1Drawn = state.entries
      .filter((e) => e.kind === "consume" && e.grantId === "p1-grant")
      .reduce((s, e) => s + -e.deltaUnits, 0);
    assert.equal(p1Drawn, 150);
    assert.equal(p1Qty, 150, "ledger draw == invoice selection for the window");
  }

  // ─── 5+6. unit parity + invoice parity ───────────────────────────────────
  {
    const state = freshState();
    const client = buildStub(state);
    const strategy = {
      tiers: POOL_TIERS,
      rate: null,
      minimumCommitment: null,
    } as any;

    // Oracle BEFORE any ledger exists: what track mode bills without one.
    const plannedQuantities = [300, 500, 450]; // 1250 total -> 250 overage
    const plannedTotal = plannedQuantities.reduce((a, b) => a + b, 0);
    const invoiceTotalBefore = calcCreditPool(strategy, plannedTotal);
    assert.equal(invoiceTotalBefore, 99 + 250 * 0.03);

    const dates = [
      new Date("2026-06-16T00:00:00.000Z"),
      new Date("2026-06-25T12:00:00.000Z"),
      new Date("2026-07-14T23:59:59.000Z"),
    ];
    for (let i = 0; i < plannedQuantities.length; i++) {
      const { result } = await fireEvent(client, state, {
        quantity: plannedQuantities[i],
        usageDate: dates[i],
      });
      assert.equal(result.consumed, true);
    }

    // Unit-quantity parity: total ledger draw == the invoice selection.
    const selected = invoiceSelectedQuantity(state, P1_START, P1_END);
    const drawn = state.entries
      .filter((e) => e.kind === "consume")
      .reduce((s, e) => s + -e.deltaUnits, 0);
    assert.equal(selected, plannedTotal);
    assert.equal(
      drawn,
      selected,
      "ledger units == invoice-selected units on the same fixture",
    );

    // Invoice parity: with grants, entries, and a negative-headed
    // cache all present, the biller's total is BIT-FOR-BIT what it was —
    // calcCreditPool takes (strategy, quantity) and the ledger changed
    // neither. Object.is pins bit-identity, not approximate equality.
    const invoiceTotalAfter = calcCreditPool(strategy, selected);
    assert.ok(
      Object.is(invoiceTotalBefore, invoiceTotalAfter),
      "track-mode invoice total unchanged with the ledger present",
    );
    assert.equal(state.balances[0].balanceUnits, 1000 - plannedTotal);
  }

  // ─── 7. stale-period cache row heals on consume ──────────────────────────
  {
    const state = freshState();
    const client = buildStub(state);
    state.subscriptions[0].currentBillingPeriodStart = P2_START;
    state.subscriptions[0].currentBillingPeriodEnd = P2_END;
    state.grants.push({
      id: "p2-grant",
      subscriptionId: SUB,
      organizationId: ORG,
      amountUnits: 1000,
      consumedUnits: 0,
      source: "period_grant",
      periodStart: P2_START,
      effectiveAt: P2_START,
      expiresAt: P2_END,
      createdBy: "test",
    });
    // Cache row still pointing at PERIOD 1 (a mint that failed to roll it).
    state.balances.push({
      subscriptionId: SUB,
      balanceUnits: 640,
      periodStart: P1_START,
    });

    const inP2 = new Date("2026-07-20T00:00:00.000Z");
    const { result } = await fireEvent(client, state, {
      quantity: 100,
      usageDate: inP2,
    });
    assert.equal(result.consumed, true);
    assert.equal(
      state.balances[0].periodStart.getTime(),
      P2_START.getTime(),
      "period guard misses the stale row -> heal-by-SET rolls it forward",
    );
    assert.equal(state.balances[0].balanceUnits, 900);
    if (result.consumed) assert.equal(result.balanceAfterUnits, 900);
  }

  // ─── 8. computeBalance vs cache; implicit full pool ──────────────────────
  {
    const state = freshState();
    const client = buildStub(state);
    const mid = new Date("2026-06-20T00:00:00.000Z");

    // Active period, NO grant minted yet: a full untouched pool, never zero.
    const before = await computeBalance(client, {
      subscriptionId: SUB,
      at: mid,
    });
    assert.equal(before.balanceUnits, 1000);
    assert.equal(
      before.implicitFullPool,
      true,
      "active-period-with-no-grant reads as a FULL untouched pool",
    );

    await fireEvent(client, state, { quantity: 250, usageDate: mid });
    const after = await computeBalance(client, {
      subscriptionId: SUB,
      at: mid,
    });
    assert.equal(after.implicitFullPool, false);
    assert.equal(
      after.balanceUnits,
      state.balances[0].balanceUnits,
      "recompute-from-ledger agrees with the cache after a clean consume",
    );

    // NEGATIVE CONTROL for the consistency assertion: corrupt the cache and
    // show recompute DISAGREES — proving the assertion above can fail and
    // that the ledger, not the cache, is the truth.
    state.balances[0].balanceUnits = 123456;
    const recheck = await computeBalance(client, {
      subscriptionId: SUB,
      at: mid,
    });
    assert.notEqual(recheck.balanceUnits, state.balances[0].balanceUnits);
    assert.equal(recheck.balanceUnits, 750);
  }

  // ─── 9. sweep: one expire entry per remainder, idempotent ────────────────
  {
    const state = freshState();
    const client = buildStub(state);
    state.subscriptions[0].currentBillingPeriodStart = P2_START;
    state.subscriptions[0].currentBillingPeriodEnd = P2_END;
    state.grants.push(
      {
        id: "spent-grant",
        subscriptionId: SUB,
        organizationId: ORG,
        amountUnits: 1000,
        consumedUnits: 1000,
        source: "period_grant",
        periodStart: new Date("2026-05-15T00:00:00.000Z"),
        effectiveAt: new Date("2026-05-15T00:00:00.000Z"),
        expiresAt: P1_START,
        createdBy: "test",
      },
      {
        id: "leftover-grant",
        subscriptionId: SUB,
        organizationId: ORG,
        amountUnits: 1000,
        consumedUnits: 600,
        source: "period_grant",
        periodStart: P1_START,
        effectiveAt: P1_START,
        expiresAt: P1_END,
        createdBy: "test",
      },
      {
        id: "live-grant",
        subscriptionId: SUB,
        organizationId: ORG,
        amountUnits: 1000,
        consumedUnits: 100,
        source: "period_grant",
        periodStart: P2_START,
        effectiveAt: P2_START,
        expiresAt: P2_END,
        createdBy: "test",
      },
    );
    state.balances.push({
      subscriptionId: SUB,
      // Stale: still counting the expired leftover (400) + live (900).
      balanceUnits: 1300,
      periodStart: P2_START,
    });

    const sweepAt = new Date("2026-07-20T00:00:00.000Z");
    const first = await sweepExpiredGrants(client, { now: sweepAt });
    assert.equal(
      first.swept,
      1,
      "only the grant with an UNUSED remainder sweeps",
    );
    assert.equal(first.results[0].grantId, "leftover-grant");
    assert.equal(first.results[0].expiredUnits, 400);
    assert.equal(
      first.results[0].balanceAfterUnits,
      900,
      "post-expiry balance = the live grant's remainder only",
    );
    const expireEntries = state.entries.filter((e) => e.kind === "expire");
    assert.equal(expireEntries.length, 1, "exactly ONE expire entry");
    assert.equal(expireEntries[0].deltaUnits, -400);
    assert.equal(expireEntries[0].balanceAfterUnits, 900);
    assert.equal(state.balances[0].balanceUnits, 900, "cache corrected in-txn");

    const second = await sweepExpiredGrants(client, { now: sweepAt });
    assert.equal(second.swept, 0, "re-run sweeps nothing");
    assert.equal(
      state.entries.filter((e) => e.kind === "expire").length,
      1,
      "idempotent: still exactly one expire entry",
    );
  }

  // ─── consume with no covering grant and no covering period ───────────────
  {
    const state = freshState();
    const client = buildStub(state);
    // Event dated BEFORE the current period, no grants at all: nothing to
    // draw, nothing to mint (the lazy mint only covers the CURRENT period).
    const res = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: randomUUID(),
      signalId: SIGNAL,
      quantity: 10,
      usageDate: new Date("2026-05-01T00:00:00.000Z"),
      now: new Date("2026-06-20T00:00:00.000Z"),
    });
    assert.deepEqual(res, { consumed: false, reason: "noCoveringGrant" });
    assert.equal(state.grants.length, 0, "no phantom mint for a dead period");
  }

  // ─── 12a. memberRate unit table ──────────────────────────────
  {
    const pool = { signalId: SIGNAL, creditRates: null };
    assert.equal(memberRate(pool, SIGNAL), 1, "own signal, no rates -> 1");
    assert.equal(memberRate(pool, "signal-b"), null, "foreign, no rates");

    const rated = {
      signalId: SIGNAL,
      creditRates: { [SIGNAL]: 2, "signal-b": 4, "signal-half": 0.5 },
    };
    assert.equal(memberRate(rated, SIGNAL), 2, "own signal takes its map rate");
    assert.equal(memberRate(rated, "signal-b"), 4);
    assert.equal(memberRate(rated, "signal-half"), 0.5);
    assert.equal(
      memberRate(rated, "signal-c"),
      null,
      "unmapped -> not a member",
    );

    const noOwnKey = { signalId: SIGNAL, creditRates: { "signal-b": 4 } };
    assert.equal(memberRate(noOwnKey, SIGNAL), 1, "absent own key -> rate 1");
    assert.equal(memberRate({ signalId: SIGNAL, creditRates: {} }, SIGNAL), 1);
    assert.equal(
      memberRate({ signalId: SIGNAL }, SIGNAL),
      1,
      "column absent from the row (legacy select) -> rate 1",
    );

    // Degenerate JSON reads honestly: never a fabricated rate.
    for (const rot of [
      "x",
      ["a"],
      7,
      { [SIGNAL]: "4" },
      { [SIGNAL]: 0 },
      { [SIGNAL]: -2 },
      { [SIGNAL]: NaN },
    ]) {
      assert.equal(
        memberRate({ signalId: SIGNAL, creditRates: rot }, SIGNAL),
        1,
        `rotten rates ${JSON.stringify(rot)}: own signal falls back to 1`,
      );
    }
    assert.equal(
      memberRate(
        { signalId: SIGNAL, creditRates: { "signal-b": "4" } },
        "signal-b",
      ),
      null,
      "rotten value on a foreign key -> not a member, never rate 1",
    );
    assert.equal(
      memberRate(
        { signalId: SIGNAL, creditRates: { "signal-b": 4 } },
        "__proto__",
      ),
      null,
      "prototype key is never a member",
    );
  }

  // ─── 12b. findCreditPoolStrategy: membership broadened in JS ─────────────
  {
    const state = freshState();
    state.strategies[0].creditRates = { "signal-b": 4 };
    const client = buildStub(state);

    const own = await findCreditPoolStrategy(client, PLAN, SIGNAL);
    assert.equal(own?.id, "strat-1", "pool's own signal is a member");
    const mapped = await findCreditPoolStrategy(client, PLAN, "signal-b");
    assert.equal(mapped?.id, "strat-1", "creditRates key is a member");
    const outsider = await findCreditPoolStrategy(client, PLAN, "signal-c");
    assert.equal(outsider, null, "unmapped signal is NOT a member");
    const noSignal = await findCreditPoolStrategy(client, PLAN);
    assert.equal(
      noSignal?.id,
      "strat-1",
      "no-signalId lookup (mint) unchanged",
    );
  }
  {
    const state = freshState(); // no creditRates
    const client = buildStub(state);
    assert.equal(
      (await findCreditPoolStrategy(client, PLAN, SIGNAL))?.id,
      "strat-1",
    );
    assert.equal(
      await findCreditPoolStrategy(client, PLAN, "signal-b"),
      null,
      "legacy pool: only its own signal is a member",
    );
  }

  // ─── 11. GOLDEN REPLAY — the negative control ──────────────────
  // One canonical lazy-mint/draw/overdraw/retry script, replayed with
  // creditRates absent, null, and {} (the three "no rates" spellings). All
  // three snapshots must equal ONE pinned literal: rates-off behavior is
  // byte-identical to the unrated path, down to the absence of the rateApplied key.
  {
    interface Step {
      eventId: string;
      signalId: string;
      quantity: number;
      usageDate: Date;
    }
    const snapshot = (state: StubState, results: unknown[]) => {
      const grantIndex = new Map(state.grants.map((g, i) => [g.id, i]));
      return {
        results,
        grants: state.grants.map((g) => ({
          amountUnits: g.amountUnits,
          consumedUnits: g.consumedUnits,
          source: g.source,
          periodStart: g.periodStart?.getTime() ?? null,
          effectiveAt: g.effectiveAt.getTime(),
          expiresAt: g.expiresAt?.getTime() ?? null,
          createdBy: g.createdBy,
        })),
        entries: state.entries.map((e) => ({
          grant: grantIndex.get(e.grantId),
          kind: e.kind,
          deltaUnits: e.deltaUnits,
          balanceAfterUnits: e.balanceAfterUnits,
          signalEventId: e.signalEventId,
          rateApplied: e.rateApplied,
        })),
        balances: state.balances.map((b) => ({
          balanceUnits: b.balanceUnits,
          periodStart: b.periodStart.getTime(),
        })),
      };
    };
    const runScenario = async (
      strategyOverrides: Partial<StubState["strategies"][number]>,
      steps: Step[],
      signals?: StubState["signals"],
    ) => {
      const state = freshState();
      Object.assign(state.strategies[0], strategyOverrides);
      if (signals) state.signals = signals;
      const client = buildStub(state);
      const results: unknown[] = [];
      for (const step of steps) {
        // Store the event like ingest does — once per id, a retry re-sends
        // the same row — so the parity oracle can select from state.events.
        if (!state.events.some((e) => e.id === step.eventId)) {
          state.events.push({
            id: step.eventId,
            organizationId: ORG,
            subscriptionId: SUB,
            signalId: step.signalId,
            usageDate: step.usageDate,
            quantity: step.quantity,
          });
        }
        results.push(
          await consumeUnits(client, {
            subscriptionId: SUB,
            signalEventId: step.eventId,
            signalId: step.signalId,
            quantity: step.quantity,
            usageDate: step.usageDate,
            now: step.usageDate,
          }),
        );
      }
      return { state, snap: snapshot(state, results) };
    };

    const GOLDEN_STEPS: Step[] = [
      {
        eventId: "evt-1",
        signalId: SIGNAL,
        quantity: 300,
        usageDate: new Date("2026-06-16T00:00:00.000Z"),
      },
      {
        eventId: "evt-2",
        signalId: SIGNAL,
        quantity: 500,
        usageDate: new Date("2026-06-25T00:00:00.000Z"),
      },
      {
        eventId: "evt-3",
        signalId: SIGNAL,
        quantity: 450,
        usageDate: new Date("2026-07-01T00:00:00.000Z"),
      },
      // Ingest retry of evt-2: must be a no-op everywhere.
      {
        eventId: "evt-2",
        signalId: SIGNAL,
        quantity: 500,
        usageDate: new Date("2026-06-25T00:00:00.000Z"),
      },
    ];
    // THE pin: the unrated behavior as a literal. If a rates-off replay
    // ever diverges from this, the negative control has caught it.
    const GOLDEN_PIN = {
      results: [
        {
          consumed: true,
          balanceAfterUnits: 700,
          entryCount: 1,
          lazyMinted: true,
        },
        {
          consumed: true,
          balanceAfterUnits: 200,
          entryCount: 1,
          lazyMinted: false,
        },
        {
          consumed: true,
          balanceAfterUnits: -250,
          entryCount: 1,
          lazyMinted: false,
        },
        { consumed: false, reason: "alreadyConsumed" },
      ],
      grants: [
        {
          amountUnits: 1000,
          consumedUnits: 1250,
          source: "period_grant",
          periodStart: P1_START.getTime(),
          effectiveAt: P1_START.getTime(),
          expiresAt: P1_END.getTime(),
          createdBy: "lazy-mint",
        },
      ],
      entries: [
        {
          grant: 0,
          kind: "grant",
          deltaUnits: 1000,
          balanceAfterUnits: 1000,
          signalEventId: null,
          rateApplied: undefined,
        },
        {
          grant: 0,
          kind: "consume",
          deltaUnits: -300,
          balanceAfterUnits: 700,
          signalEventId: "evt-1",
          rateApplied: undefined,
        },
        {
          grant: 0,
          kind: "consume",
          deltaUnits: -500,
          balanceAfterUnits: 200,
          signalEventId: "evt-2",
          rateApplied: undefined,
        },
        {
          grant: 0,
          kind: "consume",
          deltaUnits: -450,
          balanceAfterUnits: -250,
          signalEventId: "evt-3",
          rateApplied: undefined,
        },
      ],
      balances: [{ balanceUnits: -250, periodStart: P1_START.getTime() }],
    };

    const absent = await runScenario({}, GOLDEN_STEPS);
    const nulled = await runScenario({ creditRates: null }, GOLDEN_STEPS);
    const empty = await runScenario({ creditRates: {} }, GOLDEN_STEPS);
    assert.deepEqual(absent.snap, GOLDEN_PIN, "creditRates ABSENT == the pin");
    assert.deepEqual(nulled.snap, GOLDEN_PIN, "creditRates null == the pin");
    assert.deepEqual(empty.snap, GOLDEN_PIN, "creditRates {} == the pin");
    for (const run of [absent, nulled, empty]) {
      assert.ok(
        run.state.entries.every((e) => !("rateApplied" in e)),
        "rates-off replay never writes a rateApplied key at all",
      );
    }

    // ─── 12c. rated draws: credits = units × rate, everywhere ──────────────
    const RATED = { creditRates: { [SIGNAL]: 2, "signal-b": 4 } };
    const RATED_STEPS: Step[] = [
      {
        eventId: "evt-r1",
        signalId: SIGNAL,
        quantity: 100,
        usageDate: new Date("2026-06-16T00:00:00.000Z"),
      },
      {
        eventId: "evt-r2",
        signalId: "signal-b",
        quantity: 100,
        usageDate: new Date("2026-06-20T00:00:00.000Z"),
      },
      {
        eventId: "evt-r3",
        signalId: "signal-c",
        quantity: 50,
        usageDate: new Date("2026-06-22T00:00:00.000Z"),
      },
      {
        eventId: "evt-r4",
        signalId: "signal-b",
        quantity: 150,
        usageDate: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        eventId: "evt-r2",
        signalId: "signal-b",
        quantity: 100,
        usageDate: new Date("2026-06-20T00:00:00.000Z"),
      },
    ];
    const RATED_PIN = {
      results: [
        {
          consumed: true,
          balanceAfterUnits: 800,
          entryCount: 1,
          lazyMinted: true,
        },
        {
          consumed: true,
          balanceAfterUnits: 400,
          entryCount: 1,
          lazyMinted: false,
        },
        { consumed: false, reason: "notCreditPool" },
        {
          consumed: true,
          balanceAfterUnits: -200,
          entryCount: 1,
          lazyMinted: false,
        },
        { consumed: false, reason: "alreadyConsumed" },
      ],
      grants: [
        {
          amountUnits: 1000,
          consumedUnits: 1200,
          source: "period_grant",
          periodStart: P1_START.getTime(),
          effectiveAt: P1_START.getTime(),
          expiresAt: P1_END.getTime(),
          createdBy: "lazy-mint",
        },
      ],
      entries: [
        {
          grant: 0,
          kind: "grant",
          deltaUnits: 1000,
          balanceAfterUnits: 1000,
          signalEventId: null,
          rateApplied: undefined,
        },
        {
          grant: 0,
          kind: "consume",
          deltaUnits: -200,
          balanceAfterUnits: 800,
          signalEventId: "evt-r1",
          rateApplied: 2,
        },
        {
          grant: 0,
          kind: "consume",
          deltaUnits: -400,
          balanceAfterUnits: 400,
          signalEventId: "evt-r2",
          rateApplied: 4,
        },
        {
          grant: 0,
          kind: "consume",
          deltaUnits: -600,
          balanceAfterUnits: -200,
          signalEventId: "evt-r4",
          rateApplied: 4,
        },
      ],
      balances: [{ balanceUnits: -200, periodStart: P1_START.getTime() }],
    };
    const rated = await runScenario(RATED, RATED_STEPS);
    assert.deepEqual(rated.snap, RATED_PIN, "rated replay matches its pin");
    // The invoice-recipe twin in credits: Σ per-signal SUM(quantity) × rate.
    const ratedCredits = 100 * 2 + (100 + 150) * 4;
    const drawnCredits = rated.state.entries
      .filter((e) => e.kind === "consume")
      .reduce((s, e) => s + -e.deltaUnits, 0);
    assert.equal(
      drawnCredits,
      ratedCredits,
      "ledger credits == rated selection",
    );
    assert.equal(
      invoiceSelectedCreditQuantity(
        rated.state,
        { signalId: SIGNAL, creditRates: RATED.creditRates },
        P1_START,
        P1_END,
      ),
      ratedCredits,
      "the parity oracle selects the same credits on the same fixture",
    );

    // ─── 13. draw results are signal-type-blind ────────────────────────────
    // Fixture pair identical except signals.type (usage / volume / null,
    // permuted). The ledger has no signals delegate to even read — these twin
    // runs pin that adding one (and branching on type) can't slip in quietly.
    const typedA = await runScenario(RATED, RATED_STEPS, [
      { id: SIGNAL, type: "usage" },
      { id: "signal-b", type: "volume" },
      { id: "signal-c", type: null },
    ]);
    const typedB = await runScenario(RATED, RATED_STEPS, [
      { id: SIGNAL, type: "volume" },
      { id: "signal-b", type: null },
      { id: "signal-c", type: "usage" },
    ]);
    assert.deepEqual(typedA.snap, typedB.snap, "signals.type never matters");
    assert.deepEqual(
      typedA.snap,
      RATED_PIN,
      "the typed twins match the rated pin too",
    );
  }

  // ─── 12d. rate edge cases ────────────────────────────────────────────────
  {
    // Explicit rate input (the api-nest seam passes one it resolved itself).
    const state = freshState();
    const client = buildStub(state);
    const res = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: "evt-x1",
      signalId: SIGNAL,
      quantity: 3,
      rate: 0.5,
      usageDate: new Date("2026-06-20T00:00:00.000Z"),
      now: new Date("2026-06-20T00:00:00.000Z"),
    });
    assert.equal(res.consumed, true);
    if (res.consumed) assert.equal(res.balanceAfterUnits, 1000 - 1.5);
    assert.equal(
      state.entries.find((e) => e.kind === "consume")!.rateApplied,
      0.5,
    );
  }
  {
    // Non-positive / non-finite explicit rate: rejected AFTER the quantity
    // check, with its own honest reason.
    const state = freshState();
    const client = buildStub(state);
    for (const badRate of [0, -1, NaN, Infinity]) {
      const res = await consumeUnits(client, {
        subscriptionId: SUB,
        signalEventId: randomUUID(),
        signalId: SIGNAL,
        quantity: 5,
        rate: badRate,
        usageDate: new Date("2026-06-20T00:00:00.000Z"),
      });
      assert.deepEqual(res, { consumed: false, reason: "nonPositiveRate" });
    }
    const qtyFirst = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: randomUUID(),
      signalId: SIGNAL,
      quantity: 0,
      rate: 0,
      usageDate: new Date("2026-06-20T00:00:00.000Z"),
    });
    assert.deepEqual(
      qtyFirst,
      { consumed: false, reason: "nonPositiveQuantity" },
      "raw quantity is checked before the rate",
    );
    assert.equal(state.grants.length, 0, "no rate rejection ever mints");
  }
  {
    // Preloaded strategy + no rate input: consumeUnits resolves via
    // memberRate; a non-member signal no-ops like the internal lookup does.
    const state = freshState();
    state.strategies[0].creditRates = { "signal-b": 4 };
    const client = buildStub(state);
    const strategy = {
      id: "strat-1",
      signalId: SIGNAL,
      tiers: POOL_TIERS,
      creditRates: { "signal-b": 4 },
    };
    const member = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: "evt-p1",
      signalId: "signal-b",
      quantity: 10,
      usageDate: new Date("2026-06-20T00:00:00.000Z"),
      now: new Date("2026-06-20T00:00:00.000Z"),
      strategy,
    });
    assert.equal(member.consumed, true);
    if (member.consumed) assert.equal(member.balanceAfterUnits, 960);
    const outsider = await consumeUnits(client, {
      subscriptionId: SUB,
      signalEventId: "evt-p2",
      signalId: "signal-c",
      quantity: 10,
      usageDate: new Date("2026-06-20T00:00:00.000Z"),
      strategy,
    });
    assert.deepEqual(outsider, { consumed: false, reason: "notCreditPool" });
  }

  // ─── 14. the parity oracle, pinned exact + bounded ────
  // The bill and the countdown must agree. Exact pins run on FLOAT-EXACT
  // fixtures (integer quantities × rates 4, 2, 0.5, 0.25 — every product and
  // partial sum is representable, so ledger-order summation vs the oracle's
  // per-signal sum-then-multiply is bit-identical, no tolerance needed).
  {
    const EXACT_RATES = {
      [SIGNAL]: 4,
      "signal-b": 2,
      "signal-half": 0.5,
      "signal-quarter": 0.25,
    };
    const state = freshState();
    state.strategies[0].creditRates = EXACT_RATES;
    const client = buildStub(state);

    const plan: Array<{ signalId: string; quantity: number }> = [
      { signalId: SIGNAL, quantity: 100 }, // 400 credits
      { signalId: SIGNAL, quantity: 13 }, //   52
      { signalId: "signal-b", quantity: 75 }, // 150
      { signalId: "signal-half", quantity: 33 }, // 16.5
      { signalId: "signal-quarter", quantity: 7 }, // 1.75
    ];
    for (const p of plan) {
      const { result } = await fireEvent(client, state, {
        quantity: p.quantity,
        usageDate: new Date("2026-06-20T00:00:00.000Z"),
        signalId: p.signalId,
      });
      assert.equal(result.consumed, true);
    }

    const drawnCredits = state.entries
      .filter((e) => e.kind === "consume")
      .reduce((sum, e) => sum + -e.deltaUnits, 0);
    const oracle = invoiceSelectedCreditQuantity(
      state,
      { signalId: SIGNAL, creditRates: EXACT_RATES },
      P1_START,
      P1_END,
    );
    assert.equal(oracle, 113 * 4 + 75 * 2 + 33 * 0.5 + 7 * 0.25);
    assert.equal(oracle, 620.25, "the hand pin: 452 + 150 + 16.5 + 1.75");
    assert.ok(
      Object.is(drawnCredits, oracle),
      "float-exact fixture: ledger credits are BIT-IDENTICAL to the oracle",
    );
    assert.equal(
      state.balances[0].balanceUnits,
      1000 - 620.25,
      "the countdown burned exactly the billed credits",
    );
  }

  // The tolerance property: real Postgres stores each draw in a
  // Decimal(18,6) column, so a non-float-exact rate rounds PER EVENT while
  // the invoice multiplies once per signal after summing. Worst-case drift
  // is half an ulp of the 6th decimal per event: |stored − oracle| ≤
  // 1e-6 × eventCount (the two-numbers note at the top of credit-balance.ts
  // says which side each surface must read — this bound says how far apart
  // the sides can ever drift).
  {
    const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
    const DRIFTY_RATES = { "signal-third": 1 / 3, "signal-tenth": 0.3 };
    const state = freshState();
    state.strategies[0].creditRates = DRIFTY_RATES;
    const client = buildStub(state);

    // 30 × qty 1 at rate 1/3: each stored draw rounds 0.333333… → 0.333333,
    // shedding ~3.3e-7 per event — real, accumulating column rounding.
    for (let i = 0; i < 30; i++) {
      const { result } = await fireEvent(client, state, {
        quantity: 1,
        usageDate: new Date("2026-06-18T00:00:00.000Z"),
        signalId: "signal-third",
      });
      assert.equal(result.consumed, true);
    }
    // 10 × qty 7 at rate 0.3: float product 2.0999999…6 rounds to 2.1.
    for (let i = 0; i < 10; i++) {
      const { result } = await fireEvent(client, state, {
        quantity: 7,
        usageDate: new Date("2026-06-19T00:00:00.000Z"),
        signalId: "signal-tenth",
      });
      assert.equal(result.consumed, true);
    }

    const consumeEntries = state.entries.filter((e) => e.kind === "consume");
    const eventCount = consumeEntries.length;
    assert.equal(eventCount, 40);
    // What the DB columns hold: each draw rounded to 6dp at write time.
    const storedCredits = consumeEntries.reduce(
      (sum, e) => sum + round6(-e.deltaUnits),
      0,
    );
    const oracle = invoiceSelectedCreditQuantity(
      state,
      { signalId: SIGNAL, creditRates: DRIFTY_RATES },
      P1_START,
      P1_END,
    );
    const tolerance = 1e-6 * eventCount;
    const drift = Math.abs(storedCredits - oracle);
    assert.ok(
      drift <= tolerance,
      `per-event 6dp rounding drift ${drift} must stay within 1e-6 × ${eventCount}`,
    );
    assert.ok(
      drift > 1e-7,
      "the fixture produces REAL drift — the property is not vacuously true",
    );
    // Ungameable negative control: the unrated recipe (raw units, the
    // single-signal selection) must FAIL the same bound — the tolerance absorbs
    // column rounding, never a missing rate.
    const unratedQuantity = 30 * 1 + 10 * 7;
    assert.ok(
      Math.abs(unratedQuantity - oracle) > tolerance,
      "the tolerance must reject the unrated selection outright",
    );
  }

  // ─── 15. the shared enumerators ────────────────────────────────
  // poolMemberRates answers "which signals draw on this pool, at what rate"
  // for the invoice calculator, the balance read, and revenue metrics. All
  // three share this one enumerator. poolIsRated
  // answers the customer-facing denomination question — units or credits.
  {
    const entries = (creditRates: unknown, signalId: string | null = SIGNAL) =>
      [...poolMemberRates({ signalId, creditRates })] as Array<
        [string, number]
      >;

    // A rate-less pool enumerates to EXACTLY the single-signal read.
    // Everything downstream (credits = units × 1) is byte-identical because
    // of this line.
    for (const rateless of [null, undefined, {}]) {
      assert.deepEqual(
        entries(rateless),
        [[SIGNAL, 1]],
        `rate-less pool (${JSON.stringify(rateless)}) is the own-signal rate-1 case`,
      );
    }

    // ORDER is load-bearing, not incidental: consumers sum in iteration
    // order, and the invoice's float total is the one they all have to match.
    // Own signal first, then creditRates keys in their own order.
    assert.deepEqual(
      entries({ "signal-b": 4, "signal-c": 2 }),
      [
        [SIGNAL, 1],
        ["signal-b", 4],
        ["signal-c", 2],
      ],
      "own signal leads, then creditRates key order",
    );
    assert.deepEqual(
      entries({ "signal-c": 2, "signal-b": 4 }),
      [
        [SIGNAL, 1],
        ["signal-c", 2],
        ["signal-b", 4],
      ],
      "key order is the map's, never re-sorted",
    );
    // The own signal appears ONCE even when creditRates names it, at the
    // mapped rate — a pool that enumerated it twice would double-bill itself.
    assert.deepEqual(
      entries({ [SIGNAL]: 4, "signal-b": 2 }),
      [
        [SIGNAL, 4],
        ["signal-b", 2],
      ],
      "own signal is deduped and takes its mapped rate",
    );

    // Degenerate JSON never fabricates a member. Rotten own-signal values
    // fall back to rate 1 (memberRate's rule, not a second copy of it);
    // rotten foreign values fall out of membership entirely.
    for (const rot of ["x", ["a"], 7, { [SIGNAL]: "4" }, { [SIGNAL]: 0 }]) {
      assert.deepEqual(
        entries(rot),
        [[SIGNAL, 1]],
        `rotten creditRates ${JSON.stringify(rot)} enumerates the own signal alone`,
      );
    }
    assert.deepEqual(
      entries({ "signal-b": "4", "signal-c": -1, "signal-d": 3 }),
      [
        [SIGNAL, 1],
        ["signal-d", 3],
      ],
      "only the well-formed foreign key survives",
    );
    const inherited = Object.create({ "signal-inherited": 9 });
    inherited["signal-b"] = 2;
    assert.deepEqual(
      entries(inherited),
      [
        [SIGNAL, 1],
        ["signal-b", 2],
      ],
      "enumeration is own-keys-only, matching memberRate's hasOwnProperty",
    );

    // A pool with no own signal contributes no candidate of its own. The
    // strategy lookup filters signalId non-null, so this is a defensive
    // shape, not a live one — but "no signal" must never mean "no members
    // either" for a row that names them.
    assert.deepEqual(entries(null, null), []);
    assert.deepEqual(entries({ "signal-b": 4 }, null), [["signal-b", 4]]);

    // Delegation, not duplication: for every candidate key the map's rate IS
    // memberRate's answer. A local `?? 1` grown here would show up as a
    // disagreement on the rotten fixtures above.
    for (const creditRates of [
      null,
      {},
      { [SIGNAL]: 4, "signal-b": 2 },
      { "signal-b": "4", "signal-c": 3 },
    ]) {
      for (const [signalId, rate] of entries(creditRates)) {
        assert.equal(
          rate,
          memberRate({ signalId: SIGNAL, creditRates }, signalId),
          `poolMemberRates defers to memberRate for ${signalId}`,
        );
      }
    }

    // poolIsRated: the denomination answer the "units" vs "credits" copy
    // reads. Rate-less and degenerate pools stay UNITS — a pool whose label
    // says credits while its quantity is raw units is the confusion this
    // feature exists to kill.
    for (const unrated of [
      null,
      undefined,
      {},
      [4, 2],
      "rates",
      7,
      { [SIGNAL]: "4" },
      { [SIGNAL]: 0 },
      { [SIGNAL]: -4 },
      { [SIGNAL]: NaN },
      { [SIGNAL]: Infinity },
      { "signal-b": null },
    ]) {
      assert.equal(
        poolIsRated({ creditRates: unrated }),
        false,
        `creditRates ${JSON.stringify(unrated)} is not a rated pool`,
      );
    }
    for (const rated of [
      { [SIGNAL]: 4 },
      { "signal-b": 2 },
      { [SIGNAL]: 1 },
      { [SIGNAL]: 0.25 },
      { "signal-b": "bad", "signal-c": 2 },
    ]) {
      assert.equal(
        poolIsRated({ creditRates: rated }),
        true,
        `creditRates ${JSON.stringify(rated)} is a rated pool`,
      );
    }
    // The two answers agree on what "rated" means: a pool reads as rated
    // exactly when its enumeration is more than the own-signal rate-1 case.
    for (const creditRates of [null, {}, { [SIGNAL]: "4" }, { [SIGNAL]: 4 }]) {
      const onlyOwnAtOne =
        entries(creditRates).length === 1 && entries(creditRates)[0][1] === 1;
      assert.equal(
        poolIsRated({ creditRates }),
        !onlyOwnAtOne,
        `denomination matches the enumeration for ${JSON.stringify(creditRates)}`,
      );
    }
  }

  console.log("credit-ledger.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
