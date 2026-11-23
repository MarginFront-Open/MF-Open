import { randomUUID } from 'crypto';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { API_KEY_ACTOR_SENTINEL } from '../../common/helpers/get-user-id';
import { SubscriptionBillingService } from './subscription-billing.service';
import {
  CreateSubscriptionDto,
  UpdateSubscriptionDto,
  UpdateInvoiceDatesDto,
  QuerySubscriptionDto,
  QueryChangelogDto,
} from './dto';
import {
  submittedBillingAnchors,
  billingAnchorImmutableMessage,
} from './dto/update-subscription.dto';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: SubscriptionBillingService,
  ) {}

  /**
   * Fail CLOSED on a missing tenant org BEFORE any org-scoped query runs.
   *
   * The tenant reads below filter by the caller's organizationId (sourced from the
   * authenticated principal). But a Better Auth JWT (validateJwt in
   * combined-auth.guard.ts sets NO organizationId) or an org-less session can arrive
   * with it undefined. Prisma SILENTLY DROPS any `where` key whose value is undefined,
   * so `{ id, organizationId: undefined }` collapses to `{ id }` and the changelog's
   * `{ subscriptions: { organizationId: undefined } }` collapses to an unconstrained
   * relation filter — a cross-tenant read. Throwing here guarantees an
   * undefined/null org can never silently disable
   * the filter. Same fail-closed precedent as get-user-id.ts and OrgRoleGuard;
   * NotFoundException keeps the deny opaque and uniform.
   */
  private assertOrgContext(orgId: string): void {
    if (!orgId) {
      throw new NotFoundException('No organization context');
    }
  }

  async createSubscription(orgId: string, userId: string, dto: CreateSubscriptionDto) {
    const customer = await this.prisma.customers.findUnique({
      where: { id: dto.customerId },
    });

    if (!customer || customer.organizationId !== orgId) {
      throw new NotFoundException('Customer not found');
    }

    const pricingPlan = await this.prisma.pricing_plans.findUnique({
      where: { id: dto.planId },
    });

    if (!pricingPlan || pricingPlan.orgId !== orgId) {
      throw new NotFoundException('Pricing plan not found');
    }

    const agent = await this.prisma.agents.findUnique({
      where: { id: dto.agentId },
    });

    if (!agent || agent.orgId !== orgId) {
      throw new NotFoundException('Agent not found');
    }

    const now = new Date();
    const startDate = new Date(dto.startDate);
    const status = (dto.status || (startDate <= now ? 'active' : 'upcoming')) as any;

    const timezone = dto.timezone || customer.timezone || 'UTC';
    const billingDay = dto.billingDay || startDate.getDate();

    const subscription = await this.prisma.subscriptions.create({
      data: {
        id: this.generateUuid(),
        name: dto.name,
        organizationId: orgId,
        customerId: dto.customerId,
        planId: dto.planId,
        agentId: dto.agentId,
        startDate,
        endDate: dto.endDate || null,
        isForever: dto.isForever ?? false,
        status,
        subscriptionDetails: dto.subscriptionDetails || {},
        billingCycle: (dto.billingCycle || 'monthly') as any,
        seatsCount: dto.seatsCount ?? 0,
        customCycleDays: dto.customCycleDays || null,
        proratedAmount: dto.proratedAmount ? String(dto.proratedAmount) : null,
        timezone,
        billingDay,
        billingModel: (dto.billingModel || 'subscription') as any,
        netTerms: dto.netTerms ?? 30,
        autoCollectPayment: dto.autoCollectPayment ?? false,
        invoiceMemo: dto.invoiceMemo || null,
        metadata: dto.metadata || {},
        cycleNumber: 0,
        currentBillingPeriodStart: startDate,
        currentBillingPeriodEnd: this.calculatePeriodEnd(
          startDate,
          dto.billingCycle || 'monthly',
          dto.customCycleDays,
        ),
        subscriptionInvoiceIssuanceDate: startDate,
        nextRecurringInvoiceAt: startDate,
        nextUsageInvoiceAt: this.calculatePeriodEnd(
          startDate,
          dto.billingCycle || 'monthly',
          dto.customCycleDays,
        ),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Create change log — only for human-initiated changes.
    // API-key-initiated changes are audited via api_key_usage_logs instead;
    // subscription_change_logs.changedBy has a UUID FK to users.id which no
    // API key satisfies.
    if (userId !== API_KEY_ACTOR_SENTINEL) {
      await this.prisma.subscription_change_logs.create({
        data: {
          id: this.generateUuid(),
          subscriptionId: subscription.id,
          changedBy: userId,
          changeType: 'created',
          previousValues: {} as any,
          newValues: subscription as any,
          changeReason: 'Initial subscription creation',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      });
    }

    return subscription;
  }

  async getSubscriptionsByOrg(orgId: string, query: QuerySubscriptionDto) {
    const { page = 1, limit = 10, includeDetails = false, ...filters } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      organizationId: orgId,
    };

    if (filters.status) where.status = filters.status;
    if (filters.planId) where.planId = filters.planId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.billingCycle) where.billingCycle = filters.billingCycle;
    if (filters.billingModel) where.billingModel = filters.billingModel;
    if (filters.startDate) {
      where.startDate = { gte: new Date(filters.startDate) };
    }
    if (filters.endDate) {
      where.endDate = { lte: new Date(filters.endDate) };
    }
    if (filters.search) {
      where.name = { contains: filters.search, mode: 'insensitive' };
    }

    const include = includeDetails
      ? {
          customers: true,
          pricing_plans: true,
          agents: true,
        }
      : undefined;

    const [subscriptions, totalResults] = await Promise.all([
      this.prisma.subscriptions.findMany({
        where,
        include,
        skip,
        take: limit,
        orderBy: filters.sortBy
          ? { [filters.sortBy]: filters.sortOrder || 'asc' }
          : { createdAt: 'desc' },
      }),
      this.prisma.subscriptions.count({ where }),
    ]);

    const results = subscriptions.map((sub: any) => ({
      ...sub,
      customer: sub.customers || null,
      plan: sub.pricing_plans || null,
      agent: sub.agents || null,
      // Remove Prisma relation names to avoid confusion
      customers: undefined,
      pricing_plans: undefined,
      agents: undefined,
    }));

    return {
      results,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  // orgId comes from the authenticated caller (controller-only method). It sits
  // BEFORE includeDetails because a required param can't follow a defaulted one
  // in TS. A cross-tenant subscription id 404s.
  async getSubscriptionById(
    subscriptionId: string,
    orgId: string,
    includeDetails: boolean = false,
  ) {
    this.assertOrgContext(orgId);
    const include = includeDetails
      ? {
          customers: true,
          pricing_plans: true,
          agents: true,
        }
      : undefined;

    const subscription = await this.prisma.subscriptions.findFirst({
      where: { id: subscriptionId, organizationId: orgId },
      include,
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    const sub = subscription as any;
    return {
      ...sub,
      customer: sub.customers || null,
      plan: sub.pricing_plans || null,
      agent: sub.agents || null,
      customers: undefined,
      pricing_plans: undefined,
      agents: undefined,
    };
  }

  async updateSubscription(
    subscriptionId: string,
    orgId: string,
    userId: string,
    dto: UpdateSubscriptionDto,
  ) {
    this.assertOrgContext(orgId);

    // Billing anchors are immutable after creation. Reject loudly rather
    // than let the field ride onto the DTO (global pipe is whitelist:false) and get
    // silently dropped by the field-by-field spread below — a silent no-op that would
    // return 200 while discarding the caller's dates. This is the service-side backstop to the
    // DTO's RejectsBillingAnchorMutation guard for any non-HTTP caller.
    const anchors = submittedBillingAnchors(dto as unknown as Record<string, unknown>);
    if (anchors.length > 0) {
      throw new BadRequestException(billingAnchorImmutableMessage(anchors));
    }

    // Cross-tenant write gate: scope the lookup to the caller's org so a
    // cross-tenant subscriptionId falls through to the NotFound below instead of
    // letting a money-role caller in org A edit (or cancel/pause/resume — all status
    // transitions flow through this one endpoint) org B's subscription by guessing
    // its id. OrgRoleGuard only proves the role, never that the target is theirs.
    const subscription = await this.prisma.subscriptions.findFirst({
      where: { id: subscriptionId, organizationId: orgId },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    const previousValues = { ...subscription };

    const updated = await this.prisma.subscriptions.update({
      where: { id: subscriptionId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.planId && { planId: dto.planId }),
        ...(dto.agentId && { agentId: dto.agentId }),
        ...(dto.endDate !== undefined && { endDate: dto.endDate }),
        ...(dto.isForever !== undefined && { isForever: dto.isForever }),
        ...(dto.subscriptionDetails && { subscriptionDetails: dto.subscriptionDetails }),
        ...(dto.billingCycle && { billingCycle: dto.billingCycle }),
        ...(dto.customCycleDays !== undefined && { customCycleDays: dto.customCycleDays }),
        ...(dto.proratedAmount !== undefined && {
          proratedAmount: dto.proratedAmount ? String(dto.proratedAmount) : null,
        }),
        ...(dto.timezone && { timezone: dto.timezone }),
        ...(dto.billingDay !== undefined && { billingDay: dto.billingDay }),
        ...(dto.billingModel && { billingModel: dto.billingModel }),
        ...(dto.netTerms !== undefined && { netTerms: dto.netTerms }),
        ...(dto.autoCollectPayment !== undefined && { autoCollectPayment: dto.autoCollectPayment }),
        ...(dto.invoiceMemo !== undefined && { invoiceMemo: dto.invoiceMemo }),
        ...(dto.metadata && { metadata: dto.metadata }),
        ...(dto.status && { status: dto.status }),
        updatedAt: new Date(),
      },
    });

    // Create change log — only for human-initiated changes.
    // API-key-initiated changes are audited via api_key_usage_logs instead;
    // subscription_change_logs.changedBy has a UUID FK to users.id which no
    // API key satisfies.
    if (userId !== API_KEY_ACTOR_SENTINEL) {
      await this.prisma.subscription_change_logs.create({
        data: {
          id: this.generateUuid(),
          subscriptionId: updated.id,
          changedBy: userId,
          changeType: 'updated',
          previousValues: previousValues as any,
          newValues: updated as any,
          changeReason: dto.changeReason,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      });
    }

    return updated;
  }

  async updateInvoiceDates(
    subscriptionId: string,
    orgId: string,
    userId: string,
    dto: UpdateInvoiceDatesDto,
  ) {
    this.assertOrgContext(orgId);
    // Cross-tenant write gate — scope the lookup to the caller's org so a
    // cross-tenant subscriptionId 404s instead of letting org A move org B's
    // invoice/billing dates by guessing its id.
    const subscription = await this.prisma.subscriptions.findFirst({
      where: { id: subscriptionId, organizationId: orgId },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    if (subscription.status !== 'active') {
      throw new BadRequestException('Can only update invoice dates for active subscriptions');
    }

    const previousValues = { ...subscription };

    const updated = await this.prisma.subscriptions.update({
      where: { id: subscriptionId },
      data: {
        ...(dto.subscriptionInvoiceIssuanceDate && {
          subscriptionInvoiceIssuanceDate: dto.subscriptionInvoiceIssuanceDate,
        }),
        ...(dto.billingDay !== undefined && { billingDay: dto.billingDay }),
        ...(dto.endDate !== undefined && { endDate: dto.endDate }),
        ...(dto.isForever !== undefined && { isForever: dto.isForever }),
        updatedAt: new Date(),
      },
    });

    // Create change log — only for human-initiated changes.
    // API-key-initiated changes are audited via api_key_usage_logs instead;
    // subscription_change_logs.changedBy has a UUID FK to users.id which no
    // API key satisfies.
    if (userId !== API_KEY_ACTOR_SENTINEL) {
      await this.prisma.subscription_change_logs.create({
        data: {
          id: this.generateUuid(),
          subscriptionId: updated.id,
          changedBy: userId,
          changeType: 'updated',
          previousValues: previousValues as any,
          newValues: updated as any,
          changeReason: dto.changeReason,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      });
    }

    return updated;
  }

  async getSubscriptionChangeLogs(subscriptionId: string, query: QueryChangelogDto, orgId: string) {
    this.assertOrgContext(orgId);
    const { page = 1, limit = 10, ...filters } = query;
    const skip = (page - 1) * limit;

    // subscription_change_logs has no org column, so scope through the parent
    // subscription relation — a cross-tenant subscription id yields an empty,
    // leak-free result set.
    const where: any = {
      subscriptionId,
      subscriptions: { organizationId: orgId },
    };

    if (filters.changeType) where.changeType = filters.changeType;
    if (filters.startDate) {
      where.createdAt = { ...where.createdAt, gte: new Date(filters.startDate) };
    }
    if (filters.endDate) {
      where.createdAt = { ...where.createdAt, lte: new Date(filters.endDate) };
    }

    const [changeLogs, totalResults] = await Promise.all([
      this.prisma.subscription_change_logs.findMany({
        where,
        skip,
        take: limit,
        orderBy: filters.sortBy
          ? { [filters.sortBy]: filters.sortOrder || 'desc' }
          : { createdAt: 'desc' },
        include: {
          users: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.subscription_change_logs.count({ where }),
    ]);

    return {
      results: changeLogs,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  private calculatePeriodEnd(
    startDate: Date,
    billingCycle: string,
    customCycleDays?: number,
  ): Date {
    const date = new Date(startDate);

    if (billingCycle === 'custom' && customCycleDays) {
      date.setDate(date.getDate() + customCycleDays);
    } else if (billingCycle === 'yearly') {
      date.setFullYear(date.getFullYear() + 1);
    } else {
      // monthly
      date.setMonth(date.getMonth() + 1);
    }

    return date;
  }

  private generateUuid(): string {
    return randomUUID();
  }
}
