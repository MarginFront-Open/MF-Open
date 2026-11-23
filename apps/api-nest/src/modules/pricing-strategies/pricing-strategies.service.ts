import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import {
  Prisma,
  deriveCreditPool,
  isLivePoolStrategy,
  type CreditPoolTier,
  type PlanStrategyState,
} from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatePricingStrategyDto } from './dto/create-pricing-strategy.dto';
import { UpdatePricingStrategyDto } from './dto/update-pricing-strategy.dto';
import { QueryPricingStrategyDto } from './dto/query-pricing-strategy.dto';
import { BulkUpdatePricingStrategiesDto } from './dto/bulk-update-pricing-strategies.dto';
// Every write below can put tiers on a credit_pool strategy, so every write
// below runs the ONE shared shape rule from @marginfront/db against the merged
// (stored + incoming) state. See common/utils/credit-pool for the merge semantics.
import {
  assertCreditPoolInput,
  assertCreditPoolShape,
  assertCreditRatesReferences,
  assertSinglePoolPerPlan,
  mergeStrategyState,
  touchesCreditPoolFields,
  touchesPoolMembership,
} from '../../common/utils/credit-pool';
import { v4 as uuidv4 } from 'uuid';

const POOL_MEMBERSHIP_SELECT = {
  id: true,
  name: true,
  pricingModel: true,
  chargeType: true,
  active: true,
  deletedAt: true,
  // The creditRates reference rule reads these two.
  signalId: true,
  creditRates: true,
} as const;

/** A patch/row actually carries rates (null, undefined, and {} all don't). */
function carriesRates(creditRates: unknown): boolean {
  return (
    creditRates != null &&
    typeof creditRates === 'object' &&
    !Array.isArray(creditRates) &&
    Object.keys(creditRates as object).length > 0
  );
}

/**
 * Every response carrying a strategy carries its derived pool view — writes as
 * well as reads, so what you POST really is what you GET back. Null on any row
 * whose tiers aren't a clean pool; never a fabricated view.
 */
function withCreditPool<T extends { tiers: unknown }>(row: T) {
  return { ...row, creditPool: deriveCreditPool(row.tiers) };
}

