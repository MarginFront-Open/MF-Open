import { Injectable, Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import { CCC_AGENT_CODES } from '@marginfront/db';
import { CustomerAlertsService } from './customer-alerts.service';

/**
 * WHAT THIS FILE DOES: the ingest-side trigger for customer watches — every
 * successful REAL-customer event pokes a debounced, post-response evaluation
 * of that org's watches, so the warning arrives at the speed of spend instead
 * of waiting for the daily cron backstop.
 * The agent filter is the inverse of cap-alert-trigger.service.ts: caps watch
 * internal code-cost-clarity spend and skip everything else; customer watches
 * skip code-cost-clarity events and fire on everything else (real customer
 * traffic, i.e. most ingest volume; the 5-minute per-org debounce is the load
 * ceiling).
 * CONNECTS TO: sdk.service.ts (the one call site, inside the PROCESSED
 * branch), customer-alerts.service.ts evaluateCustomerAlerts.
 *
 * Debounce is a per-instance in-memory map — a cost optimization, never a
 * correctness mechanism (a cold serverless instance re-evaluating early is
 * absorbed by the ledger's unique key). The map is unbounded but keyed by org;
 * serverless instances are short-lived and org counts are small.
 */
@Injectable()
export class CustomerAlertTriggerService {
  static readonly DEBOUNCE_MS = 5 * 60 * 1000;

  private readonly logger = new Logger(CustomerAlertTriggerService.name);
  private readonly lastEvalByOrg = new Map<string, number>();

  constructor(private readonly customerAlerts: CustomerAlertsService) {}

  /**
   * Called from the ingest hot path for every successful event. Agent codes in
   * CCC_AGENT_CODES return immediately (one in-memory comparison, zero queries), the
   * exact inverse of the cap trigger's gate. Returns whether an evaluation was
   * scheduled. NEVER throws and never blocks the response: the evaluation runs
   * post-response via waitUntil.
   */
  maybeTrigger(orgId: string, agentCode: string, nowMs: number = Date.now()): boolean {
    try {
      if ((CCC_AGENT_CODES as readonly string[]).includes(agentCode)) return false;

      const last = this.lastEvalByOrg.get(orgId);
      if (last !== undefined && nowMs - last < CustomerAlertTriggerService.DEBOUNCE_MS)
        return false;
      // Stamp BEFORE the async work so concurrent events in this instance
      // debounce immediately instead of racing to schedule.
      this.lastEvalByOrg.set(orgId, nowMs);

      const evaluation = this.customerAlerts
        .evaluateCustomerAlerts(new Date(nowMs), orgId)
        .then((r) =>
          this.logger.log(
            `[customer-alert-trigger] org ${orgId}: ${r.alertsSent} alerted in ${r.durationMs}ms`,
          ),
        )
        .catch((err) => this.logger.error(`[customer-alert-trigger] org ${orgId} failed: ${err}`));
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
      this.logger.error(`[customer-alert-trigger] swallowed hot-path error: ${err}`);
      return false;
    }
  }
}
