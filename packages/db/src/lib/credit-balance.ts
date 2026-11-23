/**
 * credit-balance.ts: the ONE credit-pool read
 * path. Every surface that shows a pool number reads it from here: the
 * dashboard Credit Pools section, the needs-attention third section, the
 * customer/subscription detail readouts, GET /v1/credit-balances, the SDK's
 * client.creditBalances, and the MCP get_credit_balances tool. One query
 * path means those six surfaces cannot disagree with each other.
 *
 * Track-only: nothing here gates anything. A pool at zero keeps serving;
 * the overage bills at period close.
 *
 * THE TWO NUMBERS, and why they are allowed to disagree:
 *
 *   remainingUnits        top-up AWARE. Drawable grants (period grant plus
 *                         any manual top-ups) minus what has been drawn,
 *                         expired grants excluded. This is the countdown a
 *                         customer watches.
 *
 *   overageInProgressUnits  top-up BLIND, computed the INVOICE's way:
 *                         period consumption beyond tiers[0].upper. The
 *                         invoice calculator (calcCreditPool, revenue-calc.ts)
 *                         bills max(0, periodQuantity - poolSize) and has
 *                         never seen a top-up grant, so neither does this.
 *
 * A topped-up pool can honestly read "1,200 remaining" AND "300 units billing
 * as overage this period" at the same time: 5,000-unit pool, 5,300 units used,
 * 1,500 units topped up. Both true. The invoice matches the second number,
 * always. Any surface claiming "overage" must use overageInProgressUnits;
 * any surface counting down must use remainingUnits.
 *
 * Period consumption is read from `signal_events` with the INVOICE CALCULATOR'S
 * OWN selection recipe — org + subscription + signalId + usageDate window,
 * SUM(quantity), one such sum PER POOL MEMBER SIGNAL,
 * each × its creditRates burn rate (invoice-calculator.service.ts
 * calculateInvoice batch fetch + pooledCreditQuantity, replicated as the
 * parity oracle invoiceSelectedCreditQuantity in credit-ledger.test.ts).
 * Two other ways to read it, and why each breaks the parity rule:
 *
 *   - Summing grants' consumedUnits: a top-up never expires, so its
 *     consumedUnits carries across periods and over-reports usage forever
 *     after the first overdraw.
 *   - Summing the ledger's consume entries by createdAt: diverges from the
 *     invoice in four modes — a buffered flush billed to the period it names
 *     but counted in the period it arrived, a draw the ingest seam swallowed
 *     non-fatally (the invoice still bills it), a mid-period activation, and a
 *     historical-usageDate import. Two of those under-report, which is the
 *     surprise-bill direction.
 *
 * The ledger stays the truth for remainingUnits; the invoice's own source
 * stays the truth for the bill. That is the whole point of the split.
 */

import { poolMemberRates, poolSizeFromTiers } from "./credit-ledger";
import { toNumber } from "./revenue-calc";

/**
 * The slices of a Prisma client this read touches. Deliberately structural
 * (the CoverageQueryClient pattern in spend-coverage.ts) so api-nest's
 * PrismaService and the dashboard's client both satisfy
 * it with no cast.
 */
export interface CreditBalanceQueryClient {
  subscriptions: {
    // Foot-gun: method syntax + open args are load-bearing — narrowing to
    // arrow props or literal arg types breaks assignability for one of the
    // two concrete Prisma clients (see CoverageQueryClient in spend-coverage.ts).
    findMany(args?: unknown): Promise<unknown[]>;
  };
  pricing_strategies: {
    findMany(args?: unknown): Promise<unknown[]>;
  };
  credit_grants: {
    findMany(args?: unknown): Promise<unknown[]>;
  };
  signal_events: {
    aggregate(
      args?: unknown,
    ): Promise<{ _sum?: { quantity?: unknown } | null }>;
  };
}

export interface CreditBalanceFilters {
  /** One subscription only. */
  subscriptionId?: string;
  /** Every credit-pool subscription for one customer. */
  customerId?: string;
  /** Every credit-pool subscription for one agent. */
  agentId?: string;
  /**
   * Keep only pools with this percent of the pool (or less) still left.
   * `belowPercent: 20` is the near-empty cut the needs-attention section uses;
   * `belowPercent: 0` narrows it to exhausted pools. Subscriptions with no
   * billing period are never returned by this filter: nothing is drawing them
   * down, so they cannot be running low.
   */
  belowPercent?: number;
}

