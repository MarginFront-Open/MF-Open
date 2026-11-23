import { Injectable, Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import { PoolAlertEvaluator } from './pool-alert-evaluator.service';

/**
 * The ingest-side pool-alert trigger, clone of CapAlertTriggerService
 * — "evaluate at the point of spend". A pool's balance can only
 * move when a credit-pool event lands, so the stages are checked right there
 * instead of waiting for a clock (some hosts allow only daily scheduled jobs,
 * and a 95%-in-an-afternoon burn deserves a same-hour email). The daily dispatch
 * sweep stays as the backstop; the dedup ledger makes double-evaluation
 * harmless.
 *
 * Debounce is a per-instance in-memory map — a cost optimization, never a
 * correctness mechanism (a cold serverless instance re-evaluating early is
 * absorbed by the ledger's unique key). Unlike CapAlertTriggerService, it is
 * keyed PER SUBSCRIPTION, not per org — pool stages are subscription-scoped,
 * and one busy subscription must not starve a sibling's evaluation.
 */
@Injectable()
export class PoolAlertTriggerService {
  static readonly DEBOUNCE_MS = 5 * 60 * 1000;

  private readonly logger = new Logger(PoolAlertTriggerService.name);
  private readonly lastEvalBySubscription = new Map<string, number>();

  constructor(private readonly evaluator: PoolAlertEvaluator) {}

  /**
   * Called from the ingest hot path after the credit-pool draw. The caller
   * passes the membership consumeForEvent already resolved, so non-credit-pool
   * events cost one boolean check — zero queries. Returns whether an
   * evaluation was scheduled. NEVER throws and never blocks the response:
   * the evaluation runs post-response via waitUntil.
   */
  maybeTrigger(
    subscriptionId: string | null | undefined,
    isCreditPool: boolean,
    nowMs: number = Date.now(),
  ): boolean {
    try {
      if (!isCreditPool || !subscriptionId) return false;

      const last = this.lastEvalBySubscription.get(subscriptionId);
      if (last !== undefined && nowMs - last < PoolAlertTriggerService.DEBOUNCE_MS) return false;
      // Stamp BEFORE the async work so concurrent events in this instance
      // debounce immediately instead of racing to schedule.
      this.lastEvalBySubscription.set(subscriptionId, nowMs);

      const evaluation = this.evaluator
        .evaluatePoolAlerts(new Date(nowMs), subscriptionId)
        .then((r) =>
          this.logger.log(
            `[pool-alert-trigger] subscription ${subscriptionId}: ${r.alertsSent} alerted ` +
              `in ${r.durationMs}ms`,
          ),
        )
        .catch((err) =>
          this.logger.error(`[pool-alert-trigger] subscription ${subscriptionId} failed: ${err}`),
        );
      try {
        // Keeps the serverless function alive past the response until the
        // evaluation settles; a function timeout can still kill it, which the
        // daily backstop sweep covers.
        waitUntil(evaluation);
      } catch {
        // Outside a serverless request context (tests, local dev) the promise is
        // already running; nothing to track.
      }
      return true;
    } catch (err) {
      this.logger.error(`[pool-alert-trigger] swallowed hot-path error: ${err}`);
      return false;
    }
  }
}
