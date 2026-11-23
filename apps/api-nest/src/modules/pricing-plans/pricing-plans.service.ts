import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Prisma, type PlanStrategyState } from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatePricingPlanDto } from './dto/create-pricing-plan.dto';
import { UpdatePricingPlanDto } from './dto/update-pricing-plan.dto';
import { QueryPricingPlanDto } from './dto/query-pricing-plan.dto';
import { CopyPricingPlanDto } from './dto/copy-pricing-plan.dto';
// The copy discounts every tier rate, so it is a tier write too.
import {
  assertCreditPoolShape,
  assertCreditRatesReferences,
  assertSinglePoolPerPlan,
} from '../../common/utils/credit-pool';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PricingPlansService {
  private readonly logger = new Logger(PricingPlansService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, createPricingPlanDto: CreatePricingPlanDto) {
    this.logger.log(`Creating pricing plan for organization: ${organizationId}`);

    // If linking to an agent, verify the agent belongs to this org
    if (createPricingPlanDto.agentId) {
      const agent = await this.prisma.agents.findFirst({
        where: {
          id: createPricingPlanDto.agentId,
          orgId: organizationId,
          deletedAt: null,
        },
      });

      if (!agent) {
        throw new NotFoundException('Agent not found');
      }
    }

    // Create the plan (org-level) and the junction entry in one transaction
    const planId = uuidv4();
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.pricing_plans.create({
        data: {
          id: planId,
          name: createPricingPlanDto.name,
          description: createPricingPlanDto.description,
          featuresList: createPricingPlanDto.featuresList
            ? (createPricingPlanDto.featuresList as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          orgId: organizationId,
          isActive: createPricingPlanDto.isActive ?? true,
          createdAt: now,
          updatedAt: now,
        },
      });

      // Link to the agent if one was provided
      if (createPricingPlanDto.agentId) {
        await tx.agent_pricing_plans.create({
          data: {
            agentId: createPricingPlanDto.agentId,
            planId: plan.id,
          },
        });
      }

      // Re-fetch with junction data
      return tx.pricing_plans.findFirstOrThrow({
        where: { id: plan.id },
        include: {
          agent_pricing_plans: {
            include: {
              agents: {
                select: { id: true, name: true, agentCode: true },
              },
            },
          },
        },
      });
    });
  }

  async findAll(organizationId: string, queryDto: QueryPricingPlanDto) {
    this.logger.log(`Querying pricing plans for organization: ${organizationId}`);

    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      includeStrategies = false,
      ...filters
    } = queryDto;

    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {
      orgId: organizationId,
      deletedAt: null,
    };

    if (filters.name) {
      where.name = { contains: filters.name, mode: 'insensitive' };
    }

    // Filter by agent through the junction table: many agents can offer one plan.
    if (filters.agentId) {
      where.agent_pricing_plans = { some: { agentId: filters.agentId } };
    }

    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    // Build include clause — linked agents via junction table
    const include: any = {
      agent_pricing_plans: {
        include: {
          agents: {
            select: { id: true, name: true, agentCode: true },
          },
        },
      },
    };

    if (includeStrategies) {
      include.pricing_strategies = {
        select: {
          id: true,
          name: true,
          chargeType: true,
          pricingModel: true,
          billingFrequency: true,
          tiers: true,
          rate: true,
          tags: true,
          active: true,
          signalId: true,
          signals: {
            select: {
              id: true,
              name: true,
              shortName: true,
              type: true,
            },
          },
        },
      };
    }

    const [pricingPlans, totalResults] = await Promise.all([
      this.prisma.pricing_plans.findMany({
        where,
        include,
        orderBy: {
          [sortBy]: sortOrder,
        },
        skip,
        take: limit,
      }),
      this.prisma.pricing_plans.count({ where }),
    ]);

    // Transform: flatten junction agents into an agents array
    const results = pricingPlans.map((plan) => ({
      ...plan,
      agents: plan.agent_pricing_plans?.map((link: any) => link.agents) ?? [],
      agent_pricing_plans: undefined,
      pricingStrategies: plan.pricing_strategies,
      pricing_strategies: undefined,
    }));

    return {
      results,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  async findOne(id: string, organizationId: string) {
    this.logger.log(`Finding pricing plan ${id} for organization ${organizationId}`);

    const pricingPlan = await this.prisma.pricing_plans.findFirst({
      where: {
        id,
        orgId: organizationId,
        deletedAt: null,
      },
      include: {
        agent_pricing_plans: {
          include: {
            agents: {
              select: { id: true, name: true, agentCode: true },
            },
          },
        },
        pricing_strategies: true,
      },
    });

    if (!pricingPlan) {
      throw new NotFoundException('Pricing plan not found');
    }

    return {
      ...pricingPlan,
      agents: pricingPlan.agent_pricing_plans?.map((link) => link.agents) ?? [],
      agent_pricing_plans: undefined,
      pricingStrategies: pricingPlan.pricing_strategies,
      pricing_strategies: undefined,
    };
  }

  async update(id: string, organizationId: string, updatePricingPlanDto: UpdatePricingPlanDto) {
    this.logger.log(`Updating pricing plan ${id} for organization ${organizationId}`);

    await this.findOne(id, organizationId);

    const updatedPlan = await this.prisma.pricing_plans.update({
      where: { id },
      data: {
        name: updatePricingPlanDto.name,
        description: updatePricingPlanDto.description,
        isActive: updatePricingPlanDto.isActive,
        featuresList: updatePricingPlanDto.featuresList
          ? (updatePricingPlanDto.featuresList as Prisma.InputJsonValue)
          : undefined,
        updatedAt: new Date(),
      },
    });

    return updatedPlan;
  }

  async remove(id: string, organizationId: string) {
    this.logger.log(`Deleting pricing plan ${id} for organization ${organizationId}`);

    await this.findOne(id, organizationId);

    await this.prisma.pricing_plans.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return { message: 'Pricing plan deleted successfully' };
  }

  /**
   * Copy a pricing plan, optionally applying a percentage discount to
   * rate / tier.rate at write-time.
   *
   * CANONICAL STATUS:
   *   Discount arithmetic here is a CONFIG change: the multiplier
   *   `(1 - discount / 100)` is baked into the new pricing_strategies
   *   row's `rate` / `tiers[].rate` field at insert time. Revenue-compute
   *   time still routes through the canonical `calcRouted` pipeline
   *   (packages/db/src/lib/revenue-calc.ts), which reads the discounted
   *   rate the same way it reads any other rate. No revenue-calculation
   *   arithmetic happens here; the new plan is indistinguishable from
   *   one a human typed in with the discounted values.
   */
  async copy(id: string, organizationId: string, copyDto: CopyPricingPlanDto) {
    this.logger.log(`Copying pricing plan ${id} for organization ${organizationId}`);

    const originalPlan = await this.prisma.pricing_plans.findFirst({
      where: {
        id,
        orgId: organizationId,
        deletedAt: null,
      },
      include: {
        pricing_strategies: true,
        agent_pricing_plans: { select: { agentId: true } },
      },
    });

    if (!originalPlan) {
      throw new NotFoundException('Pricing plan not found');
    }

    const { newName, newDescription, discount = 0, requestedYearly = false } = copyDto;

    const newPlanId = uuidv4();
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      // Create the new plan (org-level, no agentId)
      await tx.pricing_plans.create({
        data: {
          id: newPlanId,
          name: newName,
          description: newDescription || originalPlan.description,
          featuresList: originalPlan.featuresList
            ? (originalPlan.featuresList as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          orgId: originalPlan.orgId,
          isActive: originalPlan.isActive,
          createdAt: now,
          updatedAt: now,
        },
      });

      // Copy all agent links from the original plan
      if (originalPlan.agent_pricing_plans.length > 0) {
        await tx.agent_pricing_plans.createMany({
          data: originalPlan.agent_pricing_plans.map((link) => ({
            agentId: link.agentId,
            planId: newPlanId,
          })),
        });
      }

      // Copy pricing strategies with discount
      if (originalPlan.pricing_strategies && originalPlan.pricing_strategies.length > 0) {
        const newStrategies = originalPlan.pricing_strategies.map((strategy) => {
          let newRate: any = strategy.rate;
          let newTiers: any = strategy.tiers;

          if (discount > 0) {
            if (strategy.pricingModel === 'flat' && strategy.rate !== null) {
              const rateNum =
                typeof strategy.rate === 'number'
                  ? strategy.rate
                  : parseFloat(strategy.rate.toString());
              newRate = parseFloat((rateNum * (1 - discount / 100)).toFixed(2));
            } else if (strategy.tiers && Array.isArray(strategy.tiers)) {
              newTiers = (strategy.tiers as any[]).map((tier: any) => {
                const tierRate =
                  typeof tier.rate === 'number' ? tier.rate : parseFloat(tier.rate.toString());
                return {
                  ...tier,
                  rate: parseFloat((tierRate * (1 - discount / 100)).toFixed(2)),
                };
              });
            } else if (strategy.rate !== null) {
              const rateNum =
                typeof strategy.rate === 'number'
                  ? strategy.rate
                  : parseFloat(strategy.rate.toString());
              newRate = parseFloat((rateNum * (1 - discount / 100)).toFixed(2));
            }
          }

          return {
            id: uuidv4(),
            name: strategy.name,
            agentId: strategy.agentId,
            orgId: originalPlan.orgId,
            planId: newPlanId,
            signalId: strategy.signalId,
            tags: strategy.tags,
            chargeType: strategy.chargeType,
            pricingModel: strategy.pricingModel,
            billingFrequency:
              requestedYearly && strategy.billingFrequency === 'monthly'
                ? 'yearly'
                : strategy.billingFrequency,
            active: strategy.active,
            rate: newRate,
            tiers: newTiers,
            // Burn rates ride the copy untouched: they're CREDITS per unit,
            // not dollars, so the discount must never scale them. Conditional
            // because a literal null throws on Prisma's Json? column.
            ...(strategy.creditRates !== null ? { creditRates: strategy.creditRates } : {}),
            createdAt: now,
            updatedAt: now,
          };
        });

        // Revalidate AFTER the discount rewrite: the rewrite is what could
        // have turned a coherent pool into an incoherent one, and a copy is
        // how a stored degenerate row would otherwise get a fresh twin.
        const copiedRows: PlanStrategyState[] = newStrategies.map((strategy) => {
          assertCreditPoolShape(
            {
              pricingModel: strategy.pricingModel,
              chargeType: strategy.chargeType,
              tiers: strategy.tiers,
              creditRates: (strategy as { creditRates?: unknown }).creditRates,
              active: strategy.active,
            },
            strategy.name,
          );
          return {
            id: strategy.id,
            name: strategy.name,
            pricingModel: strategy.pricingModel,
            chargeType: strategy.chargeType,
            active: strategy.active,
            deletedAt: null,
            signalId: strategy.signalId,
            creditRates: (strategy as { creditRates?: unknown }).creditRates,
          };
        });
        // The copy lands on a brand-new plan, so the copied rows are the whole
        // after-write set and there is nothing to grandfather.
        assertSinglePoolPerPlan(copiedRows, []);
        // Copied burn rates re-checked against today's signals —
        // a member signal deleted since the original write must not ride into
        // a fresh plan. The copies ARE the whole plan state for the pair rule.
        const ratedCopies = copiedRows.filter(
          (row) =>
            row.creditRates != null &&
            typeof row.creditRates === 'object' &&
            !Array.isArray(row.creditRates) &&
            Object.keys(row.creditRates as object).length > 0,
        );
        if (ratedCopies.length > 0) {
          const rateKeys = [
            ...new Set(ratedCopies.flatMap((row) => Object.keys(row.creditRates as object))),
          ];
          const liveSignals = await tx.signals.findMany({
            where: { id: { in: rateKeys }, orgId: originalPlan.orgId, deletedAt: null },
            select: { id: true },
          });
          assertCreditRatesReferences({
            writes: ratedCopies.map((row) => ({
              creditRates: row.creditRates,
              label: typeof row.name === 'string' ? row.name : undefined,
            })),
            orgLiveSignalIds: liveSignals.map((s) => s.id),
            planStrategies: copiedRows,
          });
        }

        await tx.pricing_strategies.createMany({
          data: newStrategies as any[],
        });
      }

      return this.findOne(newPlanId, organizationId);
    });
  }

  /**
   * Link a pricing plan to an agent (many-to-many).
   * Creates a junction table entry so this agent "offers" this plan.
   */
  async linkAgent(planId: string, agentId: string, organizationId: string) {
    this.logger.log(`Linking plan ${planId} to agent ${agentId} for org ${organizationId}`);

    // Verify both exist and belong to this org
    const [plan, agent] = await Promise.all([
      this.prisma.pricing_plans.findFirst({
        where: { id: planId, orgId: organizationId, deletedAt: null },
      }),
      this.prisma.agents.findFirst({
        where: { id: agentId, orgId: organizationId, deletedAt: null },
      }),
    ]);

    if (!plan) throw new NotFoundException('Pricing plan not found');
    if (!agent) throw new NotFoundException('Agent not found');

    // Check for duplicate link
    const existing = await this.prisma.agent_pricing_plans.findFirst({
      where: { planId, agentId },
    });

    if (existing) {
      throw new ConflictException('Plan is already linked to this agent');
    }

    await this.prisma.agent_pricing_plans.create({
      data: { planId, agentId },
    });

    return { message: 'Plan linked to agent successfully' };
  }

  /**
   * Unlink a pricing plan from an agent.
   * Refuses if there are active subscriptions using this plan+agent combo.
   */
  async unlinkAgent(planId: string, agentId: string, organizationId: string) {
    this.logger.log(`Unlinking plan ${planId} from agent ${agentId} for org ${organizationId}`);

    const plan = await this.prisma.pricing_plans.findFirst({
      where: { id: planId, orgId: organizationId, deletedAt: null },
    });

    if (!plan) throw new NotFoundException('Pricing plan not found');

    // Check for active subscriptions
    const activeSubscriptions = await this.prisma.subscriptions.count({
      where: {
        planId,
        agentId,
        deletedAt: null,
        status: { in: ['active', 'pending'] },
      },
    });

    if (activeSubscriptions > 0) {
      throw new BadRequestException(
        `Cannot unlink — ${activeSubscriptions} active subscription${activeSubscriptions > 1 ? 's' : ''} use this plan with this agent`,
      );
    }

    await this.prisma.agent_pricing_plans.deleteMany({
      where: { planId, agentId },
    });

    return { message: 'Plan unlinked from agent successfully' };
  }
}