export interface CreditBalanceRow {
  subscriptionId: string;
  subscriptionName: string;
  customerId: string;
  customerName: string | null;
  customerExternalId: string | null;
  agentId: string;
  planId: string;
  planName: string | null;
  /**
   * The pool the plan sells (tiers[0].upper) — denominated in CREDITS once
   * the strategy carries creditRates; for a rate-less pool credits ≡ units.
   */
  poolSizeUnits: number;
  /**
   * Credits drawn inside the current period: per member signal,
   * SUM(quantity) × burn rate. Rate-less pools keep the raw-unit
   * read. Top-up blind.
   */
  consumedUnits: number;
  /** Drawable units left, top-ups included, expired grants excluded. */
  remainingUnits: number;
  /**
   * Units already billing as overage this period: max(0, consumed - poolSize),
   * the same arithmetic calcCreditPool runs at period close. Top-up blind, so
   * a top-up raises remainingUnits and leaves this number where it was.
   */
  overageInProgressUnits: number;
  /** remainingUnits as a percent of poolSizeUnits. Negative once overdrawn. */
  remainingPercent: number;
  /** Per-unit overage price from the plan, or null when the tiers can't say. */
  overageRatePerUnit: number | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** subscriptions.creditAlertsPaused — pool emails stay silent while true. */
  alertsPaused: boolean;
  /**
   * True when the subscription has no billing period yet (an SDK auto-created
   * subscription). The pool reads as full and untouched, because it is.
   */
  noActivePeriod: boolean;
  /**
   * True when no grant covers the pool right now, so `remainingUnits` reads as
   * the FULL untouched pool rather than zero. Happens between
   * period end and the next mint, and on a subscription that has no billing
   * period yet. A gap between two mint points is not a drained pool.
   */
  implicitFullPool: boolean;
}

interface SubscriptionRow {
  id: string;
  name: string;
  customerId: string;
  agentId: string;
  planId: string;
  currentBillingPeriodStart: Date | null;
  currentBillingPeriodEnd: Date | null;
  creditAlertsPaused: boolean;
  customers: { name: string | null; externalId: string | null } | null;
  pricing_plans: { name: string | null } | null;
}

interface StrategyRow {
  planId: string;
  signalId: string | null;
  tiers: unknown;
  creditRates?: unknown;
}

interface GrantRow {
  subscriptionId: string;
  amountUnits: unknown;
  consumedUnits: unknown;
  periodStart: Date | null;
  effectiveAt: Date;
  expiresAt: Date | null;
}

const SUBSCRIPTION_SELECT = {
  id: true,
  name: true,
  customerId: true,
  agentId: true,
  planId: true,
  currentBillingPeriodStart: true,
  currentBillingPeriodEnd: true,
  creditAlertsPaused: true,
  customers: { select: { name: true, externalId: true } },
  pricing_plans: { select: { name: true } },
} as const;

/**
 * The per-unit overage price: the second tier's rate, read the same way
 * calcCreditPool reads it (sorted by `lower`, index 1). Null when the tiers
 * carry no overage tier — honest absence, never a fabricated 0.
 */
function overageRateFromTiers(tiers: unknown): number | null {
  if (!Array.isArray(tiers) || tiers.length < 2) return null;
  const sorted = [...tiers].sort(
    (a, b) =>
      toNumber((a as { lower?: unknown })?.lower) -
      toNumber((b as { lower?: unknown })?.lower),
  );
  const rate = (sorted[1] as { rate?: unknown })?.rate;
  if (rate === null || rate === undefined) return null;
  return toNumber(rate);
}

/**
 * The credit-pool strategy for each plan, filter-for-filter what the mint and
 * the invoice use (findCreditPoolStrategy in credit-ledger.ts) applied
 * set-wide. Oldest strategy per plan wins — the same ONE-pool rule the ledger
 * mints against.
 */
