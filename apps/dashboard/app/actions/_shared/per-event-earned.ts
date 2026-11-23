import { calcRouted, type AgentEarned, type CalcStrategy } from '@marginfront/db'

/**
 * Shared helpers for Agent-Earned attribution.
 *
 * There are TWO earned primitives here, and picking the wrong one miscounts
 * window totals:
 *
 *  1. `earnedBucketsFromAgentEarned` (canon, bucket-priced) — the source of
 *     truth for the agent / signal / customer / plan Earned columns. It reads
 *     canon getAgentEarned, which aggregates each (subscription, signal)'s
 *     quantity over the WHOLE window and prices it ONCE (calcUsageRevenue:
 *     graduated tiers cross, minimum-commitment floors apply) and resolves
 *     subscriptions by date-overlap so cancelled subs keep their history. Use
 *     this for any per-dimension Earned total.
 *
 *  2. `earnedForEvent` (per-event) — prices one event alone. This is CORRECT
 *     only where per-event granularity is intrinsic and no canon primitive
 *     exists: the Event-Feed Revenue column, and the Service/Model tabs'
 *     cost-share allocation of a signal's earned across a single event's
 *     children. It is WRONG for a window total because a lone event can't
 *     cross a tier boundary the window's other events pushed past, can't see a
 *     window-level floor, and never sees a cancelled sub's strategy (the map
 *     below is built from active subs only). Never sum it to get a
 *     per-dimension Earned — call getAgentEarned and bucket it instead.
 *
 * Tier shapes come in two flavors: the seed writes `{upTo, price}`,
 * user-created plans write `{lower, upper, rate}`. The normalizer here
 * accepts either so the caller doesn't have to care.
 */

type PricingStrategyMini = {
  chargeType: string
  pricingModel: string | null
  rate: unknown
  tiers: unknown
  signalId: string | null
}

type SubscriptionWithStrategies = {
  id: string
  pricing_plans: {
    pricing_strategies: PricingStrategyMini[]
  } | null
}

function normalizeTiers(raw: unknown): CalcStrategy['tiers'] {
  if (!Array.isArray(raw)) return []
  return raw.map((t) => {
    const tier = t as Record<string, unknown>
    return {
      lower: Number(tier.lower ?? 0),
      upper:
        (tier.upper as number | null) ?? (tier.upTo as number | null) ?? null,
      rate: Number(tier.rate ?? tier.price ?? 0),
    }
  })
}

/**
 * Builds a `(subscriptionId, signalId) → CalcStrategy` lookup map from
 * the org's active subscriptions. Non-usage strategies and strategies
 * missing a signalId are skipped — usage is the only charge type that
 * attributes per-event.
 */
export function buildStrategyBySubSignal(
  subs: SubscriptionWithStrategies[]
): Map<string, CalcStrategy> {
  const map = new Map<string, CalcStrategy>()
  for (const sub of subs) {
    const strategies = sub.pricing_plans?.pricing_strategies ?? []
    for (const s of strategies) {
      if (s.chargeType !== 'usage' || !s.signalId) continue
      map.set(`${sub.id}:${s.signalId}`, {
        id: '',
        chargeType: 'usage',
        pricingModel: (s.pricingModel as CalcStrategy['pricingModel']) ?? null,
        rate: s.rate === null || s.rate === undefined ? null : Number(s.rate),
        tiers: normalizeTiers(s.tiers),
        minimumCommitment: null,
        signalId: s.signalId,
      })
    }
  }
  return map
}

/**
 * Compute per-event earnings for one signal_event using the strategy
 * lookup built above. Events without a subscription or signal, or whose
 * (sub, signal) pair has no usage strategy, earn $0 (legitimate: seat
 * and recurring fees don't attribute to a specific event).
 */
export function earnedForEvent(
  strategies: Map<string, CalcStrategy>,
  event: {
    subscriptionId: string | null
    signalId: string | null
    // `unknown` so callers can pass a Prisma Decimal or a plain number
    // without pre-coercing. Number() below handles both.
    quantity: unknown
  }
): number {
  if (!event.subscriptionId || !event.signalId) return 0
  const strategy = strategies.get(`${event.subscriptionId}:${event.signalId}`)
  if (!strategy) return 0
  return calcRouted(strategy, Number(event.quantity ?? 0))
}

/**
 * The Prisma select that produces a `SubscriptionWithStrategies`. Exported
 * so callers can drop it into a `findMany` without re-spelling the join.
 */
export const activeSubscriptionsWithStrategiesSelect = {
  id: true,
  pricing_plans: {
    select: {
      pricing_strategies: {
        where: { deletedAt: null, active: true },
        select: {
          chargeType: true,
          pricingModel: true,
          rate: true,
          tiers: true,
          signalId: true,
        },
      },
    },
  },
} as const

/** Canon-correct Earned, keyed by each dimension's entity id. */
export interface EarnedBuckets {
  byAgentId: Map<string, number>
  bySignalId: Map<string, number>
  byCustomerId: Map<string, number>
  byPlanId: Map<string, number>
}

/**
 * Bucket a canon `getAgentEarned` result into per-dimension Earned totals.
 *
 * Attribution mirrors exactly how canon getAgentEarned itself groups (see
 * packages/db/src/lib/revenue-metrics.ts):
 *   - agent / customer / plan → sum `bySubscription[].revenue` grouped by that
 *     row's agentId / customerId / planId. Each row's `revenue` IS the sub's
 *     window-aggregated usage revenue (revenue-metrics.ts prices the
 *     per-(sub,signal) quantity once via calcUsageRevenue, which applies the
 *     minimum-commitment floor). Subs are resolved by date-overlap, not status,
 *     so a cancelled sub keeps its history.
 *   - signal → sum `byStrategy[].revenue` grouped by signalId. A usage strategy
 *     prices exactly one signal (AgentEarnedStrategyRow carries signalId +
 *     revenue), and byStrategy already aggregates across every sub sharing the
 *     strategy, so grouping by signalId is the canon signal attribution.
 *
 * null planId / null signalId rows are dropped (not attributable to that
 * dimension) — matching the honest-null contract the callers already use.
 */
export function earnedBucketsFromAgentEarned(
  agentEarned: AgentEarned
): EarnedBuckets {
  const byAgentId = new Map<string, number>()
  const bySignalId = new Map<string, number>()
  const byCustomerId = new Map<string, number>()
  const byPlanId = new Map<string, number>()

  for (const row of agentEarned.bySubscription) {
    byAgentId.set(row.agentId, (byAgentId.get(row.agentId) ?? 0) + row.revenue)
    byCustomerId.set(
      row.customerId,
      (byCustomerId.get(row.customerId) ?? 0) + row.revenue
    )
    if (row.planId)
      byPlanId.set(row.planId, (byPlanId.get(row.planId) ?? 0) + row.revenue)
  }

  for (const row of agentEarned.byStrategy) {
    if (row.signalId)
      bySignalId.set(
        row.signalId,
        (bySignalId.get(row.signalId) ?? 0) + row.revenue
      )
  }

  return { byAgentId, bySignalId, byCustomerId, byPlanId }
}
