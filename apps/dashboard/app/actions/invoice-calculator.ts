'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'
import {
  applyMinCommitment,
  calcCreditPoolWithBreakdown,
  calcFlat,
  calcGraduatedWithBreakdown,
  calcVolumeWithBreakdown,
  creditPoolFee,
  memberRate,
  poolIsRated,
  toNumber,
  type CalcStrategy,
  type TierBreakdownRow,
} from '@marginfront/db'

export interface SimulationPayload {
  pricingPlanId: string
  projectedEvents: Record<string, number>
  billingCycle: string
  seatsCount?: number
}

// ============================================================================
// Billing Math — all pricing models delegate to @marginfront/db canon primitives
// ============================================================================
// One source of truth for tier math (canon R3). Every pricing model routes
// through calc*WithBreakdown functions from
// @marginfront/db, which return the structured tiersUsed arrays the UI needs
// for line-item display. Kept as a server action (not an API call) for the
// RevenueSimulator UI; the math is identical to the NestJS service.

// Delegates to the canonical toNumber(), which handles Prisma.Decimal.
function parseNumericValue(value: any): number {
  return toNumber(value)
}

/**
 * Every signal that draws on this pool, with the rate one of its units burns
 *Candidates are the pool's own signal plus every creditRates
 * key; `memberRate` from @marginfront/db gives the rate and is the ONE membership
 * answer (canon R1c) — a second copy of its `?? 1` would be the violation.
 *
 * Twin of the api-nest InvoiceCalculatorService private of the same name. The
 * two implementations MUST NOT drift; the drift guard in
 * __tests__/invoice-calculator-credit-pool.test.ts reads both files.
 */
function poolMemberRates(strategy: {
  signalId: string | null
  creditRates?: unknown
}): Map<string, number> {
  const candidates = new Set<string>()
  if (strategy.signalId) candidates.add(strategy.signalId)
  const rates = strategy.creditRates
  if (rates && typeof rates === 'object' && !Array.isArray(rates)) {
    for (const key of Object.keys(rates)) candidates.add(key)
  }
  const members = new Map<string, number>()
  for (const signalId of candidates) {
    const rate = memberRate(strategy as any, signalId)
    if (rate !== null) members.set(signalId, rate)
  }
  return members
}

/**
 * The simulator's rated pool quantity: per member, projected events × rate,
 * summed. `projectedEvents` is keyed by signal NAME, so member ids arrive
 * through a resolved name map. Sum-first-then-multiply matches the invoice's
 * order of operations exactly, which is what lets the simulator quote the
 * credits the bill will actually charge.
 */
function pooledProjectedCredits(
  strategy: {
    signalId: string | null
    creditRates?: unknown
    signals?: any
    name?: string
  },
  projectedEvents: Record<string, number>,
  memberSignalNameById: Map<string, string>
): number {
  let credits = 0
  for (const [signalId, rate] of poolMemberRates(strategy)) {
    const signalName =
      signalId === strategy.signalId
        ? strategy.signals?.shortName || strategy.signals?.name || strategy.name
        : memberSignalNameById.get(signalId)
    if (!signalName) continue
    credits += (projectedEvents[signalName] || 0) * rate
  }
  return credits
}

function toCalcStrategy(
  strategyId: string,
  rate: any,
  tiers: any[],
  pricingModel: CalcStrategy['pricingModel']
): CalcStrategy {
  return {
    id: strategyId,
    chargeType: 'usage',
    pricingModel,
    rate,
    tiers: tiers as CalcStrategy['tiers'],
    minimumCommitment: null,
    signalId: null,
  }
}