async function loadStrategiesByPlan(
  client: CreditBalanceQueryClient,
  planIds: string[],
): Promise<Map<string, StrategyRow>> {
  const byPlan = new Map<string, StrategyRow>();
  if (planIds.length === 0) return byPlan;
  const rows = (await client.pricing_strategies.findMany({
    where: {
      planId: { in: planIds },
      pricingModel: "credit_pool",
      chargeType: "usage",
      active: true,
      deletedAt: null,
      signalId: { not: null },
    },
    orderBy: { createdAt: "asc" },
    select: { planId: true, signalId: true, tiers: true, creditRates: true },
  })) as StrategyRow[];
  for (const row of rows) {
    if (!byPlan.has(row.planId)) byPlan.set(row.planId, row);
  }
  return byPlan;
}

/**
 * The credit quantity the invoice will bill for this period, selected exactly
 * the way the invoice calculator selects it: per member signal, org +
 * subscription + signalId + usageDate window, SUM(quantity) × burn rate,
 * summed (sum first, then one multiply per signal — the parity oracle pins
 * that order). A rate-less pool is the single-member rate-1 case, identical
 * to a raw-unit read. Both window bounds are INCLUSIVE, matching the
 * calculator (`lte`, not `lt`) — an event landing on the closing instant
 * bills, so it has to count here too.
 */
async function periodConsumption(
  client: CreditBalanceQueryClient,
  organizationId: string,
  subscriptionId: string,
  strategy: StrategyRow,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  let credits = 0;
  for (const [signalId, rate] of poolMemberRates(strategy)) {
    const agg = await client.signal_events.aggregate({
      where: {
        organizationId,
        subscriptionId,
        signalId,
        usageDate: { gte: periodStart, lte: periodEnd },
      },
      _sum: { quantity: true },
    });
    const sum = agg?._sum?.quantity;
    if (sum === null || sum === undefined) continue;
    credits += toNumber(sum) * rate;
  }
  return credits;
}

/**
 * Every credit-pool balance in the organization, newest-period first, with the
 * optional filters applied. Non-credit-pool subscriptions are absent (not
 * zero-filled) — a subscription with no pool has no pool number.
 */
export async function getCreditBalances(
  client: CreditBalanceQueryClient,
  organizationId: string,
  filters: CreditBalanceFilters = {},
  now: Date = new Date(),
): Promise<CreditBalanceRow[]> {
  const subscriptions = (await client.subscriptions.findMany({
    where: {
      organizationId,
      deletedAt: null,
      ...(filters.subscriptionId ? { id: filters.subscriptionId } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.agentId ? { agentId: filters.agentId } : {}),
    },
    select: SUBSCRIPTION_SELECT,
  })) as SubscriptionRow[];
  if (subscriptions.length === 0) return [];

  const strategyByPlan = await loadStrategiesByPlan(client, [
    ...new Set(subscriptions.map((s) => s.planId)),
  ]);
  const pooled = subscriptions.filter((s) => strategyByPlan.has(s.planId));
  if (pooled.length === 0) return [];

  const grants = (await client.credit_grants.findMany({
    where: { subscriptionId: { in: pooled.map((s) => s.id) } },
    select: {
      subscriptionId: true,
      amountUnits: true,
      consumedUnits: true,
      periodStart: true,
      effectiveAt: true,
      expiresAt: true,
    },
  })) as GrantRow[];
  const grantsBySubscription = new Map<string, GrantRow[]>();
  for (const grant of grants) {
    const list = grantsBySubscription.get(grant.subscriptionId);
    if (list) list.push(grant);
    else grantsBySubscription.set(grant.subscriptionId, [grant]);
  }

  const rows: CreditBalanceRow[] = [];
  for (const sub of pooled) {
    const strategy = strategyByPlan.get(sub.planId) as StrategyRow;
    const row = await buildRow(
      client,
      organizationId,
      sub,
      strategy,
      grantsBySubscription,
      now,
    );
    if (row) rows.push(row);
  }

  // A subscription with no billing period has no countdown running, so it can
  // never be "running low" — excluded from the band rather than reported at a
  // percentage nothing is moving.
  const filtered =
    filters.belowPercent === undefined
      ? rows
      : rows.filter(
          (r) =>
            !r.noActivePeriod &&
            r.remainingPercent <= (filters.belowPercent as number),
        );

  return filtered.sort((a, b) => {
    if (a.remainingPercent !== b.remainingPercent)
      return a.remainingPercent - b.remainingPercent;
    return a.subscriptionId.localeCompare(b.subscriptionId);
  });
}