@Injectable()
export class PricingStrategiesService {
  private readonly logger = new Logger(PricingStrategiesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rejects a write that would leave the plan with more live credit pools than
   * it started with. Only queries when the write could actually change that —
   * a rename or a rate change never reaches here.
   */
  private async assertPlanPoolLimit(
    planId: string,
    mergedById: Map<string, PlanStrategyState>,
    createdRows: PlanStrategyState[],
  ) {
    const changed = [...mergedById.values(), ...createdRows];
    if (!changed.some(isLivePoolStrategy)) {
      return;
    }
    const siblings = (await this.prisma.pricing_strategies.findMany({
      where: { planId, deletedAt: null },
      select: POOL_MEMBERSHIP_SELECT,
    })) as PlanStrategyState[];

    const afterWrite = siblings
      .map((row) => (row.id && mergedById.has(row.id) ? mergedById.get(row.id)! : row))
      .concat(createdRows);

    assertSinglePoolPerPlan(afterWrite, siblings);
  }

  /**
   * The DB-aware creditRates rules. `patchRates` are the maps THIS
   * request writes (patch-carried only — merged/stored rates are exempt from
   * the live-signal check so a since-deleted member signal can't brick the
   * pool's edits). The double-billing half runs against the post-write plan
   * state, so it also catches the back door: activating or re-pointing a
   * usage strategy onto a signal an existing pool's rates already name.
   */
  private async assertCreditRatesRules(
    organizationId: string,
    planId: string,
    patchRates: Array<{ creditRates?: unknown; label?: string }>,
    mergedById: Map<string, PlanStrategyState>,
    createdRows: PlanStrategyState[],
  ) {
    const ratedWrites = patchRates.filter((w) => carriesRates(w.creditRates));
    const changed = [...mergedById.values(), ...createdRows];
    const changesLiveUsage = changed.some(
      (row) =>
        row.chargeType === 'usage' &&
        row.active === true &&
        (row.deletedAt === null || row.deletedAt === undefined),
    );
    if (ratedWrites.length === 0 && !changesLiveUsage) {
      return;
    }

    const keys = [...new Set(ratedWrites.flatMap((w) => Object.keys(w.creditRates as object)))];
    const [signals, siblings] = await Promise.all([
      keys.length > 0
        ? this.prisma.signals.findMany({
            where: { id: { in: keys }, orgId: organizationId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
      this.prisma.pricing_strategies.findMany({
        where: { planId, deletedAt: null },
        select: POOL_MEMBERSHIP_SELECT,
      }),
    ]);

    const afterWrite = (siblings as PlanStrategyState[])
      .map((row) => (row.id && mergedById.has(row.id) ? mergedById.get(row.id)! : row))
      .concat(createdRows);

    assertCreditRatesReferences({
      writes: ratedWrites,
      orgLiveSignalIds: (signals as Array<{ id: string }>).map((s) => s.id),
      planStrategies: afterWrite,
    });
  }

  async createBulk(organizationId: string, planId: string, strategies: CreatePricingStrategyDto[]) {
    this.logger.log(`Creating ${strategies.length} pricing strategies for plan: ${planId}`);

    if (!strategies || strategies.length === 0) {
      throw new BadRequestException('At least one strategy is required');
    }

    // Verify plan exists and belongs to organization
    const plan = await this.prisma.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId: organizationId,
        deletedAt: null,
      },
    });

    if (!plan) {
      throw new NotFoundException('Pricing plan not found');
    }

    // Verify agent exists (use first strategy's agentId)
    const agentId = strategies[0].agentId;
    const agent = await this.prisma.agents.findFirst({
      where: {
        id: agentId,
        orgId: organizationId,
        deletedAt: null,
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    // Validate signals for usage-based strategies
    for (const strategy of strategies) {
      if (strategy.chargeType === 'usage' && strategy.signalId) {
        const signal = await this.prisma.signals.findFirst({
          where: {
            id: strategy.signalId,
            orgId: organizationId,
            agentId: strategy.agentId,
            deletedAt: null,
          },
        });

        if (!signal) {
          throw new NotFoundException(`Signal not found for strategy: ${strategy.name}`);
        }
      }
    }

    // Every row is checked BEFORE any row is written, so a bad
    // strategy in position 3 can't leave rows 1 and 2 already created.
    const compiledTiers = new Map<number, CreditPoolTier[]>();
    const incomingRows: PlanStrategyState[] = strategies.map((strategy, index) => {
      assertCreditPoolInput(strategy, strategy.name);
      const merged = {
        pricingModel: strategy.pricingModel,
        chargeType: strategy.chargeType,
        tiers: strategy.tiers,
        minimumCommitment: strategy.minimumCommitment,
        active: strategy.active ?? true,
        creditPool: strategy.creditPool,
        creditRates: strategy.creditRates,
      };
      const compiled = assertCreditPoolShape(merged, strategy.name);
      if (compiled) {
        compiledTiers.set(index, compiled);
      }
      return { name: strategy.name, signalId: strategy.signalId ?? null, ...merged };
    });
    await this.assertPlanPoolLimit(planId, new Map(), incomingRows);
    await this.assertCreditRatesRules(
      organizationId,
      planId,
      strategies.map((strategy) => ({
        creditRates: strategy.creditRates,
        label: strategy.name,
      })),
      new Map(),
      incomingRows,
    );

    // Create all strategies
    const createdStrategies = await Promise.all(
      strategies.map((strategy, index) => {
        const tiers = compiledTiers.get(index) ?? strategy.tiers;
        return this.prisma.pricing_strategies.create({
          data: {
            id: uuidv4(),
            name: strategy.name,
            agentId: strategy.agentId,
            orgId: organizationId,
            planId: planId,
            signalId: strategy.signalId || null,
            tags: strategy.tags ? (strategy.tags as any) : Prisma.JsonNull,
            chargeType: strategy.chargeType as any,
            pricingModel: strategy.pricingModel as any,
            billingFrequency: strategy.billingFrequency as any,
            tiers: tiers ? (tiers as any) : Prisma.JsonNull,
            creditRates: strategy.creditRates ? (strategy.creditRates as any) : Prisma.JsonNull,
            rate: strategy.rate ?? null,
            active: strategy.active ?? true,
            minimumCommitment: strategy.minimumCommitment ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }),
    );

    return createdStrategies.map(withCreditPool);
  }

  async bulkUpdate(
    organizationId: string,
    planId: string,
    bulkUpdateDto: BulkUpdatePricingStrategiesDto,
  ) {
    this.logger.log(`Bulk updating strategies for plan: ${planId}`);

    // Verify plan exists
    const plan = await this.prisma.pricing_plans.findFirst({
      where: {
        id: planId,
        orgId: organizationId,
        deletedAt: null,
      },
    });

    if (!plan) {
      throw new NotFoundException('Pricing plan not found');
    }

    const { new: newStrategies = [], update: updateStrategies = [] } = bulkUpdateDto.strategies;

    const result = {
      created: { count: 0, strategies: [] as any[] },
      updated: { count: 0, strategies: [] as any[] },
    };

    // Process updates first
    if (updateStrategies.length > 0) {
      const strategyIds = updateStrategies.map((s) => s.id);

      // Fetch all strategies to update
      const existingStrategies = await this.prisma.pricing_strategies.findMany({
        where: {
          id: { in: strategyIds },
          orgId: organizationId,
          planId: planId,
          deletedAt: null,
        },
      });

      // Check if all strategies exist
      if (existingStrategies.length !== strategyIds.length) {
        const foundIds = existingStrategies.map((s) => s.id);
        const missingIds = strategyIds.filter((id) => !foundIds.includes(id));
        throw new NotFoundException(`Strategies not found: ${missingIds.join(', ')}`);
      }

      // Validate the whole batch against its MERGED state before
      // writing any of it. Merged, because `{pricingModel:'credit_pool'}` and
      // `{minimumCommitment:500}` each break a pool while touching nothing the
      // patch alone would flag.
      const compiledTiers = new Map<string, CreditPoolTier[]>();
      const mergedById = new Map<string, PlanStrategyState>();
      const patchRates: Array<{ creditRates?: unknown; label?: string }> = [];
      for (const updateItem of updateStrategies) {
        const { id, ...updateData } = updateItem;
        const existing = existingStrategies.find((s) => s.id === id)!;
        assertCreditPoolInput(updateData, existing.name);
        if (updateData.creditRates != null) {
          patchRates.push({ creditRates: updateData.creditRates, label: existing.name });
        }
        if (!touchesPoolMembership(updateData)) {
          continue;
        }
        const merged = mergeStrategyState(existing, updateData);
        mergedById.set(id, {
          id,
          name: existing.name,
          signalId: updateData.signalId !== undefined ? updateData.signalId : existing.signalId,
          ...merged,
        });
        if (touchesCreditPoolFields(updateData)) {
          const compiled = assertCreditPoolShape(merged, existing.name);
          if (compiled) {
            compiledTiers.set(id, compiled);
          }
        }
      }
      await this.assertPlanPoolLimit(planId, mergedById, []);
      await this.assertCreditRatesRules(organizationId, planId, patchRates, mergedById, []);

      // Process each update
      for (const updateItem of updateStrategies) {
        const { id, ...updateData } = updateItem;

        // Validate agent if changing
        if (updateData.agentId) {
          const agent = await this.prisma.agents.findFirst({
            where: {
              id: updateData.agentId,
              orgId: organizationId,
              deletedAt: null,
            },
          });

          if (!agent) {
            throw new NotFoundException(`Agent not found for strategy update: ${id}`);
          }
        }

        // Validate signal if changing and charge type is usage
        if (updateData.signalId || updateData.chargeType === 'usage') {
          if (updateData.chargeType === 'usage' && updateData.signalId) {
            const signal = await this.prisma.signals.findFirst({
              where: {
                id: updateData.signalId,
                orgId: organizationId,
                deletedAt: null,
              },
            });

            if (!signal) {
              throw new NotFoundException(`Signal not found for strategy update: ${id}`);
            }
          }
        }

        // `creditPool` is input sugar, not a column — it MUST come out of the
        // spread or Prisma throws Unknown argument. It was already compiled
        // into tiers above. creditRates IS a column but a literal
        // null would throw on the Json? field, so it re-enters only when set
        // (null and undefined both mean "leave the rates alone").
        const {
          creditPool: _creditPool,
          creditRates: patchCreditRates,
          ...columnData
        } = updateData;
        const nextTiers = compiledTiers.get(id) ?? updateData.tiers;

        // Update strategy
        const updated = await this.prisma.pricing_strategies.update({
          where: { id },
          data: {
            ...columnData,
            tags: updateData.tags ? (updateData.tags as any) : undefined,
            chargeType: updateData.chargeType as any,
            pricingModel: updateData.pricingModel as any,
            billingFrequency: updateData.billingFrequency as any,
            tiers: nextTiers ? (nextTiers as any) : undefined,
            creditRates: patchCreditRates != null ? (patchCreditRates as any) : undefined,
            updatedAt: new Date(),
          },
        });

        result.updated.strategies.push(withCreditPool(updated));
      }

      result.updated.count = updateStrategies.length;
    }

    // Process new strategies
    if (newStrategies.length > 0) {
      const created = await this.createBulk(organizationId, planId, newStrategies);
      result.created.strategies = created;
      result.created.count = created.length;
    }

    return result;
  }

  async findAll(organizationId: string, planId: string, queryDto: QueryPricingStrategyDto) {
    this.logger.log(`Querying pricing strategies for plan: ${planId}`);

    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc', ...filters } = queryDto;

    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {
      orgId: organizationId,
      planId: planId,
      deletedAt: null,
    };

    // Add filters
    if (filters.name) {
      where.name = { contains: filters.name, mode: 'insensitive' };
    }

    if (filters.chargeType) {
      where.chargeType = filters.chargeType;
    }

    if (filters.pricingModel) {
      where.pricingModel = filters.pricingModel;
    }

    if (filters.active !== undefined) {
      where.active = filters.active;
    }

    // Execute query
    const [strategies, totalResults] = await Promise.all([
      this.prisma.pricing_strategies.findMany({
        where,
        include: {
          signals: {
            select: {
              id: true,
              name: true,
              shortName: true,
              type: true,
            },
          },
        },
        orderBy: {
          [sortBy]: sortOrder,
        },
        skip,
        take: limit,
      }),
      this.prisma.pricing_strategies.count({ where }),
    ]);

    const results = strategies.map((strategy) => ({
      ...withCreditPool(strategy),
      signal: strategy.signals,
      signals: undefined,
    }));

    return {
      results,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  async findOne(id: string, organizationId: string, planId: string) {
    this.logger.log(
      `Finding pricing strategy ${id} for plan ${planId} in organization ${organizationId}`,
    );

    const strategy = await this.prisma.pricing_strategies.findFirst({
      where: {
        id,
        orgId: organizationId,
        planId: planId,
        deletedAt: null,
      },
      include: {
        signals: {
          select: {
            id: true,
            name: true,
            shortName: true,
            type: true,
          },
        },
      },
    });

    if (!strategy) {
      throw new NotFoundException('Pricing strategy not found');
    }

    return {
      ...withCreditPool(strategy),
      signal: strategy.signals,
      signals: undefined,
    };
  }

  async update(
    id: string,
    organizationId: string,
    planId: string,
    updateDto: UpdatePricingStrategyDto,
  ) {
    this.logger.log(`Updating pricing strategy ${id} for plan ${planId}`);

    // Verify strategy exists, and keep the row: the credit-pool check
    // validates the MERGED state, which needs what's stored today.
    const existing = await this.findOne(id, organizationId, planId);

    // Validate agent if changing
    if (updateDto.agentId) {
      const agent = await this.prisma.agents.findFirst({
        where: {
          id: updateDto.agentId,
          orgId: organizationId,
          deletedAt: null,
        },
      });

      if (!agent) {
        throw new NotFoundException('Agent not found');
      }
    }

    // Validate signal if changing and charge type is usage
    if (updateDto.signalId || updateDto.chargeType === 'usage') {
      if (updateDto.chargeType === 'usage' && updateDto.signalId) {
        const signal = await this.prisma.signals.findFirst({
          where: {
            id: updateDto.signalId,
            orgId: organizationId,
            deletedAt: null,
          },
        });

        if (!signal) {
          throw new NotFoundException('Signal not found');
        }
      }
    }

    assertCreditPoolInput(updateDto, existing.name);

    let compiledTiers: CreditPoolTier[] | null = null;
    if (touchesPoolMembership(updateDto)) {
      const merged = mergeStrategyState(existing, updateDto);
      if (touchesCreditPoolFields(updateDto)) {
        compiledTiers = assertCreditPoolShape(merged, existing.name);
      }
      const mergedRow: PlanStrategyState = {
        id,
        name: existing.name,
        signalId: updateDto.signalId !== undefined ? updateDto.signalId : existing.signalId,
        ...merged,
      };
      await this.assertPlanPoolLimit(planId, new Map([[id, mergedRow]]), []);
      await this.assertCreditRatesRules(
        organizationId,
        planId,
        updateDto.creditRates != null
          ? [{ creditRates: updateDto.creditRates, label: existing.name }]
          : [],
        new Map([[id, mergedRow]]),
        [],
      );
    }

    // `creditPool` is input sugar, not a column — it MUST come out of the
    // spread or Prisma throws Unknown argument. creditRates IS a
    // column but a literal null would throw on the Json? field, so it
    // re-enters only when set (null and undefined both mean "leave alone").
    const { creditPool: _creditPool, creditRates: patchCreditRates, ...columnData } = updateDto;
    const nextTiers = compiledTiers ?? updateDto.tiers;

    const updated = await this.prisma.pricing_strategies.update({
      where: { id },
      data: {
        ...columnData,
        tags: updateDto.tags ? (updateDto.tags as any) : undefined,
        chargeType: updateDto.chargeType as any,
        pricingModel: updateDto.pricingModel as any,
        billingFrequency: updateDto.billingFrequency as any,
        tiers: nextTiers ? (nextTiers as any) : undefined,
        creditRates: patchCreditRates != null ? (patchCreditRates as any) : undefined,
        updatedAt: new Date(),
      },
    });

    return withCreditPool(updated);
  }

  async remove(id: string, organizationId: string, planId: string) {
    this.logger.log(`Deleting pricing strategy ${id} for plan ${planId}`);

    // Verify strategy exists
    await this.findOne(id, organizationId, planId);

    // Soft delete
    await this.prisma.pricing_strategies.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return { message: 'Pricing strategy deleted successfully' };
  }
}
