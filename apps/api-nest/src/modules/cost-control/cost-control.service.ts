import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  CAP_PROVIDER_SCOPE_ALL,
  cccInternalEventFilter,
  checkCapWithinCeiling,
  computeSpendBreakdown,
  computeSpendBreakdownDrill,
  currentPeriodWindow,
  getSpendCoverage,
  resolveApplicableCeiling,
  toNumber,
  type CapPeriod,
  type CapScope,
  type OrgCeiling,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { resolveAlertRecipients } from '../../common/utils/billing-contact/alert-recipients';
import { EmailService } from '../email/email.service';
import { CreateCapPolicyDto } from './dto/create-cap-policy.dto';
import { UpdateCapPolicyDto } from './dto/update-cap-policy.dto';
import { QuerySpendDto } from './dto/query-spend.dto';
import { QuerySpendBreakdownDto } from './dto/query-spend-breakdown.dto';
import { QuerySpendDrillDto } from './dto/query-spend-drill.dto';

type CapRow = Prisma.cap_policiesGetPayload<Record<string, never>>;

@Injectable()
export class CostControlService {
  private readonly logger = new Logger(CostControlService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async listCaps(organizationId: string): Promise<CapRow[]> {
    return this.prisma.cap_policies.findMany({
      where: { orgId: organizationId },
      orderBy: [{ scope: 'asc' }, { providerScope: 'asc' }, { scopeValue: 'asc' }],
    });
  }

  async createCap(
    organizationId: string,
    actorUserId: string | undefined,
    dto: CreateCapPolicyDto,
  ): Promise<CapRow> {
    const scopeValue = this.resolveScopeValue(dto.scope, dto.scopeValue);

    // The unbreakable ceiling, from BOTH directions, via the shared rule:
    // a child cap may not exceed its org ceiling, and an org ceiling may not be
    // set below a child that already sits under it.
    if (dto.scope === 'org') {
      await this.assertChildrenCoveredAfterChange(organizationId, dto.providerScope, dto.amountUsd);
    } else {
      await this.assertWithinCeiling(organizationId, dto.scope, dto.providerScope, dto.amountUsd);
    }

    const duplicate = await this.prisma.cap_policies.findFirst({
      where: {
        orgId: organizationId,
        scope: dto.scope,
        scopeValue,
        providerScope: dto.providerScope,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        `A ${dto.scope} cap already exists for provider "${dto.providerScope}"` +
          (scopeValue ? ` and target "${scopeValue}"` : '') +
          '. Update it instead of creating a second one.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const cap = await tx.cap_policies.create({
          data: {
            orgId: organizationId,
            scope: dto.scope,
            scopeValue,
            providerScope: dto.providerScope,
            amountUsd: dto.amountUsd,
            period: dto.period,
            mode: dto.mode,
            coolOffHours: dto.coolOffHours ?? null,
            // Omit when not supplied so the DB default ({50,80,100}) applies.
            alertThresholds: dto.alertThresholds ?? undefined,
            createdByUserId: actorUserId ?? null,
          },
        });
        await tx.cap_policy_events.create({
          data: {
            orgId: organizationId,
            capPolicyId: cap.id,
            action: 'created',
            previousValues: Prisma.JsonNull,
            newValues: this.snapshot(cap),
            actorUserId: actorUserId ?? null,
          },
        });
        return cap;
      });
    } catch (err) {
      // Belt-and-suspenders for a race past the duplicate pre-check.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A cap with this scope, target, and provider already exists.');
      }
      throw err;
    }
  }

  async updateCap(
    organizationId: string,
    capId: string,
    actorUserId: string | undefined,
    dto: UpdateCapPolicyDto,
  ): Promise<CapRow> {
    const existing = await this.prisma.cap_policies.findFirst({
      where: { id: capId, orgId: organizationId },
    });
    if (!existing) {
      throw new NotFoundException('Cap policy not found');
    }

    const newAmount = dto.amountUsd ?? toNumber(existing.amountUsd);
    if (existing.scope === 'org') {
      await this.assertChildrenCoveredAfterChange(
        organizationId,
        existing.providerScope,
        newAmount,
        capId,
      );
    } else {
      await this.assertWithinCeiling(
        organizationId,
        existing.scope as CapScope,
        existing.providerScope,
        newAmount,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const cap = await tx.cap_policies.update({
        where: { id: capId },
        data: {
          amountUsd: dto.amountUsd ?? undefined,
          period: dto.period ?? undefined,
          mode: dto.mode ?? undefined,
          coolOffHours: dto.coolOffHours === undefined ? undefined : dto.coolOffHours,
          alertThresholds: dto.alertThresholds ?? undefined,
        },
      });
      await tx.cap_policy_events.create({
        data: {
          orgId: organizationId,
          capPolicyId: cap.id,
          action: 'updated',
          previousValues: this.snapshot(existing),
          newValues: this.snapshot(cap),
          actorUserId: actorUserId ?? null,
        },
      });
      return cap;
    });
  }

  async deleteCap(
    organizationId: string,
    capId: string,
    actorUserId: string | undefined,
  ): Promise<{ deleted: true; cap: CapRow }> {
    const existing = await this.prisma.cap_policies.findFirst({
      where: { id: capId, orgId: organizationId },
    });
    if (!existing) {
      throw new NotFoundException('Cap policy not found');
    }

    // Removing an org ceiling can drop its children onto a LOWER fallback (the
    // 'all' ceiling) — same invariant as a lowering write, so same check.
    if (existing.scope === 'org') {
      await this.assertChildrenCoveredAfterChange(
        organizationId,
        existing.providerScope,
        null,
        capId,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.cap_policies.delete({ where: { id: capId } });
      // capPolicyId is a bare column (no FK), so the deleted cap's id survives on
      // the audit event even though the row it pointed at is gone.
      await tx.cap_policy_events.create({
        data: {
          orgId: organizationId,
          capPolicyId: capId,
          action: 'deleted',
          previousValues: this.snapshot(existing),
          newValues: Prisma.JsonNull,
          actorUserId: actorUserId ?? null,
        },
      });
    });
    // Return the deleted cap so the controller can echo its plain sentence
    // ("Removed: Stop Claude spend at $200 …"), so writes show the human what
    // changed without the caller re-deriving the wording.
    return { deleted: true, cap: existing };
  }

  /**
   * The spend read-back the code-cost-clarity daemon polls. Returns the org total and, when a
   * dev is named, that dev's spend for the current period window (computed in UTC
   * server-side so every device agrees on the boundary).
   *
   * FAIL-OPEN CONTRACT: this endpoint never enforces anything. `spentUsd` is null
   * when there is no priced usage to report (honest absence, never a coerced 0);
   * the device treats null / stale / unreachable as no-block. `unpricedEventCount`
   * surfaces activity that arrived but could not be priced, so a caller can tell
   * "quiet" from "can't total this yet".
   */
  async getSpendReadback(organizationId: string, query: QuerySpendDto) {
    const now = new Date();
    const window = currentPeriodWindow(query.period as CapPeriod, now);
    const org = await this.aggregateSpend(organizationId, window);
    const dev = query.customerExternalId
      ? await this.aggregateSpend(organizationId, window, query.customerExternalId)
      : null;
    return {
      period: query.period,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      asOf: now.toISOString(),
      org,
      dev,
    };
  }

  /**
   * Internal coding spend for the current period, rolled up per
   * repo or per branch. The grouping math and its honesty contract live in
   * @marginfront/db's computeSpendBreakdown; this method only resolves the org.
   */
  async getSpendBreakdown(organizationId: string, query: QuerySpendBreakdownDto) {
    return computeSpendBreakdown(this.prisma, organizationId, query);
  }

  /**
   * The drill-down behind ONE branch row of getSpendBreakdown.
   * Same shared-path reasoning as getSpendBreakdown above.
   */
  async getSpendBreakdownDrill(organizationId: string, query: QuerySpendDrillDto) {
    return computeSpendBreakdownDrill(this.prisma, organizationId, query);
  }

  /**
   * Cap coverage per tool. The SAME numbers the Spend Controls tab shows, from the
   * ONE shared @marginfront/db path (getSpendCoverage), so the programmatic read and
   * the dashboard can never disagree. claudeCode and codex each report armed /
   * notArmed / unknown / total over the trailing 7 days. asOf is null when the window
   * is empty (no fabricated freshness).
   *
   * The top-level armed and total are the blended counts across both tools, so a
   * client that reads only those fields gets the blended number.
   */
  async getCoverage(organizationId: string) {
    const now = new Date();
    const coverage = await getSpendCoverage(this.prisma, organizationId, now);
    return {
      armed: coverage.armed,
      total: coverage.total,
      asOf: coverage.asOfMs === null ? null : new Date(coverage.asOfMs).toISOString(),
      claudeCode: coverage.claudeCode,
      codex: coverage.codex,
    };
  }

  /**
   * The ladder-alert evaluator, run once per cron
   * pass inside the single-cron dispatch. For every cap it measures the
   * SAME internal-spend aggregate the /control/spend read-back serves (aggregateSpend — one
   * math path, so an alert can never disagree with the number the device brakes
   * on), decides which ladder rungs the spend has crossed, and sends ONE heads-up
   * for the highest newly-crossed rung. Lower rungs crossed in the same jump are
   * recorded (suppressed, not emailed) so a $0->90% burst doesn't fire a stale
   * "you hit 50%" the next day.
   *
   * Idempotent: cap_alert_events carries a unique (capPolicyId, rung, windowStart)
   * key, so a re-run at the same spend re-sends nothing and a fresh period window
   * re-arms every rung. Recipients: the org's billing contact email, or —
   * when none is set — every current owner/finance member, so an org that never
   * filled in billing settings still hears its warnings. A rung records once ANY
   * recipient send lands (dead addresses are logged); only an all-fail leaves it
   * unrecorded, to retry next sweep. Honest-null (no priced internal spend) and
   * an EMPTY recipient chain both SKIP with a logged reason — never a crash,
   * never a fabricated 0%, never a burned rung. Per-cap errors are logged and
   * skipped, not allowed to kill the run.
   */
  async evaluateCapAlerts(
    now: Date = new Date(),
    orgId?: string,
  ): Promise<{
    evaluated: number;
    alertsSent: number;
    skipped: number;
    errors: { capPolicyId: string; error: string }[];
    durationMs: number;
  }> {
    const startedAtMs = Date.now();
    // With an orgId this is the ingest trigger's scoped check; without one it is
    // the daily dispatch's full backstop sweep.
    const caps = await this.prisma.cap_policies.findMany({
      ...(orgId ? { where: { orgId } } : {}),
      include: {
        organizations: {
          select: { id: true, name: true, billingIdentity: true, billing_email: true },
        },
      },
    });

    let evaluated = 0;
    let alertsSent = 0;
    let skipped = 0;
    const errors: { capPolicyId: string; error: string }[] = [];

    for (const cap of caps as any[]) {
      evaluated++;
      try {
        // Team caps have no dimension in the shared read-back (nor device
        // enforcement) — skip rather than invent a number. Only the org total
        // and a named dev are supported, exactly what aggregateSpend supports.
        if (cap.scope === 'team') {
          skipped++;
          this.logger.log(
            `[cap-alert] skip cap ${cap.id}: team-scoped caps have no shared spend read-back yet`,
          );
          continue;
        }

        // Provider-scoped caps have no per-provider spend decomposition (and no
        // device enforcement) — an all-provider total against a Claude-only
        // cap would be a WRONG percentage. The dashboard shows these caps with
        // no spend number for the same reason; the email stays consistent.
        if (cap.providerScope !== CAP_PROVIDER_SCOPE_ALL) {
          skipped++;
          this.logger.log(
            `[cap-alert] skip cap ${cap.id}: provider-scoped caps have no per-provider spend read-back yet`,
          );
          continue;
        }

        // The API rejects dev caps without a scopeValue, but this reads raw DB
        // rows — never fall back to org spend against a single-dev cap amount.
        if (cap.scope === 'dev' && !cap.scopeValue) {
          skipped++;
          this.logger.log(`[cap-alert] skip cap ${cap.id}: dev cap has no scopeValue`);
          continue;
        }

        const window = currentPeriodWindow(cap.period as CapPeriod, now);
        const devFilter =
          cap.scope === 'dev' && cap.scopeValue ? (cap.scopeValue as string) : undefined;
        const agg = await this.aggregateSpend(cap.orgId, window, devFilter);

        // Honest-null: no priced internal spend in the window -> no percentage ->
        // no alert. Never coerce null to 0.
        if (agg.spentUsd === null) {
          skipped++;
          continue;
        }

        const capUsd = toNumber(cap.amountUsd);
        if (capUsd <= 0) {
          skipped++;
          this.logger.log(`[cap-alert] skip cap ${cap.id}: cap amount is not positive`);
          continue;
        }

        const percentOfCap = (agg.spentUsd / capUsd) * 100;
        const thresholds = [...(cap.alertThresholds as number[])].sort((a, b) => a - b);
        const reached = thresholds.filter((rung) => percentOfCap >= rung);
        if (reached.length === 0) continue;

        const already = await this.prisma.cap_alert_events.findMany({
          where: { capPolicyId: cap.id, windowStart: window.start, rung: { in: reached } },
          select: { rung: true },
        });
        const alreadySent = new Set(already.map((r) => r.rung));
        const newlyReached = reached.filter((rung) => !alreadySent.has(rung));
        if (newlyReached.length === 0) continue;

        const recipients = await resolveAlertRecipients(this.prisma, cap.orgId, cap.organizations);
        if (recipients.length === 0) {
          // Nobody to send to — skip WITHOUT recording, so the rung fires the
          // moment someone resolvable exists. Never guess an address.
          skipped++;
          this.logger.log(
            `[cap-alert] skip cap ${cap.id}: org has no billing email and no owner/finance member to alert`,
          );
          continue;
        }

        const highest = Math.max(...newlyReached);
        // Send the single highest newly-crossed rung; the copy differs by mode.
        // Per-recipient guard: one dead address must not abort the cap AFTER
        // other sends landed — an unrecorded rung re-mails the healthy
        // recipients on every sweep (~5-minute ingest debounce) all window.
        const sentRecipients: string[] = [];
        let lastSendError: unknown = null;
        for (const recipient of recipients) {
          try {
            const sent = await this.email.sendCapAlertEmail({
              to: recipient,
              mode: cap.mode,
              rung: highest,
              scope: cap.scope,
              scopeValue: cap.scopeValue ?? null,
              providerScope: cap.providerScope,
              amountUsd: capUsd,
              period: cap.period,
              spentUsd: agg.spentUsd,
              percentOfCap,
              asOf: now,
            });
            // sendEmail returns null when Resend is unconfigured: that is NOT a sent
            // alert. Recording it would burn the rung silently on any env without
            // RESEND_API_KEY.
            if (sent !== null) sentRecipients.push(recipient);
          } catch (err) {
            lastSendError = err;
            this.logger.error(`[cap-alert] cap ${cap.id}: send to ${recipient} failed: ${err}`);
          }
        }
        if (sentRecipients.length === 0) {
          // Every send failed: record nothing so the next sweep retries.
          if (lastSendError) throw lastSendError;
          // Every send was a config null: skip without burning the rung.
          skipped++;
          this.logger.log(`[cap-alert] skip cap ${cap.id}: email delivery not configured`);
          continue;
        }

        // recipient is VarChar(255) — with a long fallback list, record who
        // leads rather than truncating an address mid-string. The final slice
        // guards a near-255-char first email: a P2000 here would leave the rung
        // unrecorded and re-send the same alert every sweep.
        const joinedRecipients = sentRecipients.join(', ');
        const recordedRecipient = (
          joinedRecipients.length <= 255
            ? joinedRecipients
            : `${sentRecipients[0]} +${sentRecipients.length - 1} more`
        ).slice(0, 255);

        // Record EVERY newly-crossed rung (the one we emailed + the lower ones we
        // jumped past) so none re-fires this window. The unique key double-guards
        // a concurrent re-run.
        for (const rung of newlyReached) {
          try {
            await this.prisma.cap_alert_events.create({
              data: {
                capPolicyId: cap.id,
                rung,
                windowStart: window.start,
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
        alertsSent++;
      } catch (err) {
        errors.push({
          capPolicyId: cap.id,
          error: err instanceof Error ? err.message : String(err),
        });
        this.logger.error(`[cap-alert] cap ${cap.id} failed: ${String(err)}`);
      }
    }

    const durationMs = Date.now() - startedAtMs;
    this.logger.log(
      `[cap-alert] evaluated ${evaluated} cap(s): ${alertsSent} alerted, ${skipped} skipped, ` +
        `${errors.length} error(s) in ${durationMs}ms${orgId ? ` (org ${orgId})` : ' (full sweep)'}`,
    );
    return { evaluated, alertsSent, skipped, errors, durationMs };
  }

  private async aggregateSpend(
    organizationId: string,
    window: { start: Date; end: Date },
    customerExternalId?: string,
  ) {
    // cccInternalEventFilter: caps total INTERNAL coding-agent spend only —
    // an org's customer-billing events share this table and must never count.
    const agg = await this.prisma.signal_events.aggregate({
      where: {
        organizationId,
        usageDate: { gte: window.start, lte: window.end },
        ...(customerExternalId ? { customerExternalId } : {}),
        ...cccInternalEventFilter(),
      },
      _sum: { usageCost: true },
      _count: { _all: true, usageCost: true },
    });
    const sum = agg._sum.usageCost;
    const eventCount = agg._count._all;
    const pricedCount = agg._count.usageCost;
    return {
      ...(customerExternalId ? { customerExternalId } : {}),
      spentUsd: sum === null || sum === undefined ? null : toNumber(sum),
      eventCount,
      unpricedEventCount: eventCount - pricedCount,
    };
  }

  private resolveScopeValue(scope: CapScope, scopeValue?: string): string | null {
    if (scope === 'org') {
      if (scopeValue) {
        throw new BadRequestException('An org ceiling has no scopeValue — omit it.');
      }
      return null;
    }
    if (!scopeValue) {
      throw new BadRequestException(`A ${scope} cap requires a scopeValue.`);
    }
    return scopeValue;
  }

  private async assertWithinCeiling(
    organizationId: string,
    scope: CapScope,
    providerScope: string,
    amountUsd: number,
  ): Promise<void> {
    const orgCaps = await this.prisma.cap_policies.findMany({
      where: { orgId: organizationId, scope: 'org' },
      select: { providerScope: true, amountUsd: true },
    });
    const result = checkCapWithinCeiling({
      scope,
      providerScope,
      amountUsd,
      orgCeilings: orgCaps.map((c) => ({
        providerScope: c.providerScope,
        amountUsd: toNumber(c.amountUsd),
      })),
    });
    if (!result.ok) {
      throw new BadRequestException(result.reason);
    }
  }

  /**
   * The ceiling rule from the org side, checked by SIMULATION: build the org's
   * ceiling set as it would look after this write (or removal), then re-resolve
   * every team/dev child against it — including children whose only constraint
   * is the 'all'-provider fallback. Checking same-provider children alone misses
   * the fallback path and lets the ceiling break. `newAmountUsd: null` means the
   * ceiling is being removed.
   */
  private async assertChildrenCoveredAfterChange(
    organizationId: string,
    providerScope: string,
    newAmountUsd: number | null,
    ignoreCapId?: string,
  ): Promise<void> {
    const [ceilings, children] = await Promise.all([
      this.prisma.cap_policies.findMany({
        where: {
          orgId: organizationId,
          scope: 'org',
          ...(ignoreCapId ? { id: { not: ignoreCapId } } : {}),
        },
        select: { providerScope: true, amountUsd: true },
      }),
      this.prisma.cap_policies.findMany({
        where: { orgId: organizationId, scope: { in: ['team', 'dev'] } },
        select: { scope: true, scopeValue: true, providerScope: true, amountUsd: true },
      }),
    ]);

    const simulated: OrgCeiling[] = ceilings
      .filter((c) => c.providerScope !== providerScope)
      .map((c) => ({ providerScope: c.providerScope, amountUsd: toNumber(c.amountUsd) }));
    if (newAmountUsd !== null) {
      simulated.push({ providerScope, amountUsd: newAmountUsd });
    }

    let worst: { label: string; amountUsd: number; ceilingUsd: number } | null = null;
    for (const child of children) {
      const ceilingUsd = resolveApplicableCeiling(child.providerScope, simulated);
      if (ceilingUsd === null) continue;
      const amountUsd = toNumber(child.amountUsd);
      if (amountUsd <= ceilingUsd) continue;
      if (!worst || amountUsd - ceilingUsd > worst.amountUsd - worst.ceilingUsd) {
        worst = {
          label:
            `${child.scope} cap of $${amountUsd} (provider "${child.providerScope}"` +
            (child.scopeValue ? `, target "${child.scopeValue}")` : ')'),
          amountUsd,
          ceilingUsd,
        };
      }
    }
    if (worst) {
      throw new BadRequestException(
        `This change would leave a ${worst.label} above its applicable org ceiling of ` +
          `$${worst.ceilingUsd}. Lower or remove that cap first — the org ceiling can never ` +
          `sit below a cap beneath it.`,
      );
    }
  }

  private snapshot(cap: CapRow): Prisma.InputJsonValue {
    return {
      scope: cap.scope,
      scopeValue: cap.scopeValue,
      providerScope: cap.providerScope,
      amountUsd: toNumber(cap.amountUsd),
      period: cap.period,
      mode: cap.mode,
      coolOffHours: cap.coolOffHours,
      alertThresholds: cap.alertThresholds,
    };
  }
}
