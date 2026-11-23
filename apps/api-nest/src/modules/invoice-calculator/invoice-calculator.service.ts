import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  applyMinCommitment,
  calcCreditPoolWithBreakdown,
  calcFlat,
  calcGraduatedWithBreakdown,
  calcOnetimeRevenue,
  calcProrationFactor,
  calcRecurringRevenue,
  calcSeatRevenue,
  calcVolumeWithBreakdown,
  creditPoolFee,
  memberRate,
  poolIsRated,
  toNumber,
  type CalcStrategy,
  type CalcTier,
  type TierBreakdownRow,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CalculateInvoiceDto, SimulateRevenueDto } from './dto';

@Injectable()
export class InvoiceCalculatorService {
  constructor(private readonly prisma: PrismaService) {}

  // Delegates to canonical toNumber() in @marginfront/db (handles
  // Prisma.Decimal, strings, numbers, nulls uniformly).
  private parseNumericValue(value: any): number {
    return toNumber(value);
  }

  // Build the minimal CalcStrategy shape canon's graduated/volume primitives
  // need. This service's callers pass in raw (tiers[], quantity); canon wants
  // a CalcStrategy object — glue lives here so the canonical library stays
  // strategy-shaped everywhere else.
  private toCalcStrategy(tiers: any[]): CalcStrategy {
    return {
      id: 'invoice-calculator-ephemeral',
      chargeType: 'usage',
      pricingModel: 'graduated',
      rate: null,
      tiers: tiers as CalcStrategy['tiers'],
      minimumCommitment: null,
      signalId: null,
    };
  }

  // Graduated breakdown — delegates to canonical @marginfront/db math.
  // Upper-bound is INCLUSIVE (canon F13/F14). lower is display-only.
  private calculateGraduatedRateWithTiers(tiers: any[], quantity: number): TierBreakdownRow[] {
    if (!tiers || tiers.length === 0) return [];
    const { tiersUsed } = calcGraduatedWithBreakdown(this.toCalcStrategy(tiers), quantity);
    return tiersUsed;
  }

  // Volume breakdown — delegates to canonical @marginfront/db math.
  private calculateVolumeRateWithTiers(
    tiers: any[],
    quantity: number,
  ): { amount: number; tiersUsed: TierBreakdownRow[]; unitPrice: number } {
    if (!tiers || tiers.length === 0) return { amount: 0, tiersUsed: [], unitPrice: 0 };
    const { total, tiersUsed, unitPrice } = calcVolumeWithBreakdown(
      this.toCalcStrategy(tiers),
      quantity,
    );
    return { amount: total, tiersUsed, unitPrice };
  }

  // The pool's member signals with their credits-per-unit burn rates: the
  // pool's own signal plus every creditRates key, each resolved through the
  // canonical memberRate (degenerate creditRates JSON reads as
  // non-membership, never a fabricated rate).
  private poolMemberRates(strategy: {
    signalId: string | null;
    creditRates?: unknown;
  }): Map<string, number> {
    const candidates = new Set<string>();
    if (strategy.signalId) candidates.add(strategy.signalId);
    const rates = strategy.creditRates;
    if (rates && typeof rates === 'object' && !Array.isArray(rates)) {
      for (const key of Object.keys(rates)) candidates.add(key);
    }
    const members = new Map<string, number>();
    for (const signalId of candidates) {
      const rate = memberRate(strategy, signalId);
      if (rate !== null) members.set(signalId, rate);
    }
    return members;
  }

  // Rated pool quantity: per member signal, SUM(quantity) × rate,
  // summed. Sum-first-then-multiply is load-bearing — the parity oracle
  // (invoiceSelectedCreditQuantity, in the ledger's own assert suite) pins
  // this exact order of operations against the ledger's per-event draws.
  private pooledCreditQuantity(
    strategy: { signalId: string | null; creditRates?: unknown },
    quantityBySignal: Map<string, number>,
  ): number {
    let credits = 0;
    for (const [signalId, rate] of this.poolMemberRates(strategy)) {
      credits += (quantityBySignal.get(signalId) ?? 0) * rate;
    }
    return credits;
  }