/** One subscription's balance, or null when it carries no credit pool. */
export async function getCreditBalance(
  client: CreditBalanceQueryClient,
  organizationId: string,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<CreditBalanceRow | null> {
  const rows = await getCreditBalances(
    client,
    organizationId,
    { subscriptionId },
    now,
  );
  return rows[0] ?? null;
}

async function buildRow(
  client: CreditBalanceQueryClient,
  organizationId: string,
  sub: SubscriptionRow,
  strategy: StrategyRow,
  grantsBySubscription: Map<string, GrantRow[]>,
  now: Date,
): Promise<CreditBalanceRow | null> {
  const strategyPoolSize = poolSizeFromTiers(strategy.tiers);
  const periodStart = sub.currentBillingPeriodStart;
  const periodEnd = sub.currentBillingPeriodEnd;
  const noActivePeriod =
    !periodStart ||
    !periodEnd ||
    now.getTime() < periodStart.getTime() ||
    now.getTime() >= periodEnd.getTime();

  const all = grantsBySubscription.get(sub.id) ?? [];
  const drawable = all.filter(
    (g) =>
      g.effectiveAt.getTime() <= now.getTime() &&
      (g.expiresAt === null || g.expiresAt.getTime() > now.getTime()),
  );

  // The remainingUnits recompute, mirroring computeBalance in
  // credit-ledger.ts. It runs in memory here because the grant rows
  // are already batched for the whole org; the sibling test asserts the two
  // agree on in-period fixtures. The belt below is deliberately WIDER than
  // computeBalance's: that function answers "what can ingest draw right now",
  // this one answers "what does the customer have".
  let remainingUnits = drawable.reduce(
    (sum, g) => sum + toNumber(g.amountUnits) - toNumber(g.consumedUnits),
    0,
  );

  // The implicit-full-pool rule: NO drawable period grant means the pool
  // reads FULL and untouched, whatever the period state. It must not be
  // scoped to an active period: an SDK auto-created subscription (no period
  // at all) and every healthy pool in the window between period end and the
  // next dispatch re-mint both have zero drawable grants, and an active-period
  // scope would read both as EXHAUSTED on every surface. A gap between two
  // mint points is not a drained pool.
  const periodGrant =
    periodStart === null
      ? undefined
      : drawable.find(
          (g) =>
            g.periodStart !== null &&
            g.periodStart.getTime() === periodStart.getTime(),
        );
  let implicitFullPool = false;
  if (!periodGrant && strategyPoolSize !== null) {
    remainingUnits += strategyPoolSize;
    implicitFullPool = true;
  }
  const poolSizeUnits = periodGrant
    ? toNumber(periodGrant.amountUnits)
    : (strategyPoolSize ?? 0);
  if (poolSizeUnits <= 0) return null;

  // No window and no meter means nothing to sum. The invoice has no period to
  // bill either, so 0 is the honest read, not a missing one.
  const consumedUnits =
    noActivePeriod || !periodStart || !periodEnd || strategy.signalId === null
      ? 0
      : await periodConsumption(
          client,
          organizationId,
          sub.id,
          strategy,
          periodStart,
          periodEnd,
        );

  return {
    subscriptionId: sub.id,
    subscriptionName: sub.name,
    customerId: sub.customerId,
    customerName: sub.customers?.name ?? null,
    customerExternalId: sub.customers?.externalId ?? null,
    agentId: sub.agentId,
    planId: sub.planId,
    planName: sub.pricing_plans?.name ?? null,
    poolSizeUnits,
    consumedUnits,
    remainingUnits,
    overageInProgressUnits: Math.max(0, consumedUnits - poolSizeUnits),
    remainingPercent: (remainingUnits / poolSizeUnits) * 100,
    overageRatePerUnit: overageRateFromTiers(strategy.tiers),
    periodStart: noActivePeriod ? null : periodStart,
    periodEnd: noActivePeriod ? null : periodEnd,
    alertsPaused: sub.creditAlertsPaused,
    noActivePeriod,
    implicitFullPool,
  };
}