// Routes to the right pricing model calculator via canonical primitives.
function calculateStrategyCharge(
  strategy: any,
  quantity: number
): {
  amount: number
  unitPrice: number
  effectiveUnitPrice: number
  tiersUsed: TierBreakdownRow[]
} {
  const tiers = (strategy.tiers as any[]) || []
  const rate = toNumber(strategy.rate)
  const strategyId = strategy.id ?? 'dashboard-simulator-ephemeral'

  switch (strategy.pricingModel) {
    case 'flat': {
      const calcStrategy = toCalcStrategy(
        strategyId,
        strategy.rate ?? null,
        tiers,
        'flat'
      )
      const amount = calcFlat(calcStrategy, quantity)
      const up = tiers.length > 0 ? toNumber(tiers[0].rate) : rate
      return {
        amount,
        unitPrice: up,
        effectiveUnitPrice: up,
        tiersUsed:
          tiers.length > 0
            ? [
                {
                  lower: tiers[0].lower,
                  upper: tiers[0].upper,
                  rate: up,
                  quantity,
                  subtotal: amount,
                },
              ]
            : [],
      }
    }
    case 'graduated': {
      const calcStrategy = toCalcStrategy(
        strategyId,
        strategy.rate ?? null,
        tiers,
        'graduated'
      )
      const { total, tiersUsed } = calcGraduatedWithBreakdown(
        calcStrategy,
        quantity
      )
      return {
        amount: total,
        unitPrice: tiersUsed.length > 0 ? tiersUsed[0].rate : 0,
        effectiveUnitPrice: quantity > 0 ? total / quantity : 0,
        tiersUsed,
      }
    }
    case 'volume': {
      const calcStrategy = toCalcStrategy(
        strategyId,
        strategy.rate ?? null,
        tiers,
        'volume'
      )
      const { total, tiersUsed, unitPrice } = calcVolumeWithBreakdown(
        calcStrategy,
        quantity
      )
      return {
        amount: total,
        unitPrice,
        effectiveUnitPrice: unitPrice,
        tiersUsed,
      }
    }
    case 'credit_pool': {
      // Canon credit_pool: pool fee from tiers[0] plus per-unit overage
      // from tiers[1]. Without this case the switch falls through to
      // default and returns $0 for the pool fee.
      const calcStrategy = toCalcStrategy(
        strategyId,
        strategy.rate ?? null,
        tiers,
        'credit_pool'
      )
      const { total, tiersUsed, unitPrice } = calcCreditPoolWithBreakdown(
        calcStrategy,
        quantity
      )
      const displayUnitPrice =
        tiers.length > 0 ? toNumber(tiers[0].rate) : unitPrice
      return {
        amount: total,
        unitPrice: displayUnitPrice,
        effectiveUnitPrice: unitPrice,
        tiersUsed,
      }
    }
    default: {
      // Null pricingModel = simple rate × quantity (matches calcRouted's null case)
      const amount = quantity * rate
      return {
        amount,
        unitPrice: rate,
        effectiveUnitPrice: rate,
        tiersUsed: [],
      }
    }
  }
}

// ============================================================================
// Main Simulation Function
// ============================================================================

