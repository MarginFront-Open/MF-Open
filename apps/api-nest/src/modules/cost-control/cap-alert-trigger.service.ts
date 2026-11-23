import { Injectable, Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import { CCC_AGENT_CODES } from '@marginfront/db';
import { CostControlService } from './cost-control.service';

/**
 * The ingest-side alert trigger — "evaluate at the point of spend". A cap's
 * spend can only move when a code-cost-clarity event lands, so the ladder is checked right
 * there instead of waiting for a clock (some hosts allow only daily scheduled
 * jobs, and a daily email can arrive AFTER the device hook has already blocked —
 * the warning must not be slower than the wall). The daily dispatch sweep stays as
 * the backstop; the dedup ledger makes double-evaluation harmless.
 *
 * Debounce is a per-instance in-memory map — a cost optimization, never a
 * correctness mechanism (a cold serverless instance re-evaluating early is
 * absorbed by the ledger's unique key). The map is unbounded but keyed by org;
 * serverless instances are short-lived and org counts are small.
 */
@Injectable()
export class CapAlertTriggerService {
  static readonly DEBOUNCE_MS = 5 * 60 * 1000;

  private readonly logger = new Logger(CapAlertTriggerService.name);
  private readonly lastEvalByOrg = new Map<string, number>();

  constructor(private readonly costControl: CostControlService) {}

  /**
   * Called from the ingest hot path for every successful event. Agent codes
   * outside CCC_AGENT_CODES return immediately (one in-memory comparison, zero
   * queries). Returns whether an evaluation was scheduled. NEVER throws and
   * never blocks the response: the evaluation runs post-response via waitUntil.
   */
  maybeTrigger(orgId: string, agentCode: string, nowMs: number = Date.now()): boolean {
    try {
      if (!(CCC_AGENT_CODES as readonly string[]).includes(agentCode)) return false;

      const last = this.lastEvalByOrg.get(orgId);
      if (last !== undefined && nowMs - last < CapAlertTriggerService.DEBOUNCE_MS) return false;
      // Stamp BEFORE the async work so concurrent events in this instance
      // debounce immediately instead of racing to schedule.
      this.lastEvalByOrg.set(orgId, nowMs);

      const evaluation = this.costControl
        .evaluateCapAlerts(new Date(nowMs), orgId)
        .then((r) =>
          this.logger.log(
            `[cap-alert-trigger] org ${orgId}: ${r.alertsSent} alerted in ${r.durationMs}ms`,
          ),
        )
        .catch((err) => this.logger.error(`[cap-alert-trigger] org ${orgId} failed: ${err}`));
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
      this.logger.error(`[cap-alert-trigger] swallowed hot-path error: ${err}`);
      return false;
    }
  }
}
