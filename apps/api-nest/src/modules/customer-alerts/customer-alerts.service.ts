import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MANAGE_MONEY_ROLES,
  CUSTOMER_ALERT_MAX_PER_ORG,
  Prisma,
  resolveCustomerAlertEvaluation,
  toNumber,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import { CreateCustomerAlertDto } from './dto/create-customer-alert.dto';
import { UpdateCustomerAlertDto } from './dto/update-customer-alert.dto';

/**
 * WHAT THIS FILE DOES: the Customer Watch Alerts engine. CRUD for
 * per-customer cost/revenue tripwires ("email me when Acme's cost passes $500
 * this month"). Watches cover REAL customers only; internal code-cost-clarity
 * accounts are rejected here and re-checked at evaluation.
 * Built on the same shape as the cap alert engine (cost-control.service.ts).
 * A DB unique index
 * (uq_customer_alerts_functional_tuple) backs the duplicate-watch guard:
 * the create/update findFirst guards give the friendly 409, and a P2002 from
 * a race maps to the same 409.
 * CONNECTS TO: customer-alerts.controller.ts (REST), the canonical metrics
 * layer via RevenueMetricsService (evaluation), EmailService (sends),
 * customer_alerts / customer_alert_events / customer_alert_notifications.
 */

type AlertRow = Prisma.customer_alertsGetPayload<Record<string, never>>;

/** The list shape: alert + just enough customer for a label and a deep link. */
export type AlertRowWithCustomer = Prisma.customer_alertsGetPayload<{
  include: { customers: { select: { id: true; name: true; externalId: true } } };
}>;

/** The evaluator's shape: alert + the customer fields the re-check reads. */
type EvaluatorAlertRow = Prisma.customer_alertsGetPayload<{
  include: {
    customers: { select: { id: true; name: true; isInternal: true; deletedAt: true } };
  };
}>;

const INTERNAL_CUSTOMER_MESSAGE =
  'This is an internal code-cost-clarity account. Customer watches cover real customers; ' +
  'use Internal AI Spend caps for coding-agent spend.';

// One string per path, shared by the app-level findFirst guard and the P2002
// race backstop — the race loser must read identically to the
// ordinary duplicate case.
const DUPLICATE_CREATE_MESSAGE =
  'An identical watch already exists for this customer (same metric, window, ' +
  'threshold, and recipient). Edit that one instead of creating a copy.';