  // The simulator twin of pooledCreditQuantity. simulateRevenue's
  // projectedEvents is keyed by signal NAME (shortName || name), not id, so
  // member quantities go through the resolved name map. Same rates, same
  // sum-first shape — a rated pool must simulate the credits the invoice
  // will bill, or the simulator recreates the quoted-vs-billed confusion
  // this feature exists to kill.
  private pooledProjectedCredits(
    strategy: {
      signalId: string | null;
      creditRates?: unknown;
      signals?: any;
      name?: string;
    },
    projectedEvents: Record<string, number>,
    memberSignalNameById: Map<string, string>,
  ): number {
    let credits = 0;
    for (const [signalId, rate] of this.poolMemberRates(strategy)) {
      const signalName =
        signalId === strategy.signalId
          ? strategy.signals?.shortName || strategy.signals?.name || strategy.name
          : memberSignalNameById.get(signalId);
      if (!signalName) continue;
      credits += (projectedEvents[signalName] || 0) * rate;
    }
    return credits;
  }

  private calculateStrategyCharge(
    strategy: any,
    quantity: number,
  ): { amount: number; unitPrice: number; effectiveUnitPrice: number; tiersUsed: any[] } {
    const tiers = (strategy.tiers as any[]) || [];
    const rate = this.parseNumericValue(strategy.rate);

    switch (strategy.pricingModel) {
      case 'flat': {
        // Canonical flat math via @marginfront/db. calcFlat handles the
        // tiers[0].rate vs strategy.rate precedence + mismatch warning
        // per canon R3.
        const calcStrategy: CalcStrategy = {
          id: strategy.id ?? 'invoice-calculator-ephemeral',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: strategy.rate ?? null,
          tiers: tiers as CalcStrategy['tiers'],
          minimumCommitment: null,
          signalId: null,
        };
        const amount = calcFlat(calcStrategy, quantity);
        const up = tiers.length > 0 ? this.parseNumericValue(tiers[0].rate) : rate;
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
        };
      }
      case 'graduated': {
        const tiersUsed = this.calculateGraduatedRateWithTiers(tiers, quantity);
        const amount = tiersUsed.reduce((sum, t) => sum + t.subtotal, 0);
        return {
          amount,
          unitPrice: tiersUsed.length > 0 ? tiersUsed[0].rate : 0,
          effectiveUnitPrice: quantity > 0 ? amount / quantity : 0,
          tiersUsed,
        };
      }
      case 'volume': {
        const result = this.calculateVolumeRateWithTiers(tiers, quantity);
        return {
          amount: result.amount,
          unitPrice: result.unitPrice,
          effectiveUnitPrice: result.unitPrice,
          tiersUsed: result.tiersUsed,
        };
      }
      case 'credit_pool': {
        // Canonical credit_pool math via @marginfront/db. Returns pool row +
        // overage row (when qty > poolSize) with the invariant
        // total === sum(tiersUsed.subtotal). Single source of truth
        // per canon R3.
        const calcStrategy: CalcStrategy = {
          id: strategy.id ?? 'invoice-calculator-ephemeral',
          chargeType: 'usage',
          pricingModel: 'credit_pool',
          rate: strategy.rate ?? null,
          tiers: tiers as CalcStrategy['tiers'],
          minimumCommitment: null,
          signalId: null,
        };
        const { total, tiersUsed, unitPrice } = calcCreditPoolWithBreakdown(calcStrategy, quantity);
        // unitPrice for invoice display = pool fee rate (poolPrice) when tiers
        // exist, else the effective per-unit rate from canon. effectiveUnitPrice
        // is the per-unit cost after the math (total/qty), useful for
        // margin-vs-listed-rate reporting.
        const displayUnitPrice =
          tiers.length > 0 ? this.parseNumericValue(tiers[0].rate) : unitPrice;
        return {
          amount: total,
          unitPrice: displayUnitPrice,
          effectiveUnitPrice: unitPrice,
          tiersUsed,
        };
      }
      case null:
      case undefined: {
        // No pricing model at all — a fixed fee. Bills rate × quantity, the
        // same arm canon takes (revenue-calc.ts calcRouted, `case null`).
        const amount = quantity * rate;
        return { amount, unitPrice: rate, effectiveUnitPrice: rate, tiersUsed: [] };
      }
      default:
        // Every value of the pricingModel enum has a case above. Reaching here
        // means the schema gained one and this switch did not, and billing
        // rate × quantity for a model that isn't rate × quantity is a wrong
        // invoice that nothing would ever flag. Canon throws on exactly this
        // (revenue-calc.ts: "A billing platform must never silently bill $0"),
        // and the two must not disagree about the same strategy.
        throw new BadRequestException(
          `Pricing model "${strategy.pricingModel}" has no invoice math. This strategy ` +
            `cannot be billed until invoice-calculator.service.ts knows how to price it. ` +
            `No invoice was produced.`,
        );
    }
  }

  // Calendar-aware cycle length for invoice billing. Anchor-day based:
  // May 17 + 1 month = June 17 (31 days). Feb 17 + 1 month = Mar 17 (28 or 29
  // depending on leap year). Whatever the calendar says. JavaScript's setMonth /
  // setFullYear are calendar-aware natively, so leap years and short-months are
  // handled for free.
  //
  // Why this and not packages/db/src/lib/revenue-metrics.ts's `cycleLengthDaysFor`
  // (which is fixed at 30 for monthly): different use cases need different math.
  //
  // - Revenue metrics: "what's this customer's per-month-equivalent revenue
  //   across an arbitrary window?" Fixed 30-day denominator gives consistent
  //   monthly normalization. Pro: comparable across windows. Con: a real 31-day
  //   month "over-attributes" by 3%, a 28-day month under-attributes by 7%.
  //   Canon rule R2 explicitly accepts that.
  //
  // - Invoice generation: "what does this customer owe for THIS cycle?" Calendar-
  //   aware denominator gives the bill the customer expects. A monthly gym
  //   membership charges $50 in every calendar month, not $51.67 in March and
  //   $46.67 in February. Customers think in calendar cycles; invoices follow
  //   that mental model.
  //
  // Both correct for their use case. Same word ("proration"), two different
  // semantics. This helper is the invoice-side version.
  private calendarCycleLengthDays(
    billingCycle: string | null | undefined,
    windowStart: Date,
    customDays: number | null | undefined,
  ): number {
    if (customDays && customDays > 0) return customDays;
    // setUTC* (not setX) — windows are stored as UTC moments. setMonth without
    // UTC operates on LOCAL time, which means UTC midnight Feb 1 → local 19:00
    // Jan 31 (EST) → setMonth(+1) lands somewhere in early March, not Mar 1,
    // so a 28-day February comes out as 31 days. Always-UTC keeps the helper
    // stable on any server timezone.
    const next = new Date(windowStart);
    switch (billingCycle) {
      case 'yearly':
        next.setUTCFullYear(next.getUTCFullYear() + 1);
        break;
      case 'weekly':
        next.setUTCDate(next.getUTCDate() + 7);
        break;
      case 'daily':
        next.setUTCDate(next.getUTCDate() + 1);
        break;
      case 'monthly':
      default:
        next.setUTCMonth(next.getUTCMonth() + 1);
        break;
    }
    return (next.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24);
  }

  // Convert a raw Prisma pricing_strategies row into the narrower CalcStrategy
  // shape the canon primitives consume. Mirrors `toCalcStrategy` in
  // revenue-metrics.ts (kept private there) so seed, dashboard, and api-nest
  // all feed the same shape into the same primitives.
  private toCalcStrategyRow(strategy: any): CalcStrategy {
    const tiers: CalcTier[] = Array.isArray(strategy.tiers)
      ? (strategy.tiers as CalcTier[]).filter(
          (t) => typeof t === 'object' && t !== null && 'lower' in t,
        )
      : [];
    return {
      id: strategy.id,
      chargeType: strategy.chargeType as CalcStrategy['chargeType'],
      pricingModel: (strategy.pricingModel as CalcStrategy['pricingModel']) ?? null,
      rate: strategy.rate === null || strategy.rate === undefined ? null : toNumber(strategy.rate),
      tiers,
      minimumCommitment: strategy.minimumCommitment ?? null,
      signalId: strategy.signalId ?? null,
    };
  }

  /**
   * Calculate a subscription's invoice for a billing period.
   *
   * Walks every active pricing_strategies row attached to the subscription's
   * pricing_plan, dispatches by chargeType, composes canon primitives from
   * @marginfront/db (calcRouted via calculateStrategyCharge for usage;
   * calcRecurringRevenue / calcSeatRevenue / calcOnetimeRevenue for sub-level
   * fees). Returns a fully-priced line-item list + totals — no math invented
   * here, just composition.
   *
   * Per canon: ONE invoice per (subscription, period) containing EVERYTHING
   * the customer owes that cycle. The `invoiceType` DTO field is accepted but
   * does not filter the returned line items, because a partial 'usage' or
   * 'subscription' invoice is anti-canon.
   *
   * Tax + discount are returned as 0. Stripe Tax handles tax at Checkout time,
   * not at invoice generation time.
   */
  async calculateInvoice(dto: CalculateInvoiceDto, orgId?: string) {
    const db = (dto.transaction as any) || this.prisma;

    // Load subscription with full pricing context in one query. include signals
    // so line-item descriptions can name what the customer is being billed for.
    //
    // Cross-tenant READ: HTTP callers pass their org so a cross-org
    // subscriptionId 404s; internal callers (subscription-billing) pass none and keep the
    // unscoped by-id lookup. `orgId !== undefined` (not truthiness) so an empty string fails
    // closed to no-match rather than silently going unscoped.
    const subscriptionInclude = {
      pricing_plans: {
        include: {
          pricing_strategies: {
            where: { active: true, deletedAt: null },
            include: {
              signals: {
                select: { id: true, name: true, shortName: true },
              },
            },
          },
        },
      },
    };
    const subscription =
      orgId !== undefined
        ? await db.subscriptions.findFirst({
            where: { id: dto.subscriptionId, organizationId: orgId },
            include: subscriptionInclude,
          })
        : await db.subscriptions.findUnique({
            where: { id: dto.subscriptionId },
            include: subscriptionInclude,
          });

    if (!subscription) {
      throw new NotFoundException(`Subscription ${dto.subscriptionId} not found`);
    }

    // Resolve billing period: DTO override wins, otherwise the subscription's
    // currently-active cycle (right answer for cron-driven and one-click "bill
    // this period" flows).
    const windowStart = dto.billingPeriodStart ?? subscription.currentBillingPeriodStart;
    const windowEnd = dto.billingPeriodEnd ?? subscription.currentBillingPeriodEnd;

    if (!windowStart || !windowEnd) {
      throw new BadRequestException(
        `Subscription ${dto.subscriptionId} has no billing period dates ` +
          `and none were provided in the calculate request.`,
      );
    }

    // Proration factor for time-bounded fees (recurring + seat). 1.0 for a
    // full cycle; less when the subscription started/ended mid-window. Uses
    // calendar-aware cycle length so a 31-day calendar month bills the full
    // monthly rate, not 31/30 of it — see calendarCycleLengthDays for why.
    const cycleLengthDays = this.calendarCycleLengthDays(
      subscription.billingCycle,
      windowStart,
      subscription.customCycleDays,
    );
    const proration = calcProrationFactor({
      windowStart,
      windowEnd,
      subscriptionStart: subscription.startDate,
      subscriptionEnd: subscription.endDate,
      cycleLengthDays,
    });

    const strategies: any[] = subscription.pricing_plans?.pricing_strategies ?? [];

    // Batch one events query for all usage strategies (avoids N+1). A credit
    // pool's member signals (creditRates keys) carry no strategy
    // rows of their own, so they must be added here explicitly or their
    // events are never fetched and the pool under-bills.
    const usageSignalIds = new Set<string>();
    for (const s of strategies) {
      if (s.chargeType !== 'usage') continue;
      if (s.signalId) usageSignalIds.add(s.signalId);
      if (s.pricingModel === 'credit_pool') {
        for (const signalId of this.poolMemberRates(s).keys()) {
          usageSignalIds.add(signalId);
        }
      }
    }

    const quantityBySignal = new Map<string, number>();
    if (usageSignalIds.size > 0) {
      const events = await db.signal_events.findMany({
        where: {
          organizationId: subscription.organizationId,
          subscriptionId: subscription.id,
          signalId: { in: [...usageSignalIds] },
          usageDate: { gte: windowStart, lte: windowEnd },
        },
        select: { signalId: true, quantity: true },
      });
      for (const ev of events) {
        if (!ev.signalId) continue;
        const prev = quantityBySignal.get(ev.signalId) ?? 0;
        quantityBySignal.set(ev.signalId, prev + toNumber(ev.quantity));
      }
    }

    // Walk strategies, dispatch on chargeType, build line items.
    const lineItems: any[] = [];

    for (const strategy of strategies) {
      let lineItem: any = null;

      switch (strategy.chargeType) {
        case 'usage': {
          if (!strategy.signalId) break;
          // A credit pool bills CREDITS — the rated sum over its member
          // signals. Every other model bills the signal's raw
          // units. Pools can't carry minimumCommitment (credit-pool-tiers.ts
          // rejects it), so the clamp below is a no-op for them.
          const rawQty =
            strategy.pricingModel === 'credit_pool'
              ? this.pooledCreditQuantity(strategy, quantityBySignal)
              : (quantityBySignal.get(strategy.signalId) ?? 0);
          const qty = applyMinCommitment(rawQty, strategy.minimumCommitment ?? null);
          // A priced pool bills its fee in a period with no usage at all
          // (the fee follows configuration, not activity). Every
          // other usage model, and a pool priced at zero, still emits nothing.
          const poolFee = creditPoolFee(strategy);
          if (qty <= 0 && poolFee <= 0) break;

          // calculateStrategyCharge already routes through canon's calcFlat /
          // calcGraduatedWithBreakdown / calcVolumeWithBreakdown /
          // calcCreditPoolWithBreakdown. Reuse it — don't reimplement.
          const charge = this.calculateStrategyCharge(strategy, qty);
          const signalLabel =
            strategy.signals?.shortName || strategy.signals?.name || strategy.name || 'Usage';
          // Only a zero-usage pool reaches here at qty 0, where the pool math
          // returns a per-unit price of $0 against a $99 amount. Bill it as one
          // unit at the fee's price — Stripe collects unit_amount × quantity
          // literally, and every surface prints qty × unit beside the amount.
          const billsFeeOnly = qty <= 0;

          lineItem = {
            description: billsFeeOnly
              ? `${signalLabel}: credit pool fee (no usage this period)`
              : `${signalLabel}: ${qty.toLocaleString()} × $${charge.effectiveUnitPrice.toFixed(4)}`,
            quantity: billsFeeOnly ? 1 : qty,
            unitPrice: billsFeeOnly ? charge.amount : charge.unitPrice,
            effectiveUnitPrice: billsFeeOnly ? charge.amount : charge.effectiveUnitPrice,
            amount: charge.amount,
            chargeType: 'usage',
            pricingStrategyId: strategy.id,
            tiersUsed: charge.tiersUsed,
          };
          break;
        }

        case 'recurring': {
          const calc = this.toCalcStrategyRow(strategy);
          const amount = calcRecurringRevenue(calc, proration);
          if (amount <= 0) break;

          const baseRate = toNumber(strategy.rate);
          const description =
            proration < 0.999
              ? `${strategy.name} (prorated to ${(proration * 100).toFixed(1)}%)`
              : strategy.name;

          lineItem = {
            description,
            quantity: 1,
            unitPrice: baseRate,
            effectiveUnitPrice: amount,
            amount,
            chargeType: 'recurring',
            pricingStrategyId: strategy.id,
            tiersUsed: [],
          };
          break;
        }

        case 'seat_based': {
          const calc = this.toCalcStrategyRow(strategy);
          const seats = subscription.seatsCount ?? 0;
          // Canon R2: quantity carries the BILLED seats, or quantity × rate
          // won't reconcile with amount.
          const billedSeats = applyMinCommitment(seats, calc.minimumCommitment);
          const amount = calcSeatRevenue(calc, seats, proration);
          if (amount <= 0) break;

          const baseRate = toNumber(strategy.rate);
          const proratedSuffix = proration < 0.999 ? ', prorated' : '';
          const minimumSuffix = billedSeats > seats ? `; minimum commitment, ${seats} entered` : '';
          lineItem = {
            description: `${strategy.name} (${billedSeats} seats × $${baseRate.toFixed(2)}${minimumSuffix}${proratedSuffix})`,
            quantity: billedSeats,
            unitPrice: baseRate,
            effectiveUnitPrice: billedSeats > 0 ? amount / billedSeats : 0,
            amount,
            chargeType: 'seat_based',
            pricingStrategyId: strategy.id,
            tiersUsed: [],
          };
          break;
        }

        case 'onetime': {
          const calc = this.toCalcStrategyRow(strategy);
          const amount = calcOnetimeRevenue(calc, subscription.startDate, windowStart, windowEnd);
          if (amount <= 0) break;

          const baseRate = toNumber(strategy.rate);
          lineItem = {
            description: strategy.name,
            quantity: 1,
            unitPrice: baseRate,
            effectiveUnitPrice: amount,
            amount,
            chargeType: 'onetime',
            pricingStrategyId: strategy.id,
            tiersUsed: [],
          };
          break;
        }

        default:
          // A charge type this switch does not handle contributes no line, so
          // the invoice would go out short by whatever that strategy charges,
          // and the totals would agree with themselves the whole way to the
          // provider. Under-billing in silence is the worst failure a billing
          // platform has.
          throw new BadRequestException(
            `Charge type "${strategy.chargeType}" has no invoice math. Strategy ` +
              `${strategy.id} cannot be billed until invoice-calculator.service.ts knows ` +
              `how to price it. No invoice was produced.`,
          );
      }

      if (lineItem) lineItems.push(lineItem);
    }

    // Tax + discount are 0: Stripe Tax handles tax at Checkout, not here.
    const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);
    const tax = 0;
    const discount = 0;
    const total = subtotal + tax - discount;

    return {
      subscriptionId: dto.subscriptionId,
      calculatedAmount: total,
      // PDF generators and UI surfaces read `breakdown`. Identical contents
      // to `lineItems`, the canonical name below.
      breakdown: lineItems,
      calculationDetails: {
        subtotal,
        total,
        tax,
        discount,
        // The canonical name. `createOrUpdateInvoiceLineItems` iterates this
        // array and throws "lineItems is not iterable" without it.
        lineItems,
        // Same data under a second field name, for any caller that reads
        // .calculationDetails.breakdown rather than the top-level breakdown.
        breakdown: lineItems,
      },
    };
  }

  async getBillingStatus(subscriptionId: string, orgId?: string) {
    // Scope to the caller's org so a cross-org subscriptionId 404s.
    const subscription =
      orgId !== undefined
        ? await this.prisma.subscriptions.findFirst({
            where: { id: subscriptionId, organizationId: orgId },
            include: { pricing_plans: true },
          })
        : await this.prisma.subscriptions.findUnique({
            where: { id: subscriptionId },
            include: { pricing_plans: true },
          });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    return {
      subscriptionId,
      status: subscription.status,
      currentBillingPeriodStart: subscription.currentBillingPeriodStart,
      currentBillingPeriodEnd: subscription.currentBillingPeriodEnd,
      nextRecurringInvoiceAt: subscription.nextRecurringInvoiceAt,
      cycleNumber: subscription.cycleNumber,
    };
  }

  /**
   * Simulate revenue for a pricing plan given projected events and seats.
   *
   * Revenue-only. No cost or margin fields appear anywhere in the
   * response: a plan simulation has no real cost to report, so any margin
   * would be invented. The shape matches the dashboard Server Action
   * simulator so neither can return fake-margin numbers.
   *
   * All pricing-model math still routes through `calculateStrategyCharge`,
   * which delegates to canonical `calcFlat` / `calcGraduatedWithBreakdown`
   * / `calcVolumeWithBreakdown` / `calcCreditPoolWithBreakdown` from
   * @marginfront/db (canon R3).
   */
  async simulateRevenue(dto: SimulateRevenueDto, orgId?: string) {
    // Pricing_plans is org-owned via `orgId`; scope the lookup so a
    // cross-org pricingPlanId 404s instead of exposing another tenant's pricing.
    const pricingPlanInclude = {
      pricing_strategies: {
        where: { active: true },
        include: { signals: true },
      },
      agents: true,
    };
    const pricingPlan =
      orgId !== undefined
        ? await this.prisma.pricing_plans.findFirst({
            where: { id: dto.pricingPlanId, orgId },
            include: pricingPlanInclude,
          })
        : await this.prisma.pricing_plans.findUnique({
            where: { id: dto.pricingPlanId },
            include: pricingPlanInclude,
          });

    if (!pricingPlan) {
      throw new NotFoundException('Pricing plan not found');
    }

    const billingCycle = dto.billingCycle || 'monthly';
    const seatsCount = dto.seatsCount || 0;
    const projectedEvents = dto.projectedEvents || {};

    const strategies = pricingPlan.pricing_strategies || [];

    // A credit pool's member signals (creditRates keys) carry no
    // strategy rows, so their names — the projectedEvents keys — must be
    // resolved here. Scoped to the plan's own org so a foreign id in rotted
    // creditRates JSON resolves to nothing rather than another tenant's name.
    const memberSignalIdsToResolve = new Set<string>();
    for (const s of strategies) {
      if (s.chargeType !== 'usage' || s.pricingModel !== 'credit_pool') continue;
      for (const signalId of this.poolMemberRates(s).keys()) {
        if (signalId !== s.signalId) memberSignalIdsToResolve.add(signalId);
      }
    }
    const memberSignalNameById = new Map<string, string>();
    if (memberSignalIdsToResolve.size > 0) {
      const memberSignals = await this.prisma.signals.findMany({
        where: { id: { in: [...memberSignalIdsToResolve] }, orgId: pricingPlan.orgId },
        select: { id: true, name: true, shortName: true },
      });
      for (const signal of memberSignals) {
        memberSignalNameById.set(signal.id, signal.shortName || signal.name);
      }
    }

    // Line items split into two groups:
    //  - initialLineItems: everything (first invoice includes one-time fees)
    //  - recurringLineItems: everything except one-time fees (typical invoice)
    const initialLineItems: any[] = [];
    const recurringLineItems: any[] = [];
    const strategyBreakdown = {
      recurring: [] as any[],
      usage: [] as any[],
      onetime: [] as any[],
      seatBased: [] as any[],
    };

    let setupCosts = 0;
    let recurringCosts = 0;
    let usageBasedCosts = 0;
    let seatBasedCosts = 0;
    const billedSeatCounts: number[] = [];

    for (const strategy of strategies) {
      const tiers = (strategy.tiers as any[]) || [];
      const rate = this.parseNumericValue(strategy.rate);

      let amount = 0;
      let quantity = 1;
      let description = strategy.name;
      let tiersUsed: any[] = [];
      let unitPrice = rate;
      let effectiveUnitPrice = rate;

      switch (strategy.chargeType) {
        case 'onetime': {
          amount = tiers.length > 0 ? this.parseNumericValue(tiers[0].rate) : rate;
          unitPrice = amount;
          effectiveUnitPrice = amount;
          description = `${strategy.name} (one-time)`;
          setupCosts += amount;
          break;
        }
        case 'recurring': {
          amount = tiers.length > 0 ? this.parseNumericValue(tiers[0].rate) : rate;
          unitPrice = amount;
          effectiveUnitPrice = amount;
          description = `${strategy.name} (${billingCycle})`;
          recurringCosts += amount;
          break;
        }
        case 'seat_based': {
          // Canon R2: clamp to the minimum BEFORE the zero guard. Clamping
          // after it would show $0 at 0 entered seats while a real invoice
          // bills the minimum.
          const enteredSeats = seatsCount;
          quantity = applyMinCommitment(enteredSeats, strategy.minimumCommitment ?? null);
          if (quantity > 0) {
            const calc = this.calculateStrategyCharge(strategy, quantity);
            amount = calc.amount;
            unitPrice = calc.unitPrice;
            effectiveUnitPrice = calc.effectiveUnitPrice;
            tiersUsed = calc.tiersUsed;
          }
          description =
            quantity > enteredSeats
              ? `${strategy.name} (${quantity} seats; minimum commitment, ${enteredSeats} entered)`
              : `${strategy.name} (${quantity} seats)`;
          seatBasedCosts += amount;
          billedSeatCounts.push(quantity);
          break;
        }
        case 'usage': {
          const signalName = strategy.signals?.shortName || strategy.signals?.name || strategy.name;
          // Canon R1: same clamp-before-guard ordering as the seat case.
          // A rated credit pool simulates CREDITS — the same member-rate sum
          // the invoice bills; the sim-vs-invoice parity spec
          // pins the two lines equal on the same usage.
          const enteredUnits =
            strategy.pricingModel === 'credit_pool'
              ? this.pooledProjectedCredits(strategy, projectedEvents, memberSignalNameById)
              : projectedEvents[signalName] || 0;
          quantity = applyMinCommitment(enteredUnits, strategy.minimumCommitment ?? null);
          // A quote that skipped the fee at zero events would under-quote the
          // bill. The dashboard twin carries this same branch; the
          // drift guard in invoice-calculator-credit-pool.test.ts reads both.
          if (quantity > 0 || creditPoolFee(strategy) > 0) {
            const calc = this.calculateStrategyCharge(strategy, quantity);
            amount = calc.amount;
            unitPrice = calc.unitPrice;
            effectiveUnitPrice = calc.effectiveUnitPrice;
            tiersUsed = calc.tiersUsed;
          }
          // Rate-less pools keep the unrated sentence exactly; the api-nest and
          // dashboard twins of this line must move together.
          const denomination =
            strategy.pricingModel === 'credit_pool' && poolIsRated(strategy) ? 'credits' : 'units';
          description =
            quantity > enteredUnits
              ? `${strategy.name} (${quantity} ${denomination}; minimum commitment, ${enteredUnits} entered)`
              : `${strategy.name} (${quantity} ${denomination})`;
          usageBasedCosts += amount;
          break;
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
      };

      // Initial charges include everything
      initialLineItems.push(lineItem);

      // Recurring charges exclude one-time
      if (strategy.chargeType !== 'onetime') {
        recurringLineItems.push(lineItem);
      }

      // Strategy breakdown
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
      };

      switch (strategy.chargeType) {
        case 'recurring':
          strategyBreakdown.recurring.push(breakdownItem);
          break;
        case 'usage':
          strategyBreakdown.usage.push(breakdownItem);
          break;
        case 'onetime':
          strategyBreakdown.onetime.push(breakdownItem);
          break;
        case 'seat_based':
          strategyBreakdown.seatBased.push(breakdownItem);
          break;
      }
    }

    const initialSubtotal = initialLineItems.reduce((sum, item) => sum + item.amount, 0);
    const recurringSubtotal = recurringLineItems.reduce((sum, item) => sum + item.amount, 0);

    const firstInvoiceTotal = initialSubtotal;
    const typicalInvoiceTotal = recurringSubtotal;
    const yearlyTotal = setupCosts + recurringSubtotal * 12;

    return {
      pricingPlan: {
        id: pricingPlan.id,
        name: pricingPlan.name,
        description: pricingPlan.description,
        // billingCycle is a subscription-level field; pricing_plans has no
        // such column, so it isn't part of this shape.
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
      // Only when the plan has exactly ONE seat strategy — with several, no
      // single count reconciles with the summed dollars.
      ...(billedSeatCounts.length === 1 ? { billedSeatsCount: billedSeatCounts[0] } : {}),
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
        // Semantic aliases: these are what the customer is CHARGED, not
        // your delivery cost. The UI reads these names.
        // The simulator is revenue-only; this response carries no margin
        // math.
        setupCosts,
        recurringCosts,
        usageBasedCosts,
        seatBasedCosts,
        firstInvoiceTotal,
        typicalInvoiceTotal,
        yearlyTotal,
      },
    };
  }
}
