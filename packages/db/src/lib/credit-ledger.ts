/**
 * credit-ledger.ts: the ONE credit-pool ledger
 * path: mint, consume, recompute, sweep. Track-only: nothing here gates
 * ingest, and invoice math never reads these tables (calcCreditPool in
 * revenue-calc.ts stays the only biller).
 *
 * The model: `credit_grants` are buckets of units; `credit_ledger_entries` is
 * the append-only movement log; `credit_pool_balances` is a per-subscription
 * cache that is an OPTIMIZATION, never truth — created by upsert on first
 * consume and at mint, never assumed to exist.
 *
 * Denomination is USAGE UNITS — the event's billable quantity, the same
 * number the invoice bills (invoice-calculator selection recipe). Never
 * dollars, never usageCost.
 *
 * Concurrency stance: NO claim-or-abort CAS. The consume
 * path upserts the cache row and decrements it atomically with the period
 * guard in the WHERE; the row lock serializes concurrent consumes, and
 * `balanceAfterUnits` is read from the updated row inside the same
 * transaction as the ledger append.
 */

import { toNumber } from "./revenue-calc";

/**
 * The slices of a Prisma client this module touches. Deliberately structural
 * (the CoverageQueryClient pattern, spend-coverage.ts) so api-nest's
 * PrismaService and the dashboard's client both satisfy
 * it with no cast.
 */
export interface CreditLedgerTxClient {
  subscriptions: {
    // Foot-gun: method syntax + open args are load-bearing — narrowing to
    // arrow props or literal arg types breaks assignability for one of the
    // two concrete Prisma clients (see the client interface in spend-coverage.ts).
    findUnique(args?: unknown): Promise<unknown>;
  };
  pricing_strategies: {
    findFirst(args?: unknown): Promise<unknown>;
  };
  credit_grants: {
    findMany(args?: unknown): Promise<unknown[]>;
    findFirst(args?: unknown): Promise<unknown>;
    create(args?: unknown): Promise<unknown>;
    update(args?: unknown): Promise<unknown>;
  };
  credit_ledger_entries: {
    findFirst(args?: unknown): Promise<unknown>;
    create(args?: unknown): Promise<unknown>;
  };
  credit_pool_balances: {
    findUnique(args?: unknown): Promise<unknown>;
    upsert(args?: unknown): Promise<unknown>;
    updateMany(args?: unknown): Promise<{ count: number }>;
  };
}

export interface CreditLedgerClient extends CreditLedgerTxClient {
  $transaction<T>(
    fn: (tx: CreditLedgerTxClient) => Promise<T>,
    options?: unknown,
  ): Promise<T>;
}

/** The subscription fields every entry point needs. */
export interface CreditPoolSubscriptionRow {
  id: string;
  organizationId: string | null;
  planId: string;
  currentBillingPeriodStart: Date | null;
  currentBillingPeriodEnd: Date | null;
}

/** The pricing-strategy fields the pool math needs. */
export interface CreditPoolStrategyRow {
  id: string;
  signalId: string | null;
  tiers: unknown;
  /** {signalId: creditsPerUnit}. Absent/null = single-metric pool. */
  creditRates?: unknown;
}

interface GrantRow {
  id: string;
  subscriptionId: string;
  amountUnits: unknown;
  consumedUnits: unknown;
  periodStart: Date | null;
  effectiveAt: Date;
  expiresAt: Date | null;
}

const SUBSCRIPTION_SELECT = {
  id: true,
  organizationId: true,
  planId: true,
  currentBillingPeriodStart: true,
  currentBillingPeriodEnd: true,
} as const;

const GRANT_SELECT = {
  id: true,
  subscriptionId: true,
  amountUnits: true,
  consumedUnits: true,
  periodStart: true,
  effectiveAt: true,
  expiresAt: true,
} as const;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

async function loadSubscription(
  client: CreditLedgerTxClient,
  subscriptionId: string,
): Promise<CreditPoolSubscriptionRow | null> {
  const row = (await client.subscriptions.findUnique({
    where: { id: subscriptionId },
    select: SUBSCRIPTION_SELECT,
  })) as CreditPoolSubscriptionRow | null;
  return row ?? null;
}

