import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  deriveCreditPool,
  poolSizeFromTiers,
  sweepExpiredGrants,
  toNumber,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { resolveAlertRecipients } from '../../common/utils/billing-contact/alert-recipients';
import { EmailService } from '../email/email.service';
import { POOL_STAGE_LADDER, type PoolAlertStage } from '../email/pool-alert-copy';

interface PoolSubscriptionRow {
  id: string;
  name: string;
  planId: string;
  organizationId: string;
  currentBillingPeriodStart: Date;
  currentBillingPeriodEnd: Date;
  creditAlertsPaused: boolean;
  customers: { name: string | null } | null;
  organizations: {
    id: string;
    name: string;
    billingIdentity: unknown;
    billing_email: string | null;
  } | null;
}

interface DrawableGrantRow {
  amountUnits: unknown;
  consumedUnits: unknown;
  periodStart: Date | null;
}

type PeriodOutcome = 'sent' | 'quiet' | 'skipped';

/**
 * The staged pool-alert evaluator, sibling of
 * evaluateCapAlerts, with the same skeleton: for
 * every active credit-pool subscription it measures the pinned stage formula
 * — percent = (periodGrantUnits - remainingUnits) / periodGrantUnits, where
 * remainingUnits INCLUDES manual top-ups and EXCLUDES expired grants;
 * pool_exhausted = remainingUnits <= 0 (negative allowed) — decides which
 * stages are newly crossed, and sends ONE email for the highest. Lower stages
 * crossed in the same jump are recorded (suppressed, not emailed).
 *
 * Idempotent: pool_alert_events carries a unique (subscriptionId, stage,
 * periodStart) key, so a re-run re-sends nothing and a fresh billing period
 * re-arms every stage. Period-boundary rule: dispatch job #1
 * advances periods BEFORE this job runs, so each sweep first re-evaluates any
 * period that ENDED inside the lookback against its final ledger state,
 * recording under the OLD periodStart — a period that crossed a stage in its
 * final hours still alerts instead of vanishing into the rollover.
 *
 * Send rules (the same as spend-cap alerts): recipients via the shared
 * resolveAlertRecipients (billing contact, else owner/finance members; empty
 * chain skips WITHOUT recording); per-recipient send isolation (one dead
 * address never aborts after others landed); all-fail leaves the stage
 * unrecorded to retry next sweep; a null send (Resend unconfigured) counts as
 * NOT sent, and the all-null path skips with a logged reason, never a throw.
 * creditAlertsPaused suppresses sends AND records (still evaluated + logged).
 */
@Injectable()
export class PoolAlertEvaluator {
  /**
   * How far back a sweep looks for just-ended periods. The cron is daily, so
   * one day would do; a week absorbs missed runs, and the unique key makes
   * the re-evaluation of an already-recorded period free.
   */
  static readonly BOUNDARY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

