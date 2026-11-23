import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  findCreditPoolStrategy,
  getCreditBalance,
  getCreditBalances,
  toNumber,
  type CreditBalanceFilters,
  type CreditBalanceRow,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface CreditTopupInput {
  units: number;
  idempotencyKey: string;
  note?: string;
}

export interface CreditTopupResult {
  grantId: string;
  subscriptionId: string;
  unitsAdded: number;
  idempotencyKey: string;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  /** false when this key had already been used — the original grant came back. */
  created: boolean;
  /** The pool's drawable balance after the top-up, in usage units. */
  remainingUnits: number;
}

interface GrantRow {
  id: string;
  subscriptionId: string;
  amountUnits: unknown;
  consumedUnits: unknown;
  idempotencyKey: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/**
 * The server half of credit-pool visibility.
 *
 * READS delegate to the shared @marginfront/db credit-balance canon, so
 * GET /v1/credit-balances and the dashboard's own server action return the
 * same numbers by construction.
 *
 * WRITES are the two resolutions a human reaches for when a pool runs dry:
 * add units, or quiet the emails. Both are role-gated at the controller and
 * both are idempotent, because the dashboard, a retry, and a double-click all
 * hit the same endpoint.
 *
 * Track-only: nothing here gates ingest and nothing changes the invoice.
 * A top-up moves the countdown, never the bill.
 */
@Injectable()
export class CreditPoolService {
  private readonly logger = new Logger(CreditPoolService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listBalances(
    organizationId: string,
    filters: CreditBalanceFilters = {},
  ): Promise<{ balances: CreditBalanceRow[]; asOf: Date }> {
    const asOf = new Date();
    const balances = await getCreditBalances(this.prisma, organizationId, filters, asOf);
    return { balances, asOf };
  }

  async getBalance(organizationId: string, subscriptionId: string): Promise<CreditBalanceRow> {
    const row = await getCreditBalance(this.prisma, organizationId, subscriptionId);
    if (!row) {
      throw new NotFoundException(
        `No credit pool found for subscription ${subscriptionId}. Either the subscription ` +
          "doesn't belong to this organization, or its plan doesn't sell a credit pool. " +
          'Check the plan in Unit Economics then Plans, or list every pool with GET /v1/credit-balances.',
      );
    }
    return row;
  }

  /**
   * Add units to a pool. The grant carries periodStart = null so it can never
   * collide with the period grant's unique key, and expiresAt = null because a
   * customer who paid for extra units keeps them: draw order is
   * expiry-soonest-first, so the period grant still burns before the top-up.
   *
   * The append-only ledger IS the audit trail (createdBy + note on the grant
   * row). subscription_change_logs is deliberately NOT used: its changedBy FK
   * points at users and structurally cannot record an API-key caller.
   */
  async createTopup(
    organizationId: string,
    subscriptionId: string,
    createdBy: string,
    input: CreditTopupInput,
  ): Promise<CreditTopupResult> {
    const sub = await this.loadPooledSubscription(organizationId, subscriptionId);

    const existing = await this.findByIdempotencyKey(
      input.idempotencyKey,
      subscriptionId,
      input.units,
    );
    if (existing) return this.topupResult(existing, false);

    const now = new Date();
    let grant: GrantRow;
    try {
      grant = await this.prisma.$transaction(async (tx) => {
        // Read the pre-top-up balance BEFORE the grant lands, so the cache
        // seed below is an absolute value that the increment then moves.
        const balanceBefore = await this.drawableBalance(tx, sub.id, now);
        const created = (await tx.credit_grants.create({
          data: {
            subscriptionId: sub.id,
            organizationId,
            amountUnits: input.units,
            consumedUnits: 0,
            source: 'manual_topup',
            periodStart: null,
            effectiveAt: now,
            expiresAt: null,
            idempotencyKey: input.idempotencyKey,
            note: input.note ?? null,
            createdBy,
          },
        })) as GrantRow;

        // Cache: UPSERT then ATOMIC increment (the same pattern as
        // consumeUnits). A recomputed absolute SET would clobber a concurrent
        // consume's decrement between the read and the write. periodStart is
        // refreshed on the way through so a stale row left by a missed mint
        // stops describing the wrong period.
        let balanceAfterUnits = balanceBefore + input.units;
        if (sub.currentBillingPeriodStart) {
          await tx.credit_pool_balances.upsert({
            where: { subscriptionId: sub.id },
            create: {
              subscriptionId: sub.id,
              balanceUnits: balanceBefore,
              periodStart: sub.currentBillingPeriodStart,
            },
            update: {},
          });
          await tx.credit_pool_balances.updateMany({
            where: { subscriptionId: sub.id },
            data: {
              balanceUnits: { increment: input.units },
              periodStart: sub.currentBillingPeriodStart,
            },
          });
          const row = (await tx.credit_pool_balances.findUnique({
            where: { subscriptionId: sub.id },
            select: { balanceUnits: true },
          })) as { balanceUnits: unknown } | null;
          if (row) balanceAfterUnits = toNumber(row.balanceUnits);
        }
        // The ledger append is anchored to the cache read above, so the entry's
        // balanceAfterUnits and the cache row agree. A subscription with no
        // period has no cache row to describe it; the recompute stays truth.
        await tx.credit_ledger_entries.create({
          data: {
            grantId: created.id,
            subscriptionId: sub.id,
            kind: 'grant',
            deltaUnits: input.units,
            balanceAfterUnits,
            signalEventId: null,
          },
        });
        return created;
      });
    } catch (err) {
      // A concurrent retry winning the unique idempotencyKey IS the guarantee
      // working: hand back the grant that landed, never a second one.
      const raced = await this.findByIdempotencyKey(
        input.idempotencyKey,
        subscriptionId,
        input.units,
      );
      if (raced) return this.topupResult(raced, false);
      throw err;
    }

    this.logger.log(
      `[credit-pool] top-up ${input.units} units on subscription ${sub.id} ` +
        `(grant ${grant.id}, by ${createdBy})`,
    );
    return this.topupResult(grant, true);
  }

  /**
   * Silence or resume this subscription's credit-pool emails. Explicit state,
   * never a toggle, so a double-submit and a retry land in the same place.
   */
  async setAlertsPaused(
    organizationId: string,
    subscriptionId: string,
    paused: boolean,
  ): Promise<{ subscriptionId: string; alertsPaused: boolean }> {
    const sub = (await this.prisma.subscriptions.findFirst({
      where: { id: subscriptionId, organizationId, deletedAt: null },
      select: { id: true, creditAlertsPaused: true },
    })) as { id: string; creditAlertsPaused: boolean } | null;
    if (!sub) {
      throw new NotFoundException(
        `Subscription ${subscriptionId} was not found in this organization. Check the id, ` +
          'or list your pools with GET /v1/credit-balances.',
      );
    }

    if (sub.creditAlertsPaused !== paused) {
      await this.prisma.subscriptions.update({
        where: { id: sub.id },
        data: { creditAlertsPaused: paused },
      });
    }
    return { subscriptionId: sub.id, alertsPaused: paused };
  }

  /** The subscription, proven to belong to the org AND to sell a credit pool. */
  private async loadPooledSubscription(organizationId: string, subscriptionId: string) {
    const sub = (await this.prisma.subscriptions.findFirst({
      where: { id: subscriptionId, organizationId, deletedAt: null },
      select: { id: true, planId: true, currentBillingPeriodStart: true },
    })) as { id: string; planId: string; currentBillingPeriodStart: Date | null } | null;
    if (!sub) {
      throw new NotFoundException(
        `Subscription ${subscriptionId} was not found in this organization. Check the id, ` +
          'or list your pools with GET /v1/credit-balances.',
      );
    }
    const strategy = await findCreditPoolStrategy(this.prisma, sub.planId);
    if (!strategy) {
      throw new BadRequestException(
        "This subscription's plan doesn't sell a credit pool, so there is no pool to add " +
          'units to. Add a credit-pool pricing strategy to the plan first, in Unit Economics then Plans.',
      );
    }
    return sub;
  }

  /**
   * The grant this key already created, or null. Stripe's rule: a key replay
   * must describe the SAME intent. A key reused with different units, or on a
   * different subscription, is a caller bug, and returning the original grant
   * would silently swallow the top-up they thought they just made.
   */
  private async findByIdempotencyKey(
    idempotencyKey: string,
    subscriptionId: string,
    units: number,
  ): Promise<GrantRow | null> {
    const grant = (await this.prisma.credit_grants.findFirst({
      where: { idempotencyKey },
      select: {
        id: true,
        subscriptionId: true,
        amountUnits: true,
        consumedUnits: true,
        idempotencyKey: true,
        note: true,
        createdBy: true,
        createdAt: true,
      },
    })) as GrantRow | null;
    if (!grant) return null;
    if (grant.subscriptionId !== subscriptionId) {
      throw new ConflictException(
        `The key "${idempotencyKey}" was already used to top up a different subscription. ` +
          'Each key belongs to exactly one top-up across all subscriptions. Send a new key.',
      );
    }
    const priorUnits = toNumber(grant.amountUnits);
    if (priorUnits !== toNumber(units)) {
      throw new ConflictException(
        `The key "${idempotencyKey}" was already used to add ${priorUnits} units, but this ` +
          `request asks for ${units}. Reuse a key only to retry the exact same top-up. ` +
          'Send a new key to add a different amount.',
      );
    }
    return grant;
  }

  private async topupResult(grant: GrantRow, created: boolean): Promise<CreditTopupResult> {
    return {
      grantId: grant.id,
      subscriptionId: grant.subscriptionId,
      unitsAdded: toNumber(grant.amountUnits),
      idempotencyKey: grant.idempotencyKey as string,
      note: grant.note,
      createdBy: grant.createdBy,
      createdAt: grant.createdAt,
      created,
      remainingUnits: await this.drawableBalance(this.prisma, grant.subscriptionId, new Date()),
    };
  }

  /** Drawable units at `at`: effective, not yet expired. Mirrors the ledger's
   * own recompute (credit-ledger.ts drawableBalance). */
  private async drawableBalance(client: any, subscriptionId: string, at: Date): Promise<number> {
    const grants = (await client.credit_grants.findMany({
      where: {
        subscriptionId,
        effectiveAt: { lte: at },
        OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
      },
      select: { amountUnits: true, consumedUnits: true },
    })) as Array<{ amountUnits: unknown; consumedUnits: unknown }>;
    return grants.reduce((sum, g) => sum + toNumber(g.amountUnits) - toNumber(g.consumedUnits), 0);
  }
}