export async function simulateRevenue(
  payload: SimulationPayload
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    // Scoped to the caller's org so a cross-org pricingPlanId 404s instead of
    // exposing another tenant's pricing (the api-nest twin does the same). findFirst
    // because orgId isn't in the unique index; findUnique would reopen the hole.
    const pricingPlan = await prisma.pricing_plans.findFirst({
      where: {
        id: payload.pricingPlanId,
        orgId: session.session.activeOrganizationId,
      },
      include: {
        pricing_strategies: {
          where: { active: true, deletedAt: null },
          include: { signals: true },
        },
        agents: true,
      },
    })

    if (!pricingPlan) {
      return { success: false, error: 'Pricing plan not found' }
    }

    const billingCycle = payload.billingCycle || 'monthly'
    const seatsCount = payload.seatsCount || 0
    const projectedEvents = payload.projectedEvents || {}

    const strategies = pricingPlan.pricing_strategies || []

    // A credit pool's member signals (creditRates keys) carry no
    // strategy rows, so their names — the projectedEvents keys — must be
    // resolved here. Scoped to the plan's own org so a foreign id in rotted
    // creditRates JSON resolves to nothing rather than another tenant's name.
    const memberSignalIdsToResolve = new Set<string>()
    for (const s of strategies) {
      if (s.chargeType !== 'usage' || s.pricingModel !== 'credit_pool') continue
      for (const signalId of poolMemberRates(s).keys()) {
        if (signalId !== s.signalId) memberSignalIdsToResolve.add(signalId)
      }
    }
    const memberSignalNameById = new Map<string, string>()
    if (memberSignalIdsToResolve.size > 0) {
      const memberSignals = await prisma.signals.findMany({
        where: {
          id: { in: [...memberSignalIdsToResolve] },
          orgId: pricingPlan.orgId,
        },
        select: { id: true, name: true, shortName: true },
      })
      for (const signal of memberSignals) {
        memberSignalNameById.set(signal.id, signal.shortName || signal.name)
      }
    }

    // Line items split into two groups:
    // - initialLineItems: everything (first invoice includes one-time fees)
    // - recurringLineItems: everything except one-time fees (typical monthly invoice)
    const initialLineItems: any[] = []
    const recurringLineItems: any[] = []
    const strategyBreakdown = {
      recurring: [] as any[],
      usage: [] as any[],
      onetime: [] as any[],
      seatBased: [] as any[],
    }

    let setupCosts = 0
    let recurringCosts = 0
    let usageBasedCosts = 0
    let seatBasedCosts = 0
    const billedSeatCounts: number[] = []

    for (const strategy of strategies) {
      const tiers = (strategy.tiers as any[]) || []
      const rate = parseNumericValue(strategy.rate)

      let amount = 0
      let quantity = 1
      let description = strategy.name
      let tiersUsed: any[] = []
      let unitPrice = rate
      let effectiveUnitPrice = rate

      // Cast to string so TypeScript accepts both the Prisma enum name
      // (seat_based) and the DB-mapped value (seat-based)
      switch (strategy.chargeType as string) {
        case 'onetime': {
          amount = tiers.length > 0 ? parseNumericValue(tiers[0].rate) : rate
          unitPrice = amount
          effectiveUnitPrice = amount
          description = `${strategy.name} (one-time)`
          setupCosts += amount
          break
        }
        case 'recurring': {
          amount = tiers.length > 0 ? parseNumericValue(tiers[0].rate) : rate
          unitPrice = amount
          effectiveUnitPrice = amount
          description = `${strategy.name} (${billingCycle})`
          recurringCosts += amount
          break
        }
        case 'seat_based': {
          // Canon R2: clamp BEFORE the zero guard, or 0 entered seats skips
          // the minimum. Mirrors api-nest simulateRevenue — must not drift.
          const enteredSeats = seatsCount
          quantity = applyMinCommitment(
            enteredSeats,
            strategy.minimumCommitment ?? null
          )
          if (quantity > 0) {
            const calc = calculateStrategyCharge(strategy, quantity)
            amount = calc.amount
            unitPrice = calc.unitPrice
            effectiveUnitPrice = calc.effectiveUnitPrice
            tiersUsed = calc.tiersUsed
          }
          description =
            quantity > enteredSeats
              ? `${strategy.name} (${quantity} seats; minimum commitment, ${enteredSeats} entered)`
              : `${strategy.name} (${quantity} seats)`
          seatBasedCosts += amount
          billedSeatCounts.push(quantity)
          break
        }
        case 'usage': {
          const signalName =
            strategy.signals?.shortName ||
            strategy.signals?.name ||
            strategy.name
          // Canon R1: same clamp-before-guard ordering as the seat case.
          // A rated credit pool simulates CREDITS — the same member-rate sum
          // the invoice bills; the parity fixtures pin this line
          // against the api-nest numbers.
          const enteredUnits =
            strategy.pricingModel === 'credit_pool'
              ? pooledProjectedCredits(
                  strategy,
                  projectedEvents,
                  memberSignalNameById
                )
              : projectedEvents[signalName] || 0
          quantity = applyMinCommitment(
            enteredUnits,
            strategy.minimumCommitment ?? null
          )
          // A quote that skipped the fee at zero events would under-quote the
          // bill. The api-nest twin carries this same branch; the
          // drift guard in invoice-calculator-credit-pool.test.ts reads both.
          if (quantity > 0 || creditPoolFee(strategy) > 0) {
            const calc = calculateStrategyCharge(strategy, quantity)
            amount = calc.amount
            unitPrice = calc.unitPrice
            effectiveUnitPrice = calc.effectiveUnitPrice
            tiersUsed = calc.tiersUsed
          }
          // Rate-less pools keep the unrated sentence exactly; the api-nest and
          // dashboard twins of this line must move together.
          const denomination =
            strategy.pricingModel === 'credit_pool' && poolIsRated(strategy)
              ? 'credits'
              : 'units'
          description =
            quantity > enteredUnits
              ? `${strategy.name} (${quantity} ${denomination}; minimum commitment, ${enteredUnits} entered)`
              : `${strategy.name} (${quantity} ${denomination})`
          usageBasedCosts += amount
          break
        }
      }

      const lineItem = {
        description,
        quantity,
        unitPrice,
        effectiveUnitPrice,
        amount,
        pricingStrategyId: strategy.id,
        pricingStrategyName: strategy.name,
        chargeType: strategy.chargeType,
        pricingModel: strategy.pricingModel,
        minimumCommitment: strategy.minimumCommitment,
        tiersUsed,
      }

      // Initial charges include everything
      initialLineItems.push(lineItem)

      // Recurring charges exclude one-time fees
      if (strategy.chargeType !== 'onetime') {
        recurringLineItems.push(lineItem)
      }

      // Strategy breakdown by type
      const breakdownItem = {
        id: strategy.id,
        name: strategy.name,
        chargeType: strategy.chargeType,
        pricingModel: strategy.pricingModel,
        rate: rate,
        billingFrequency: strategy.billingFrequency,
        minimumCommitment: strategy.minimumCommitment,
        tiers: tiers,
        charge: {
          quantity,
          unitPrice,
          effectiveUnitPrice,
          amount,
          tiersUsed,
        },
      }

      switch (strategy.chargeType as string) {
        case 'recurring':
          strategyBreakdown.recurring.push(breakdownItem)
          break
        case 'usage':
          strategyBreakdown.usage.push(breakdownItem)
          break
        case 'onetime':
          strategyBreakdown.onetime.push(breakdownItem)
          break
        case 'seat_based':
          strategyBreakdown.seatBased.push(breakdownItem)
          break
      }
    }

    const initialSubtotal = initialLineItems.reduce(
      (sum: number, item: any) => sum + item.amount,
      0
    )
    const recurringSubtotal = recurringLineItems.reduce(
      (sum: number, item: any) => sum + item.amount,
      0
    )

    const firstInvoiceTotal = initialSubtotal
    const typicalInvoiceTotal = recurringSubtotal
    const yearlyTotal = setupCosts + recurringSubtotal * 12

    return {
      success: true,
      data: {
        pricingPlan: {
          id: pricingPlan.id,
          name: pricingPlan.name,
          description: pricingPlan.description,
        },
        agent: pricingPlan.agents
          ? {
              id: pricingPlan.agents.id,
              name: pricingPlan.agents.name,
              agentCode: pricingPlan.agents.agentCode,
            }
          : null,
        billingCycle,
        seatsCount,
        // Only when the plan has exactly ONE seat strategy — with several,
        // no single count reconciles with the summed dollars. Same contract
        // as the api-nest simulateRevenue.
        ...(billedSeatCounts.length === 1
          ? { billedSeatsCount: billedSeatCounts[0] }
          : {}),
        projectedUsage: projectedEvents,
        initialCharges: {
          lineItems: initialLineItems,
          subtotal: initialSubtotal,
          total: initialSubtotal,
        },
        recurringCharges: {
          lineItems: recurringLineItems,
          subtotal: recurringSubtotal,
          total: recurringSubtotal,
        },
        strategyBreakdown,
        annualProjection: yearlyTotal,
        simulationSummary: {
          // Despite the "Costs" names, these are what the customer is
          // CHARGED, not your delivery cost. The UI reads these names. The
          // simulator is revenue-only and does no margin math.
          setupCosts,
          recurringCosts,
          usageBasedCosts,
          seatBasedCosts,
          firstInvoiceTotal,
          typicalInvoiceTotal,
          yearlyTotal,
        },
      },
    }
  } catch (error) {
    console.error('[simulateRevenue] Error:', error)
    return { success: false, error: 'Failed to simulate revenue' }
  }
}