/**
 * Membership + burn rate in one answer: how many pool credits one
 * unit of `signalId` burns on this pool strategy, or null when the signal is
 * not a pool member at all. The pool's own signal is always a member (rate 1
 * unless creditRates says otherwise); any other signal is a member only when
 * creditRates names it. Degenerate creditRates JSON (non-object, non-positive
 * or non-numeric value) reads as "no rate stored" — the pool's own signal
 * falls back to 1, a foreign key falls out of membership — never a fabricated
 * rate (the deriveCreditPool honest-null stance).
 */
export function memberRate(
  strategy: Pick<CreditPoolStrategyRow, "signalId" | "creditRates">,
  signalId: string,
): number | null {
  const rates =
    typeof strategy.creditRates === "object" &&
    strategy.creditRates !== null &&
    !Array.isArray(strategy.creditRates)
      ? (strategy.creditRates as Record<string, unknown>)
      : null;
  const raw =
    rates && Object.prototype.hasOwnProperty.call(rates, signalId)
      ? rates[signalId]
      : undefined;
  const rate =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
  if (signalId === strategy.signalId) return rate ?? 1;
  return rate;
}

/**
 * The pool's member signals with their credits-per-unit burn rates: the
 * pool's own signal plus every creditRates key, each resolved through
 * memberRate — degenerate creditRates JSON reads as non-membership, never a
 * fabricated rate. THE one member enumeration for every rated-pool consumer
 * (invoice calculator, credit-balance read path, revenue metrics). It lives
 * here so the consumers can't grow local twins.
 */
export function poolMemberRates(
  strategy: Pick<CreditPoolStrategyRow, "signalId" | "creditRates">,
): Map<string, number> {
  const candidates = new Set<string>();
  if (strategy.signalId) candidates.add(strategy.signalId);
  const rates = strategy.creditRates;
  if (rates && typeof rates === "object" && !Array.isArray(rates)) {
    for (const key of Object.keys(rates)) candidates.add(key);
  }
  const members = new Map<string, number>();
  for (const signalId of candidates) {
    const rate = memberRate(strategy, signalId);
    if (rate !== null) members.set(signalId, rate);
  }
  return members;
}

/**
 * True when the pool actually rates usage — creditRates carries at least one
 * positive finite rate — meaning the pool's quantity is denominated in
 * CREDITS. Rate-less pools (creditRates absent, null, {}, or rotten JSON)
 * keep unit denomination, byte-identical to the unrated path. Drives customer-facing
 * "units" vs "credits" copy, so both the api-nest simulator and the
 * dashboard action must call THIS predicate rather than growing twins that
 * drift.
 */
export function poolIsRated(
  strategy: Pick<CreditPoolStrategyRow, "creditRates">,
): boolean {
  const rates = strategy.creditRates;
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) return false;
  return Object.values(rates).some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

/**
 * The ONE credit-pool strategy lookup, filter-for-filter what the invoice
 * calculator bills from (active, not deleted, chargeType usage) narrowed to
 * pricingModel credit_pool. Any SQL backfill that picks pools must copy
 * these filters exactly. The signalId argument is a MEMBERSHIP question answered in
 * JS by memberRate, never a SQL filter: the pool draws for its own signal and
 * for every creditRates key.
 */
export async function findCreditPoolStrategy(
  client: CreditLedgerTxClient,
  planId: string,
  signalId?: string,
): Promise<CreditPoolStrategyRow | null> {
  const row = (await client.pricing_strategies.findFirst({
    where: {
      planId,
      pricingModel: "credit_pool",
      chargeType: "usage",
      active: true,
      deletedAt: null,
      signalId: { not: null },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, signalId: true, tiers: true, creditRates: true },
  })) as CreditPoolStrategyRow | null;
  if (!row) return null;
  if (signalId !== undefined && memberRate(row, signalId) === null) return null;
  return row;
}

/**
 * Pool size = the sorted-by-lower first tier's `upper` — exactly how
 * calcCreditPool (revenue-calc.ts) reads the pool, so the minted grant and
 * the invoice agree on what "the pool" is. Null when there is no bounded
 * pool tier (no tiers, or upper null = unbounded).
 */
export function poolSizeFromTiers(tiers: unknown): number | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const sorted = [...tiers].sort(
    (a, b) =>
      toNumber((a as { lower?: unknown })?.lower) -
      toNumber((b as { lower?: unknown })?.lower),
  );
  const upper = (sorted[0] as { upper?: unknown })?.upper;
  if (upper === null || upper === undefined) return null;
  const size = toNumber(upper);
  return size > 0 ? size : null;
}