  private readonly logger = new Logger(PoolAlertEvaluator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async evaluatePoolAlerts(
    now: Date = new Date(),
    subscriptionId?: string,
  ): Promise<{
    evaluated: number;
    alertsSent: number;
    skipped: number;
    errors: { subscriptionId: string; error: string }[];
    sweep?: { swept: number } | { error: string };
    durationMs: number;
  }> {
    const startedAtMs = Date.now();

    // Credit-pool membership: same filters as findCreditPoolStrategy, applied
    // set-wide. Oldest strategy per plan wins (asc order, first kept) — the
    // same ONE-pool rule the mint uses.
    const strategies = (await this.prisma.pricing_strategies.findMany({
      where: {
        pricingModel: 'credit_pool',
        chargeType: 'usage',
        active: true,
        deletedAt: null,
        signalId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { planId: true, tiers: true },
    })) as Array<{ planId: string; tiers: unknown }>;
    const strategyByPlan = new Map<string, { planId: string; tiers: unknown }>();
    for (const strategy of strategies) {
      if (!strategyByPlan.has(strategy.planId)) strategyByPlan.set(strategy.planId, strategy);
    }

    let evaluated = 0;
    let alertsSent = 0;
    let skipped = 0;
    const errors: { subscriptionId: string; error: string }[] = [];

    if (strategyByPlan.size > 0) {
      const subscriptions = (await this.prisma.subscriptions.findMany({
        where: {
          ...(subscriptionId ? { id: subscriptionId } : {}),
          planId: { in: [...strategyByPlan.keys()] },
          status: 'active',
          deletedAt: null,
          organizationId: { not: null },
          currentBillingPeriodStart: { not: null },
          currentBillingPeriodEnd: { not: null },
        },
        select: {
          id: true,
          name: true,
          planId: true,
          organizationId: true,
          currentBillingPeriodStart: true,
          currentBillingPeriodEnd: true,
          creditAlertsPaused: true,
          customers: { select: { name: true } },
          organizations: {
            select: { id: true, name: true, billingIdentity: true, billing_email: true },
          },
        },
      })) as PoolSubscriptionRow[];

      for (const sub of subscriptions) {
        evaluated++;
        try {
          const strategy = strategyByPlan.get(sub.planId)!;
          const overageRate = deriveCreditPool(strategy.tiers)?.overageRate ?? null;

          // ── Boundary pass: periods that ENDED inside the lookback, judged
          // by their period-slot grant's expiry (the mint pins expiresAt =
          // periodEnd). Evaluated against the final ledger state, recorded
          // under the OLD periodStart.
          const endedGrants = (await this.prisma.credit_grants.findMany({
            where: {
              subscriptionId: sub.id,
              periodStart: { not: null },
              expiresAt: {
                lte: now,
                gt: new Date(now.getTime() - PoolAlertEvaluator.BOUNDARY_LOOKBACK_MS),
              },
            },
            orderBy: { periodStart: 'asc' },
            select: { amountUnits: true, consumedUnits: true, periodStart: true, expiresAt: true },
          })) as Array<DrawableGrantRow & { expiresAt: Date }>;

          for (const endedGrant of endedGrants) {
            const grantUnits = toNumber(endedGrant.amountUnits);
            if (grantUnits <= 0) continue;
            // The instant before expiry: the period grant still counts, so
            // this IS the period's final drawable state.
            const finalAt = new Date(endedGrant.expiresAt.getTime() - 1);
            const remainingUnits = await this.drawableBalance(sub.id, finalAt);
            const outcome = await this.evaluatePeriodStages({
              sub,
              periodStart: endedGrant.periodStart as Date,
              grantUnits,
              remainingUnits,
              overageRate,
              periodClosed: true,
              now,
            });
            if (outcome === 'sent') alertsSent++;
            if (outcome === 'skipped') skipped++;
          }

          // ── Current pass.
          const drawable = (await this.prisma.credit_grants.findMany({
            where: {
              subscriptionId: sub.id,
              effectiveAt: { lte: now },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { amountUnits: true, consumedUnits: true, periodStart: true },
          })) as DrawableGrantRow[];
          const drawableSum = drawable.reduce(
            (sum, g) => sum + toNumber(g.amountUnits) - toNumber(g.consumedUnits),
            0,
          );
          const periodGrant = drawable.find(
            (g) =>
              g.periodStart !== null &&
              g.periodStart.getTime() === sub.currentBillingPeriodStart.getTime(),
          );

          let grantUnits: number;
          let remainingUnits: number;
          if (periodGrant) {
            grantUnits = toNumber(periodGrant.amountUnits);
            remainingUnits = drawableSum;
          } else {
            // Active period with no minted grant = a FULL untouched pool
            // — never an exhausted one.
            const poolSize = poolSizeFromTiers(strategy.tiers);
            if (poolSize === null) {
              skipped++;
              this.logger.log(
                `[pool-alert] skip subscription ${sub.id}: strategy tiers carry no bounded pool size`,
              );
              continue;
            }
            grantUnits = poolSize;
            remainingUnits = drawableSum + poolSize;
          }
          if (grantUnits <= 0) {
            skipped++;
            this.logger.log(
              `[pool-alert] skip subscription ${sub.id}: period grant is not positive`,
            );
            continue;
          }

          const outcome = await this.evaluatePeriodStages({
            sub,
            periodStart: sub.currentBillingPeriodStart,
            grantUnits,
            remainingUnits,
            overageRate,
            periodClosed: false,
            now,
          });
          if (outcome === 'sent') alertsSent++;
          if (outcome === 'skipped') skipped++;
        } catch (err) {
          errors.push({
            subscriptionId: sub.id,
            error: err instanceof Error ? err.message : String(err),
          });
          this.logger.error(`[pool-alert] subscription ${sub.id} failed: ${String(err)}`);
        }
      }
    }

    // The expired-grant hygiene sweep rides the full daily sweep only (never
    // the ingest trigger), isolated so its failure can't cost an alert pass
    // that already ran.
    let sweep: { swept: number } | { error: string } | undefined;
    if (!subscriptionId) {
      try {
        const result = await sweepExpiredGrants(this.prisma, { now });
        sweep = { swept: result.swept };
      } catch (err) {
        sweep = { error: err instanceof Error ? err.message : String(err) };
        this.logger.error(`[pool-alert] expired-grant sweep failed: ${String(err)}`);
      }
    }

    const durationMs = Date.now() - startedAtMs;
    this.logger.log(
      `[pool-alert] evaluated ${evaluated} subscription(s): ${alertsSent} alerted, ` +
        `${skipped} skipped, ${errors.length} error(s) in ${durationMs}ms` +
        `${subscriptionId ? ` (subscription ${subscriptionId})` : ' (full sweep)'}`,
    );
    return { evaluated, alertsSent, skipped, errors, ...(sweep ? { sweep } : {}), durationMs };
  }

  /** Drawable units at `at`: effective, not yet expired (top-ups included). */
  private async drawableBalance(subscriptionId: string, at: Date): Promise<number> {
    const grants = (await this.prisma.credit_grants.findMany({
      where: {
        subscriptionId,
        effectiveAt: { lte: at },
        OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
      },
      select: { amountUnits: true, consumedUnits: true },
    })) as Array<{ amountUnits: unknown; consumedUnits: unknown }>;
    return grants.reduce((sum, g) => sum + toNumber(g.amountUnits) - toNumber(g.consumedUnits), 0);
  }

  /**
   * Per (subscription, period): decide crossed
   * stages, dedup against the ledger, send the highest newly-crossed, record
   * every newly-crossed. Throws only on the all-fail send path (the caller's
   * per-subscription catch turns that into a logged error, and the unrecorded
   * stage retries next sweep).
   */
  private async evaluatePeriodStages(args: {
    sub: PoolSubscriptionRow;
    periodStart: Date;
    grantUnits: number;
    remainingUnits: number;
    overageRate: number | null;
    periodClosed: boolean;
    now: Date;
  }): Promise<PeriodOutcome> {
    const { sub, periodStart, grantUnits, remainingUnits, overageRate, periodClosed, now } = args;

    const percentUsed = ((grantUnits - remainingUnits) / grantUnits) * 100;
    const reached = POOL_STAGE_LADDER.filter((s) =>
      s.stage === 'pool_exhausted' ? remainingUnits <= 0 : percentUsed >= s.percent,
    ).map((s) => s.stage);
    if (reached.length === 0) return 'quiet';

    const already = (await this.prisma.pool_alert_events.findMany({
      where: { subscriptionId: sub.id, periodStart, stage: { in: reached } },
      select: { stage: true },
    })) as Array<{ stage: string }>;
    const alreadySent = new Set(already.map((r) => r.stage));
    const newlyReached = reached.filter((stage) => !alreadySent.has(stage));
    if (newlyReached.length === 0) return 'quiet';

    if (sub.creditAlertsPaused) {
      // Paused = evaluated and logged, but nothing sent and nothing recorded
      // — un-pausing mid-period lets the pending stages fire on the next
      // sweep instead of finding them silently burned.
      this.logger.log(
        `[pool-alert] subscription ${sub.id} crossed ${newlyReached.join(', ')} ` +
          `(period ${periodStart.toISOString()}) but creditAlertsPaused is set: nothing sent`,
      );
      return 'skipped';
    }

    const recipients = await resolveAlertRecipients(
      this.prisma,
      sub.organizationId,
      sub.organizations,
    );
    if (recipients.length === 0) {
      // Nobody to send to — skip WITHOUT recording, so the stage fires the
      // moment someone resolvable exists. Never guess an address.
      this.logger.log(
        `[pool-alert] skip subscription ${sub.id}: org has no billing email and no ` +
          `owner/finance member to alert`,
      );
      return 'skipped';
    }

    // POOL_STAGE_LADDER is ordered lowest-first, so the last newly-reached
    // entry is the highest stage — the one that gets the email.
    const highest = newlyReached[newlyReached.length - 1] as PoolAlertStage;
    const sentRecipients: string[] = [];
    let lastSendError: unknown = null;
    for (const recipient of recipients) {
      try {
        const sent = await this.email.sendPoolAlertEmail({
          to: recipient,
          stage: highest,
          customerName: sub.customers?.name ?? null,
          subscriptionName: sub.name,
          poolSizeUnits: grantUnits,
          remainingUnits,
          percentUsed,
          overageRate,
          periodClosed,
          asOf: now,
        });
        // sendEmail returns null when Resend is unconfigured — NOT a send.
        if (sent !== null) sentRecipients.push(recipient);
      } catch (err) {
        lastSendError = err;
        this.logger.error(
          `[pool-alert] subscription ${sub.id}: send to ${recipient} failed: ${err}`,
        );
      }
    }
    if (sentRecipients.length === 0) {
      // Every send failed: record nothing so the next sweep retries.
      if (lastSendError) throw lastSendError;
      // Every send was a config null: skip without burning the stage.
      this.logger.log(`[pool-alert] skip subscription ${sub.id}: email delivery not configured`);
      return 'skipped';
    }

    // recipient is VarChar(255) — with a long fallback list, record who leads
    // rather than truncating an address mid-string. The final slice guards a
    // near-255-char first email: a P2000 here would leave the stage
    // unrecorded and re-send the same alert every sweep.
    const joinedRecipients = sentRecipients.join(', ');
    const recordedRecipient = (
      joinedRecipients.length <= 255
        ? joinedRecipients
        : `${sentRecipients[0]} +${sentRecipients.length - 1} more`
    ).slice(0, 255);

    // Record EVERY newly-crossed stage (the one we emailed + the lower ones
    // we jumped past) so none re-fires this period. The unique key
    // double-guards a concurrent re-run.
    for (const stage of newlyReached) {
      try {
        await this.prisma.pool_alert_events.create({
          data: {
            subscriptionId: sub.id,
            organizationId: sub.organizationId,
            stage,
            periodStart,
            sentAt: now,
            recipient: recordedRecipient,
          },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
          throw err;
        }
      }
    }
    return 'sent';
  }
}