const DUPLICATE_UPDATE_MESSAGE =
  'This edit makes the watch identical to another watch on this customer ' +
  '(same metric, window, threshold, and recipient). Edit that one instead, ' +
  'or delete one of them.';

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class CustomerAlertsService {
  private readonly logger = new Logger(CustomerAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly revenueMetrics: RevenueMetricsService,
  ) {}

  async listAlerts(organizationId: string): Promise<AlertRowWithCustomer[]> {
    return this.prisma.customer_alerts.findMany({
      where: { orgId: organizationId },
      include: { customers: { select: { id: true, name: true, externalId: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAlert(
    organizationId: string,
    actorUserId: string | undefined,
    dto: CreateCustomerAlertDto,
  ): Promise<AlertRowWithCustomer> {
    const customer = await this.prisma.customers.findFirst({
      where: { id: dto.customerId, organizationId },
      select: { id: true, name: true, isInternal: true, deletedAt: true },
    });
    // Cross-org ids 404 exactly like unknown ids — never confirm a customer
    // exists in someone else's org.
    if (!customer) {
      throw new NotFoundException('No customer with that id exists in your organization.');
    }
    if (customer.isInternal) {
      throw new BadRequestException(INTERNAL_CUSTOMER_MESSAGE);
    }
    if (customer.deletedAt !== null) {
      throw new BadRequestException(
        'This customer was deleted. Watches can only cover active customer records.',
      );
    }

    const { customStartDate, customEndDate } = this.resolveCustomDates(
      dto.windowMode,
      dto.customStartDate,
      dto.customEndDate,
    );

    const recipient = await this.resolveRecipient(organizationId, actorUserId, dto.notifyEmail);

    // Per-org ceiling: every watch costs a full canonical
    // metrics read per evaluation on the ingest debounce, so the count is capped.
    const activeCount = await this.prisma.customer_alerts.count({
      where: { orgId: organizationId },
    });
    if (activeCount >= CUSTOMER_ALERT_MAX_PER_ORG) {
      throw new BadRequestException(
        `Your organization already has ${CUSTOMER_ALERT_MAX_PER_ORG} customer watches, ` +
          'which is the limit. Delete a watch you no longer need, then try again.',
      );
    }

    // Exact functional duplicate → 409: same customer, metric,
    // window, threshold, and recipient is the same tripwire twice.
    const duplicate = await this.prisma.customer_alerts.findFirst({
      where: {
        orgId: organizationId,
        customerId: dto.customerId,
        metric: dto.metric,
        windowMode: dto.windowMode,
        thresholdUsd: dto.thresholdUsd,
        recipientUserId: recipient.userId,
        ...(dto.windowMode === 'custom' ? { customStartDate, customEndDate } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(DUPLICATE_CREATE_MESSAGE);
    }

    let alert: AlertRowWithCustomer;
    try {
      alert = await this.prisma.customer_alerts.create({
        data: {
          orgId: organizationId,
          customerId: dto.customerId,
          metric: dto.metric,
          thresholdUsd: dto.thresholdUsd,
          windowMode: dto.windowMode,
          customStartDate,
          customEndDate,
          createdByUserId: actorUserId ?? null,
          recipientEmail: recipient.email,
          recipientUserId: recipient.userId,
        },
        include: { customers: { select: { id: true, name: true, externalId: true } } },
      });
    } catch (err) {
      // The DB unique index is the last line under the findFirst
      // guard above: two identical creates racing past both findFirsts land
      // here, and the loser gets the same 409 the ordinary duplicate gets.
      if (isUniqueViolation(err)) {
        throw new ConflictException(DUPLICATE_CREATE_MESSAGE);
      }
      throw err;
    }

    // Confirmation is best-effort: the watch exists either way (a null send on
    // an env without Resend, or a Resend hiccup, must never fail the create).
    try {
      await this.email.sendCustomerAlertConfirmationEmail({
        to: recipient.email,
        customerName: customer.name,
        customerId: customer.id,
        metric: dto.metric,
        thresholdUsd: dto.thresholdUsd,
        windowMode: dto.windowMode,
        customStartDate,
        customEndDate,
        asOf: new Date(),
      });
    } catch (err) {
      this.logger.warn(`[customer-alert] confirmation email failed (non-fatal): ${err}`);
    }

    return alert;
  }

  async updateAlert(
    organizationId: string,
    alertId: string,
    actorUserId: string | undefined,
    dto: UpdateCustomerAlertDto,
  ): Promise<AlertRowWithCustomer> {
    const existing = await this.prisma.customer_alerts.findFirst({
      where: { id: alertId, orgId: organizationId },
    });
    if (!existing) {
      throw new NotFoundException('No customer watch with that id exists in your organization.');
    }

    // Cross-field rules run against the RESULTING state, so a mode flip and its
    // dates can land in one PATCH.
    const nextMode = dto.windowMode ?? existing.windowMode;
    const { customStartDate, customEndDate } = this.resolveCustomDates(
      nextMode,
      dto.customStartDate ?? this.keepDate(nextMode, existing.customStartDate),
      dto.customEndDate ?? this.keepDate(nextMode, existing.customEndDate),
    );

    const data: Prisma.customer_alertsUpdateInput = {
      metric: dto.metric ?? existing.metric,
      thresholdUsd: dto.thresholdUsd ?? existing.thresholdUsd,
      windowMode: nextMode,
      customStartDate,
      customEndDate,
    };

    // A window-mode change is a new tripwire shape: drop the rolling latch so
    // the first crossing under the new mode fires instead of riding stale state.
    if (nextMode !== existing.windowMode) {
      data.triggeredAt = null;
    }

    // A PATCH can shape a watch into an exact copy of another one — the same
    // functional duplicate the create path 409s. Checked only when the tuple
    // actually changes, so re-saving a watch untouched can never trip over a
    // pre-existing twin.
    const sameInstant = (a: Date | null, b: Date | null) =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);
    const nextMetric = dto.metric ?? existing.metric;
    const nextThreshold = dto.thresholdUsd ?? toNumber(existing.thresholdUsd);
    const tupleChanged =
      nextMetric !== existing.metric ||
      nextThreshold !== toNumber(existing.thresholdUsd) ||
      nextMode !== existing.windowMode ||
      !sameInstant(customStartDate, existing.customStartDate) ||
      !sameInstant(customEndDate, existing.customEndDate);
    if (tupleChanged) {
      const duplicate = await this.prisma.customer_alerts.findFirst({
        where: {
          id: { not: alertId },
          orgId: organizationId,
          customerId: existing.customerId,
          metric: nextMetric,
          windowMode: nextMode,
          thresholdUsd: nextThreshold,
          recipientUserId: existing.recipientUserId,
          ...(nextMode === 'custom' ? { customStartDate, customEndDate } : {}),
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException(DUPLICATE_UPDATE_MESSAGE);
      }
    }

    // Session edits re-resolve the stored address from the recipient's CURRENT
    // login email (the answer to email-change staleness). If
    // the recipient user is gone, the stored address stays — that survival is
    // why the address is stored at all.
    if (actorUserId !== undefined) {
      const recipientUser = await this.prisma.users.findUnique({
        where: { id: existing.recipientUserId },
        select: { email: true },
      });
      if (recipientUser?.email) {
        data.recipientEmail = recipientUser.email;
      }
    }

    try {
      return await this.prisma.customer_alerts.update({
        where: { id: alertId },
        data,
        include: { customers: { select: { id: true, name: true, externalId: true } } },
      });
    } catch (err) {
      // Same race backstop as create: two edits shaping the same
      // tuple can both pass the tupleChanged findFirst; the DB index catches
      // the loser here.
      if (isUniqueViolation(err)) {
        throw new ConflictException(DUPLICATE_UPDATE_MESSAGE);
      }
      throw err;
    }
  }

  async deleteAlert(
    organizationId: string,
    alertId: string,
  ): Promise<{ deleted: true; alert: AlertRow }> {
    const existing = await this.prisma.customer_alerts.findFirst({
      where: { id: alertId, orgId: organizationId },
    });
    if (!existing) {
      throw new NotFoundException('No customer watch with that id exists in your organization.');
    }
    // Ledger + notification rows cascade with the alert (schema FK) — deleting
    // a watch clears its feed.
    await this.prisma.customer_alerts.delete({ where: { id: alertId } });
    return { deleted: true, alert: existing };
  }

  /**
   * The evaluator — structural clone of evaluateCapAlerts (cost-control) with
   * the scope inverted to real customers. With an orgId this is the ingest
   * trigger's scoped check; without one it is the daily dispatch's full
   * backstop sweep. Per-alert try/catch so one bad watch never kills the run.
   *
   * The invariant this method lives and dies by (cloned from the cap engine):
   * an email that did NOT send (sendEmail returns null when Resend is
   * unconfigured) burns NOTHING — no ledger row, no notification row, no
   * latch. The next sweep retries. And because the ledger + notification write
   * in ONE transaction, the in-app feed can never show a fire the ledger
   * denies.
   */
  async evaluateCustomerAlerts(
    now: Date = new Date(),
    orgId?: string,
  ): Promise<{
    evaluated: number;
    alertsSent: number;
    skipped: number;
    errors: { alertId: string; error: string }[];
    durationMs: number;
  }> {
    const startedAtMs = Date.now();
    const alerts: EvaluatorAlertRow[] = await this.prisma.customer_alerts.findMany({
      where: {
        ...(orgId ? { orgId } : {}),
      },
      include: {
        customers: { select: { id: true, name: true, isInternal: true, deletedAt: true } },
      },
    });

    let evaluated = 0;
    let alertsSent = 0;
    let skipped = 0;
    const errors: { alertId: string; error: string }[] = [];

    for (const alert of alerts) {
      evaluated++;
      try {
        // Re-check the create-time customer rules: a customer flipped internal
        // or soft-deleted AFTER the watch was created must stop alerting.
        if (!alert.customers || alert.customers.isInternal || alert.customers.deletedAt !== null) {
          skipped++;
          this.logger.log(
            `[customer-alert] skip watch ${alert.id}: customer is internal, deleted, or missing`,
          );
          continue;
        }

        const plan = resolveCustomerAlertEvaluation(alert, now);
        if (plan.skip !== null) {
          skipped++;
          if (plan.skip === 'invalid') {
            this.logger.log(
              `[customer-alert] skip watch ${alert.id}: window config is invalid (${alert.windowMode})`,
            );
          }
          continue;
        }

        // The canonical path: getCostMetrics (canon C1+C2) /
        // getRevenueMetrics (canon R1+R2) with the customerId filter. No
        // hand-rolled money math anywhere in this module — the only
        // arithmetic is the compare below.
        const value =
          alert.metric === 'cost'
            ? (
                await this.revenueMetrics.getCostMetrics(alert.orgId, plan.window, {
                  customerId: alert.customerId,
                })
              ).cost
            : (
                await this.revenueMetrics.getRevenueMetrics(alert.orgId, plan.window, {
                  customerId: alert.customerId,
                })
              ).revenue;

        const threshold = toNumber(alert.thresholdUsd);
        // Full-precision compare; rounding happens once, in the copy (canon R4).
        const over = value > threshold;

        if (alert.windowMode === 'rolling') {
          // The crossing latch: fire when the value crosses while un-latched;
          // silent while it stays over; re-arm silently on the drop back under.
          if (!over) {
            if (alert.triggeredAt !== null) {
              await this.prisma.customer_alerts.update({
                where: { id: alert.id },
                data: { triggeredAt: null },
              });
            }
            continue;
          }
          if (alert.triggeredAt !== null) continue;
        } else if (!over) {
          continue;
        }

        // Dedup ledger check BEFORE sending (month: once per month; custom:
        // once ever; rolling: the UTC-day belt under the latch).
        const already = await this.prisma.customer_alert_events.findFirst({
          where: { alertId: alert.id, windowStart: plan.dedupWindowStart },
          select: { id: true },
        });
        if (already) continue;

        const sent = await this.email.sendCustomerAlertEmail({
          to: alert.recipientEmail,
          customerName: alert.customers.name,
          customerId: alert.customerId,
          metric: alert.metric,
          thresholdUsd: threshold,
          valueUsd: value,
          windowMode: alert.windowMode,
          customStartDate: alert.customStartDate,
          customEndDate: alert.customEndDate,
          asOf: now,
        });
        if (sent === null) {
          // Resend unconfigured: NOT a sent alert. Recording it would burn the
          // window silently on any env without email config — and would also
          // fabricate an in-app notification for an email that never went out.
          skipped++;
          this.logger.log(`[customer-alert] skip watch ${alert.id}: email delivery not configured`);
          continue;
        }

        try {
          await this.prisma.$transaction(async (tx) => {
            await tx.customer_alert_events.create({
              data: {
                alertId: alert.id,
                windowStart: plan.dedupWindowStart,
                valueUsd: value,
                recipient: alert.recipientEmail,
                sentAt: now,
              },
            });
            await tx.customer_alert_notifications.create({
              data: {
                orgId: alert.orgId,
                userId: alert.recipientUserId,
                alertId: alert.id,
                customerId: alert.customerId,
                metric: alert.metric,
                thresholdUsd: alert.thresholdUsd,
                valueUsd: value,
                windowMode: alert.windowMode,
                firedAt: now,
              },
            });
            if (alert.windowMode === 'rolling') {
              await tx.customer_alerts.update({
                where: { id: alert.id },
                data: { triggeredAt: now },
              });
            }
          });
        } catch (err) {
          // A racing evaluation won the unique (alertId, windowStart) key: its
          // transaction wrote the rows; ours rolls back whole. The email raced
          // out twice — the accepted cap-engine race (send precedes the ledger
          // write there too).
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
            throw err;
          }
        }
        alertsSent++;
      } catch (err) {
        errors.push({
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.error(`[customer-alert] watch ${alert.id} failed: ${String(err)}`);
      }
    }

    const durationMs = Date.now() - startedAtMs;
    this.logger.log(
      `[customer-alert] evaluated ${evaluated} watch(es): ${alertsSent} alerted, ${skipped} skipped, ` +
        `${errors.length} error(s) in ${durationMs}ms${orgId ? ` (org ${orgId})` : ' (full sweep)'}`,
    );
    return { evaluated, alertsSent, skipped, errors, durationMs };
  }

  /**
   * Custom mode requires an ordered date pair; the other modes must not carry
   * dates at all (a "month watch with custom dates" is a contradiction we
   * refuse rather than silently ignore).
   */
  private resolveCustomDates(
    windowMode: string,
    start: string | Date | undefined,
    end: string | Date | undefined,
  ): { customStartDate: Date | null; customEndDate: Date | null } {
    if (windowMode !== 'custom') {
      if (start || end) {
        throw new BadRequestException(
          `Custom dates only apply to the 'custom' window. Remove them, or set windowMode to 'custom'.`,
        );
      }
      return { customStartDate: null, customEndDate: null };
    }
    if (!start || !end) {
      throw new BadRequestException(
        'A custom window needs both customStartDate and customEndDate (ISO 8601).',
      );
    }
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (startDate.getTime() >= endDate.getTime()) {
      throw new BadRequestException('customStartDate must be before customEndDate.');
    }
    return { customStartDate: startDate, customEndDate: endDate };
  }

  /**
   * On update: existing custom dates carry forward only while the mode stays
   * custom. On a flip to month/rolling they clear (passing them through would
   * trip the forbidden-dates rule the user never typed).
   */
  private keepDate(nextMode: string, existing: Date | null): Date | undefined {
    return nextMode === 'custom' ? (existing ?? undefined) : undefined;
  }

  /**
   * The recipient identity rule:
   *
   * - Session caller: alerts go to the CREATOR. notifyEmail may be omitted or
   *   (case-insensitively) their own address — anything else is refused, so a
   *   session can never point a watch at a teammate's inbox.
   * - API-key caller (userId undefined — a key has no person behind it):
   *   notifyEmail is REQUIRED and must be a current org member whose role is in
   *   MANAGE_MONEY_ROLES. The role restriction keeps the in-app half working:
   *   the MFiQ feed and badge are money-gated, so a developer-role recipient
   *   would get emails pointing at a page they can never open.
   *
   * The resolved address is STORED on the watch (resolve once, deliver
   * forever) — a fire never depends on a live user lookup.
   */
  private async resolveRecipient(
    organizationId: string,
    actorUserId: string | undefined,
    notifyEmail: string | undefined,
  ): Promise<{ userId: string; email: string }> {
    if (actorUserId !== undefined) {
      const user = await this.prisma.users.findUnique({
        where: { id: actorUserId },
        select: { id: true, email: true },
      });
      if (!user?.email) {
        throw new BadRequestException(
          'Your user account has no email address to send alerts to. Fix your account email, then try again.',
        );
      }
      if (notifyEmail && notifyEmail.toLowerCase() !== user.email.toLowerCase()) {
        throw new BadRequestException(
          'Watches you create send alerts to you. Leave notifyEmail out, or a teammate ' +
            'with a money role can create their own watch.',
        );
      }
      return { userId: user.id, email: user.email };
    }

    if (!notifyEmail) {
      throw new BadRequestException(
        'API-key callers must say who gets the alerts: pass notifyEmail with the email ' +
          'of an org member who has a money role (owner, admin, or finance).',
      );
    }

    const members = (await this.prisma.ba_member.findMany({
      where: { organizationId },
      select: { role: true, users: { select: { id: true, email: true } } },
    })) as Array<{ role: string; users: { id: string; email: string | null } | null }>;

    const wanted = notifyEmail.toLowerCase();
    const match = members.find((m) => m.users?.email?.toLowerCase() === wanted);
    if (!match?.users?.email) {
      throw new BadRequestException(
        `No member of your organization has the email "${notifyEmail}". ` +
          'notifyEmail must belong to a current org member with a money role.',
      );
    }
    if (!(MANAGE_MONEY_ROLES as readonly string[]).includes(match.role)) {
      throw new BadRequestException(
        `"${notifyEmail}" belongs to a member with the '${match.role}' role, who can't open ` +
          'the customer-alerts feed. Pick a member with a money role: ' +
          `${[...MANAGE_MONEY_ROLES].join(', ')}.`,
      );
    }
    return { userId: match.users.id, email: match.users.email };
  }
}