/** Grants drawable at `at`: effective, and not yet expired at that instant. */
function drawableWhere(subscriptionId: string, at: Date) {
  return {
    subscriptionId,
    effectiveAt: { lte: at },
    OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
  };
}

async function drawableBalance(
  client: CreditLedgerTxClient,
  subscriptionId: string,
  at: Date,
): Promise<number> {
  const grants = (await client.credit_grants.findMany({
    where: drawableWhere(subscriptionId, at),
    select: { amountUnits: true, consumedUnits: true },
  })) as Array<{ amountUnits: unknown; consumedUnits: unknown }>;
  return grants.reduce(
    (sum, g) => sum + toNumber(g.amountUnits) - toNumber(g.consumedUnits),
    0,
  );
}

// ── mint ────────────────────────────────────────────────────────────────────

export interface MintPeriodGrantInput {
  subscriptionId: string;
  /** Attribution: 'dispatch:usage-invoice' | 'activation' | 'lazy-mint' | … */
  createdBy: string;
  /**
   * Preloaded subscription (id/org/plan/period). Activation passes the
   * just-computed period here because its caller-supplied transaction may not
   * have committed the row yet; when omitted the subscription is re-read.
   */
  subscription?: CreditPoolSubscriptionRow;
  /** Preloaded strategy (the lazy-mint path already holds it). */
  strategy?: CreditPoolStrategyRow;
  now?: Date;
}

export type MintPeriodGrantResult =
  | {
      minted: true;
      grantId: string;
      amountUnits: number;
      periodStart: Date;
      balanceAfterUnits: number;
    }
  | {
      minted: false;
      reason:
        | "subscriptionNotFound"
        | "noOrganization"
        | "noActivePeriod"
        | "notCreditPool"
        | "noPoolSize"
        | "alreadyMinted";
    };

/**
 * Mint the period grant for the subscription's CURRENT billing period.
 * Idempotent by the unique (subscriptionId, periodStart) key, whichever code
 * path advanced the period — dispatch post-commit, activation, or the lazy
 * consume-time safety net. Derives the amount from its OWN strategy lookup
 * (dispatch's due-query doesn't include pricing_strategies). Non-credit-pool
 * subscriptions no-op with `notCreditPool`.
 */
export async function mintPeriodGrant(
  client: CreditLedgerClient,
  input: MintPeriodGrantInput,
): Promise<MintPeriodGrantResult> {
  const now = input.now ?? new Date();
  const sub =
    input.subscription ??
    (await loadSubscription(client, input.subscriptionId));
  if (!sub) return { minted: false, reason: "subscriptionNotFound" };

  const periodStart = sub.currentBillingPeriodStart;
  const periodEnd = sub.currentBillingPeriodEnd;
  if (!periodStart || !periodEnd)
    return { minted: false, reason: "noActivePeriod" };
  if (!sub.organizationId) return { minted: false, reason: "noOrganization" };

  const strategy =
    input.strategy ?? (await findCreditPoolStrategy(client, sub.planId));
  if (!strategy) return { minted: false, reason: "notCreditPool" };

  const poolSize = poolSizeFromTiers(strategy.tiers);
  if (poolSize === null) return { minted: false, reason: "noPoolSize" };

  const existing = await client.credit_grants.findFirst({
    where: { subscriptionId: sub.id, periodStart },
    select: { id: true },
  });
  if (existing) return { minted: false, reason: "alreadyMinted" };

  try {
    return await client.$transaction(async (tx) => {
      const result = await mintInTx(tx, {
        subscription: sub,
        periodStart,
        periodEnd,
        poolSize,
        createdBy: input.createdBy,
        now,
      });
      return {
        minted: true as const,
        grantId: result.grantId,
        amountUnits: poolSize,
        periodStart,
        balanceAfterUnits: result.balanceAfterUnits,
      };
    });
  } catch (err) {
    // A concurrent mint winning the unique key IS the idempotency working.
    if (isUniqueViolation(err))
      return { minted: false, reason: "alreadyMinted" };
    throw err;
  }
}

