import { Injectable, Logger } from '@nestjs/common';
import {
  consumeUnits,
  findCreditPoolStrategy,
  memberRate,
  toNumber,
  type CreditPoolSubscriptionRow,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * The api-nest seam over the @marginfront/db credit-ledger lib.
 * Track-only: this service DRAWS from the pool after an event is stored —
 * it never gates, never drops, never touches invoice math. A failure in here
 * must never cost a customer their usage data, so consumeForEvent never
 * throws: it logs and returns.
 */
@Injectable()
export class CreditLedgerService {
  private readonly logger = new Logger(CreditLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called from the ingest hot path for every STORED event. Cost discipline:
   *   - no subscription on the event (the common case, e.g. every
   *     code-cost-clarity event): returns immediately, ZERO queries;
   *   - subscription without a billing period (SDK auto-create subs): zero
   *     queries, `noActivePeriod`;
   *   - subscription with a period: ONE pricing_strategies findFirst decides
   *     credit-pool membership; non-pool subs stop there.
   * Only actual credit-pool events pay for the ledger transaction.
   *
   * Returns the membership it resolved so the caller can poke the pool-alert
   * trigger without re-querying: creditPool is true only when the
   * event landed on a credit-pool subscription with an active period.
   */
  async consumeForEvent(input: {
    subscription: CreditPoolSubscriptionRow | null | undefined;
    signalId: string;
    signalEventId: string;
    /** The event's billable quantity (`record.quantity ?? 1`) — UNITS, never usageCost. */
    quantity: unknown;
    usageDate: Date;
  }): Promise<{ creditPool: boolean }> {
    try {
      const sub = input.subscription;
      if (!sub) return { creditPool: false };
      if (!sub.currentBillingPeriodStart || !sub.currentBillingPeriodEnd) {
        return { creditPool: false };
      }

      const strategy = await findCreditPoolStrategy(this.prisma, sub.planId, input.signalId);
      if (!strategy) return { creditPool: false };

      // The pool draws for its own signal AND every creditRates
      // key, each at its credits-per-unit rate. The lookup above already
      // answered membership, so a null here is only reachable if the strategy
      // row changed under us — treated as the same miss.
      const rate = memberRate(strategy, input.signalId);
      if (rate === null) return { creditPool: false };

      const quantity = toNumber(input.quantity ?? 1);
      const result = await consumeUnits(this.prisma, {
        subscriptionId: sub.id,
        signalEventId: input.signalEventId,
        signalId: input.signalId,
        quantity,
        rate,
        usageDate: input.usageDate,
        subscription: sub,
        strategy,
      });
      if (result.consumed) {
        this.logger.log(
          `[credit-pool] drew ${quantity * rate} credits (${quantity} units × rate ${rate}) ` +
            `for event ${input.signalEventId} ` +
            `(subscription ${sub.id}, balance ${result.balanceAfterUnits}` +
            `${result.lazyMinted ? ', lazy-minted period grant' : ''})`,
        );
      } else if (
        // `=== false` (not else-truthiness): api-nest compiles with
        // strictNullChecks off, where only the literal comparison narrows
        // the discriminated union.
        result.consumed === false &&
        result.reason !== 'alreadyConsumed' &&
        result.reason !== 'nonPositiveQuantity'
      ) {
        // The logged reason for a no-op on a credit-pool sub (e.g. a late
        // event whose usageDate falls in a period that never had a grant).
        this.logger.warn(
          `[credit-pool] no draw for event ${input.signalEventId} on subscription ${sub.id}: ${result.reason}`,
        );
      }
      return { creditPool: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[credit-pool] consume failed (non-fatal, event already stored): ` +
          `event=${input.signalEventId} error=${message}`,
      );
      // A failed draw changed no balance — nothing new for the trigger to
      // evaluate, so membership reads false here on purpose.
      return { creditPool: false };
    }
  }
}