/** The shared transactional mint body (mintPeriodGrant + the lazy path). */
async function mintInTx(
  tx: CreditLedgerTxClient,
  args: {
    subscription: CreditPoolSubscriptionRow;
    periodStart: Date;
    periodEnd: Date;
    poolSize: number;
    createdBy: string;
    now: Date;
  },
): Promise<{ grantId: string; balanceAfterUnits: number }> {
  const grant = (await tx.credit_grants.create({
    data: {
      subscriptionId: args.subscription.id,
      organizationId: args.subscription.organizationId,
      amountUnits: args.poolSize,
      consumedUnits: 0,
      source: "period_grant",
      periodStart: args.periodStart,
      effectiveAt: args.periodStart,
      expiresAt: args.periodEnd,
      createdBy: args.createdBy,
    },
  })) as { id: string };

  // Recompute-SET (not increment) so a rollover mint sheds the old period's
  // remainder from the cache instead of carrying it until the sweep runs.
  // Drawable-at-`now`: a grant with a FUTURE effectiveAt does not count and
  // seeds a 0-balance cache row. Every caller mints at the already-started
  // periodStart, so a caller that mints ahead needs a guard here first.
  const balanceAfterUnits = await drawableBalance(
    tx,
    args.subscription.id,
    args.now,
  );
  await tx.credit_ledger_entries.create({
    data: {
      grantId: grant.id,
      subscriptionId: args.subscription.id,
      kind: "grant",
      deltaUnits: args.poolSize,
      balanceAfterUnits,
      signalEventId: null,
    },
  });
  await tx.credit_pool_balances.upsert({
    where: { subscriptionId: args.subscription.id },
    create: {
      subscriptionId: args.subscription.id,
      balanceUnits: balanceAfterUnits,
      periodStart: args.periodStart,
    },
    update: { balanceUnits: balanceAfterUnits, periodStart: args.periodStart },
  });
  return { grantId: grant.id, balanceAfterUnits };
}

// ── consume ─────────────────────────────────────────────────────────────────

export interface ConsumeUnitsInput {
  subscriptionId: string;
  /** The stored signal_events row this draw traces to. */
  signalEventId: string;
  signalId: string;
  /** Billable quantity in usage units (the event's `quantity ?? 1`). */
  quantity: number;
  /**
   * Credits burned per usage unit. Resolved via memberRate from
   * the strategy when omitted. Deliberately read OUTSIDE the ledger
   * transaction: a concurrent rate edit mid-draw draws at the rate in force
   * when the event arrived, and the row's rateApplied keeps the audit honest.
   */
  rate?: number;
  /**
   * The event's usageDate — the draw lands in the period that will BILL the
   * event (the server honors client timestamps; a late buffered flush must
   * draw in the period it bills, not the period it arrived).
   */
  usageDate: Date;
  subscription?: CreditPoolSubscriptionRow;
  strategy?: CreditPoolStrategyRow;
  now?: Date;
}

export type ConsumeUnitsResult =
  | {
      consumed: true;
      balanceAfterUnits: number;
      entryCount: number;
      lazyMinted: boolean;
    }
  | {
      consumed: false;
      reason:
        | "nonPositiveQuantity"
        | "nonPositiveRate"
        | "subscriptionNotFound"
        | "notCreditPool"
        | "alreadyConsumed"
        | "noCoveringGrant";
    };

/**
 * Draw the event's billable quantity × its member rate from the
 * subscription's pool (rate 1 when the pool has no creditRates, byte-identical to the
 * unrated path).
 *
 * - Draw order: expiry-soonest first, then oldest (deliberately not strict
 *   FIFO: expiring credits must never rot while permanent credits burn).
 * - Expired grants are undrawable; "expired" is judged at the event's
 *   usageDate, so a grant covering the billing period of a late flush is
 *   drawable for it even after wall-clock expiry.
 * - Negative balance allowed: overdraw lands on the period-covering grant —
 *   the truthful preview of the overage calcCreditPool bills at period close.
 * - No covering grant + usageDate inside the current period = lazy mint, then
 *   draw. No covering period at all = no-op with a reason the caller logs.
 * - Idempotent per event: the (signalEventId, grantId) unique key plus the
 *   pre-check make an ingest retry a no-op.
 */
export async function consumeUnits(
  client: CreditLedgerClient,
  input: ConsumeUnitsInput,
): Promise<ConsumeUnitsResult> {
  try {
    return await consumeAttempt(client, input);
  } catch (err) {
    // P2002 here = we raced another writer (a concurrent lazy mint of the
    // same period grant, or a duplicate consume of the same event). One
    // retry resolves both: the second pass finds the grant / the entry.
    if (isUniqueViolation(err)) return consumeAttempt(client, input);
    throw err;
  }
}

async function consumeAttempt(
  client: CreditLedgerClient,
  input: ConsumeUnitsInput,
): Promise<ConsumeUnitsResult> {
  const qty = toNumber(input.quantity);
  if (!(qty > 0)) return { consumed: false, reason: "nonPositiveQuantity" };

  const now = input.now ?? new Date();
  const sub =
    input.subscription ??
    (await loadSubscription(client, input.subscriptionId));
  if (!sub) return { consumed: false, reason: "subscriptionNotFound" };

  const strategy =
    input.strategy ??
    (await findCreditPoolStrategy(client, sub.planId, input.signalId));
  if (!strategy) return { consumed: false, reason: "notCreditPool" };
  // A null memberRate on a caller-preloaded strategy means the event's signal
  // is not a pool member — the same no-op the internal lookup answers.
  const rate = input.rate ?? memberRate(strategy, input.signalId);
  if (rate === null) return { consumed: false, reason: "notCreditPool" };
  if (!Number.isFinite(rate) || !(rate > 0))
    return { consumed: false, reason: "nonPositiveRate" };
  const ratedQty = qty * rate;
  const poolSize = poolSizeFromTiers(strategy.tiers);

  const prior = await client.credit_ledger_entries.findFirst({
    where: { signalEventId: input.signalEventId },
    select: { id: true },
  });
  if (prior) return { consumed: false, reason: "alreadyConsumed" };

  const periodStart = sub.currentBillingPeriodStart;
  const periodEnd = sub.currentBillingPeriodEnd;
  const usageInCurrentPeriod =
    !!periodStart &&
    !!periodEnd &&
    input.usageDate.getTime() >= periodStart.getTime() &&
    input.usageDate.getTime() < periodEnd.getTime();

  return client.$transaction(async (tx) => {
    const fetchDrawable = async (): Promise<GrantRow[]> =>
      (await tx.credit_grants.findMany({
        where: drawableWhere(sub.id, input.usageDate),
        orderBy: [
          { expiresAt: { sort: "asc", nulls: "last" } },
          { effectiveAt: "asc" },
        ],
        select: GRANT_SELECT,
      })) as GrantRow[];

    let drawable = await fetchDrawable();
    let lazyMinted = false;

    // Lazy mint — the safety net: whoever advanced the period, the next
    // consumption heals the ledger. Gated on the PERIOD grant being absent
    // (the mint key's own definition), never on an empty drawable list — a
    // standing never-expiring top-up must not suppress the period mint,
    // or draws would burn the permanent grant first and invert
    // expiry-soonest-first (and distort the pool-alert stage math).
    const hasCurrentPeriodGrant =
      !!periodStart &&
      drawable.some(
        (g) =>
          g.periodStart !== null &&
          g.periodStart.getTime() === periodStart.getTime(),
      );
    if (
      usageInCurrentPeriod &&
      !hasCurrentPeriodGrant &&
      poolSize !== null &&
      sub.organizationId
    ) {
      await mintInTx(tx, {
        subscription: sub,
        periodStart: periodStart as Date,
        periodEnd: periodEnd as Date,
        poolSize,
        createdBy: "lazy-mint",
        now,
      });
      lazyMinted = true;
      drawable = await fetchDrawable();
    }
    if (drawable.length === 0) {
      // No grant window covers this usageDate and the current period (the
      // only period the lazy mint may create) doesn't either.
      return { consumed: false, reason: "noCoveringGrant" };
    }

    const preBalance = drawable.reduce(
      (sum, g) => sum + toNumber(g.amountUnits) - toNumber(g.consumedUnits),
      0,
    );

    // Allocate: positive remainders in draw order, then overdraw onto the
    // period-covering grant (or the longest-lived one) so negative balance
    // attaches where the overage bills. Everything from here down moves in
    // CREDITS (usage units × rate), never raw units.
    let left = ratedQty;
    const draws: Array<{ grant: GrantRow; drawn: number }> = [];
    for (const grant of drawable) {
      if (left <= 0) break;
      const remaining = Math.max(
        0,
        toNumber(grant.amountUnits) - toNumber(grant.consumedUnits),
      );
      if (remaining <= 0) continue;
      const drawn = Math.min(remaining, left);
      draws.push({ grant, drawn });
      left -= drawn;
    }
    if (left > 0) {
      const target =
        drawable.find((g) => g.periodStart !== null) ??
        drawable[drawable.length - 1];
      const open = draws.find((d) => d.grant.id === target.id);
      if (open) {
        open.drawn += left;
      } else {
        draws.push({ grant: target, drawn: left });
      }
      left = 0;
    }

    for (const draw of draws) {
      await tx.credit_grants.update({
        where: { id: draw.grant.id },
        data: { consumedUnits: { increment: draw.drawn } },
      });
    }

    // Cache: UPSERT then atomic decrement with the period guard in the WHERE
    // (no claim-or-abort CAS — the row lock serializes). Late cross-period
    // draws skip the cache entirely: it describes the CURRENT period.
    let balanceAfterUnits = preBalance - ratedQty;
    if (usageInCurrentPeriod) {
      await tx.credit_pool_balances.upsert({
        where: { subscriptionId: sub.id },
        create: {
          subscriptionId: sub.id,
          balanceUnits: preBalance,
          periodStart: periodStart as Date,
        },
        update: {},
      });
      const dec = await tx.credit_pool_balances.updateMany({
        where: { subscriptionId: sub.id, periodStart: periodStart as Date },
        data: { balanceUnits: { decrement: ratedQty } },
      });
      if (dec.count === 0) {
        // Stale-period cache row (mint should have rolled it): heal by SET.
        await tx.credit_pool_balances.upsert({
          where: { subscriptionId: sub.id },
          create: {
            subscriptionId: sub.id,
            balanceUnits: balanceAfterUnits,
            periodStart: periodStart as Date,
          },
          update: {
            balanceUnits: balanceAfterUnits,
            periodStart: periodStart as Date,
          },
        });
      } else {
        const row = (await tx.credit_pool_balances.findUnique({
          where: { subscriptionId: sub.id },
          select: { balanceUnits: true },
        })) as { balanceUnits: unknown } | null;
        if (row) balanceAfterUnits = toNumber(row.balanceUnits);
      }
    }

    // Ledger append, anchored so the LAST entry's balanceAfterUnits equals
    // the cache row read back above.
    let running = balanceAfterUnits + ratedQty;
    for (const draw of draws) {
      running -= draw.drawn;
      await tx.credit_ledger_entries.create({
        data: {
          grantId: draw.grant.id,
          subscriptionId: sub.id,
          kind: "consume",
          deltaUnits: -draw.drawn,
          balanceAfterUnits: running,
          signalEventId: input.signalEventId,
          // NULL means rate 1 (the column's contract) — writing an explicit 1
          // would make unrated rows read differently for no reason.
          ...(rate !== 1 ? { rateApplied: rate } : {}),
        },
      });
    }

    return {
      consumed: true as const,
      balanceAfterUnits,
      entryCount: draws.length,
      lazyMinted,
    };
  });
}

// ── recompute ───────────────────────────────────────────────────────────────

export interface ComputeBalanceInput {
  subscriptionId: string;
  at?: Date;
  subscription?: CreditPoolSubscriptionRow;
  strategy?: CreditPoolStrategyRow;
}

export interface ComputeBalanceResult {
  /** Drawable units at `at` (negative = overage-in-progress). */
  balanceUnits: number;
  /**
   * True when the current period has no minted grant yet and the balance
   * reads as the strategy's FULL pool — an active period with no grant is an
   * untouched pool, never an exhausted one.
   */
  implicitFullPool: boolean;
  asOf: Date;
}

/**
 * Recompute the balance from the ledger's source rows, bypassing the cache —
 * the audit/reconciliation read the cache is checked against.
 */
export async function computeBalance(
  client: CreditLedgerTxClient,
  input: ComputeBalanceInput,
): Promise<ComputeBalanceResult> {
  const at = input.at ?? new Date();
  const grants = (await client.credit_grants.findMany({
    where: drawableWhere(input.subscriptionId, at),
    select: GRANT_SELECT,
  })) as GrantRow[];
  let balanceUnits = grants.reduce(
    (sum, g) => sum + toNumber(g.amountUnits) - toNumber(g.consumedUnits),
    0,
  );

  let implicitFullPool = false;
  const sub =
    input.subscription ??
    (await loadSubscription(client, input.subscriptionId));
  const periodStart = sub?.currentBillingPeriodStart ?? null;
  const periodEnd = sub?.currentBillingPeriodEnd ?? null;
  const inCurrentPeriod =
    !!periodStart &&
    !!periodEnd &&
    at.getTime() >= periodStart.getTime() &&
    at.getTime() < periodEnd.getTime();
  if (sub && inCurrentPeriod && periodStart) {
    const hasPeriodGrant = grants.some(
      (g) =>
        g.periodStart !== null &&
        g.periodStart.getTime() === periodStart.getTime(),
    );
    if (!hasPeriodGrant) {
      const strategy =
        input.strategy ?? (await findCreditPoolStrategy(client, sub.planId));
      const poolSize = strategy ? poolSizeFromTiers(strategy.tiers) : null;
      if (poolSize !== null) {
        balanceUnits += poolSize;
        implicitFullPool = true;
      }
    }
  }

  return { balanceUnits, implicitFullPool, asOf: at };
}

// ── sweep ───────────────────────────────────────────────────────────────────

export interface SweepExpiredGrantsInput {
  subscriptionId?: string;
  now?: Date;
}

export interface SweepExpiredGrantsResult {
  swept: number;
  results: Array<{
    grantId: string;
    subscriptionId: string;
    expiredUnits: number;
    balanceAfterUnits: number;
  }>;
}

/**
 * The hygiene sweep: one `expire` entry per expired grant's UNUSED remainder.
 * Lazy expiry keeps the hot path honest (expired grants are not
 * drawable); this keeps the ledger complete. Idempotent — a grant with an
 * expire entry is never re-swept, and fully-drawn grants get no entry at all.
 */
export async function sweepExpiredGrants(
  client: CreditLedgerClient,
  input: SweepExpiredGrantsInput = {},
): Promise<SweepExpiredGrantsResult> {
  const now = input.now ?? new Date();
  const expired = (await client.credit_grants.findMany({
    where: {
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
      expiresAt: { lte: now },
      credit_ledger_entries: { none: { kind: "expire" } },
    },
    select: GRANT_SELECT,
  })) as GrantRow[];

  const results: SweepExpiredGrantsResult["results"] = [];
  for (const grant of expired) {
    const remainder =
      toNumber(grant.amountUnits) - toNumber(grant.consumedUnits);
    if (remainder <= 0) continue;

    const swept = await client.$transaction(async (tx) => {
      // Re-check inside the transaction — the candidate list above is stale
      // under concurrency, and the expire entry must be written exactly once.
      const dupe = await tx.credit_ledger_entries.findFirst({
        where: { grantId: grant.id, kind: "expire" },
        select: { id: true },
      });
      if (dupe) return null;

      // The grant is already past expiresAt, so the drawable recompute at
      // `now` excludes it — this IS the post-expiry balance.
      const balanceAfterUnits = await drawableBalance(
        tx,
        grant.subscriptionId,
        now,
      );
      await tx.credit_ledger_entries.create({
        data: {
          grantId: grant.id,
          subscriptionId: grant.subscriptionId,
          kind: "expire",
          deltaUnits: -remainder,
          balanceAfterUnits,
          signalEventId: null,
        },
      });
      const updated = await tx.credit_pool_balances.updateMany({
        where: { subscriptionId: grant.subscriptionId },
        data: { balanceUnits: balanceAfterUnits },
      });
      if (updated.count === 0) {
        const sub = await loadSubscription(tx, grant.subscriptionId);
        if (sub?.currentBillingPeriodStart) {
          await tx.credit_pool_balances.upsert({
            where: { subscriptionId: grant.subscriptionId },
            create: {
              subscriptionId: grant.subscriptionId,
              balanceUnits: balanceAfterUnits,
              periodStart: sub.currentBillingPeriodStart,
            },
            update: { balanceUnits: balanceAfterUnits },
          });
        }
      }
      return balanceAfterUnits;
    });

    if (swept !== null) {
      results.push({
        grantId: grant.id,
        subscriptionId: grant.subscriptionId,
        expiredUnits: remainder,
        balanceAfterUnits: swept,
      });
    }
  }

  return { swept: results.length, results };
}
