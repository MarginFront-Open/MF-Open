import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ModelPricingService, isCostRefused } from '../event-processing/model-pricing.service';
import { recomputeParentUsageCost } from '../../common/utils/signal-event';
import { QuerySignalEventDto } from './dto/query-signal-event.dto';
import { DeleteSignalEventsDto } from './dto/delete-signal-events.dto';
import { EventAnalyticsQueryDto } from './dto/event-analytics-query.dto';
import { NeedsCostBackfillQueryDto } from './dto/needs-cost-backfill-query.dto';
import { MapModelDto } from './dto/map-model.dto';
import { MissingVolumeQueryDto } from './dto/missing-volume-query.dto';
import { FillVolumeDto } from './dto/fill-volume.dto';

@Injectable()
export class SignalEventsService {
  private readonly logger = new Logger(SignalEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly modelPricingService: ModelPricingService,
  ) {}

  async findAll(organizationId: string, queryDto: QuerySignalEventDto) {
    this.logger.log(`Querying signal events for organization: ${organizationId}`);

    const {
      page = 1,
      limit = 10,
      sortBy = 'usageDate',
      sortOrder = 'desc',
      customerExternalId,
      agentId,
      signalId,
      startDate,
      endDate,
    } = queryDto;

    const skip = (page - 1) * limit;

    const where: any = {
      organizationId,
    };

    if (customerExternalId) {
      where.customerExternalId = customerExternalId;
    }

    if (agentId) {
      where.agentId = agentId;
    }

    if (signalId) {
      where.signalId = signalId;
    }

    if (startDate || endDate) {
      where.usageDate = {};

      if (startDate) {
        where.usageDate.gte = new Date(startDate);
      }

      if (endDate) {
        where.usageDate.lte = new Date(endDate);
      }
    }

    const [events, totalResults] = await Promise.all([
      this.prisma.signal_events.findMany({
        where,
        include: {
          signals: {
            select: {
              id: true,
              name: true,
              shortName: true,
            },
          },
        },
        orderBy: {
          [sortBy]: sortOrder,
        },
        skip,
        take: limit,
      }),
      this.prisma.signal_events.count({ where }),
    ]);

    // Response shape: each event's `signals` relation exposed as `signal`.
    const results = events.map((event) => ({
      ...event,
      signal: event.signals,
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

  async bulkDelete(organizationId: string, deleteDto: DeleteSignalEventsDto) {
    this.logger.log(`Deleting signal events for organization: ${organizationId}`);

    const { eventIds } = deleteDto;

    // Hard delete: these rows are not soft-deleted.
    const result = await this.prisma.signal_events.deleteMany({
      where: {
        id: { in: eventIds },
        organizationId,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('No matching events found to delete');
    }

    return {
      deleted: result.count,
      message: `Successfully deleted ${result.count} event(s)`,
    };
  }

  /**
   * Event counts only — no $-valued aggregation belongs here. Cost totals for
   * the same window come from `SdkService.getUsageAnalytics`
   * (`GET /sdk/analytics/usage`), which routes through the canonical library.
   */
  async getAnalytics(organizationId: string, queryDto: EventAnalyticsQueryDto) {
    this.logger.log(`Getting event analytics for organization: ${organizationId}`);

    const { agentId, signalId } = queryDto;

    const endDate = queryDto.endDate ? new Date(queryDto.endDate) : new Date();
    const startDate = queryDto.startDate
      ? new Date(queryDto.startDate)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const whereConditions: any = {
      organizationId,
      usageDate: {
        gte: startDate,
        lte: endDate,
      },
    };

    if (agentId) {
      whereConditions.agentId = agentId;
    }

    if (signalId) {
      whereConditions.signalId = signalId;
    }

    const totalProcessedEvents = await this.prisma.signal_events.count({
      where: whereConditions,
    });

    const signalDistribution = await this.prisma.signal_events.groupBy({
      by: ['signalId'],
      where: whereConditions,
      _count: {
        id: true,
      },
      orderBy: {
        _count: {
          id: 'desc',
        },
      },
    });

    const signalIds = signalDistribution.map((d) => d.signalId).filter(Boolean) as string[];
    const signals = await this.prisma.signals.findMany({
      where: {
        id: { in: signalIds },
      },
      select: {
        id: true,
        name: true,
        shortName: true,
      },
    });

    const signalMap = new Map(signals.map((s) => [s.id, s]));

    const signalDistributionWithNames = signalDistribution.map((dist) => {
      const signal = dist.signalId ? signalMap.get(dist.signalId) : null;
      return {
        signalId: dist.signalId,
        signalName: signal?.name || 'Unknown',
        shortName: signal?.shortName || 'Unknown',
        count: dist._count.id,
      };
    });

    const rawEventsStats = {
      total: 0,
      PENDING: 0,
      PROCESSED: 0,
      ERROR: 0,
    };

    try {
      const rawEventsWhere: any = {
        organizationId,
        receivedAt: {
          gte: startDate,
          lte: endDate,
        },
      };

      const rawEventsGrouped = await this.prisma.raw_ingest_events.groupBy({
        by: ['status'],
        where: rawEventsWhere,
        _count: {
          id: true,
        },
      });

      rawEventsStats.total = rawEventsGrouped.reduce((sum, g) => sum + g._count.id, 0);
      rawEventsGrouped.forEach((group) => {
        rawEventsStats[group.status] = group._count.id;
      });
    } catch (error) {
      this.logger.warn('Could not fetch raw events stats (table may not exist)');
    }

    // Conditional fragments via Prisma.sql so the raw query stays parameterized.
    const agentCondition = agentId ? Prisma.sql`AND "agentId" = ${agentId}::uuid` : Prisma.empty;
    const signalCondition = signalId
      ? Prisma.sql`AND "signalId" = ${signalId}::uuid`
      : Prisma.empty;

    const dateWiseEvents = await this.prisma.$queryRaw<any[]>`
      SELECT
        DATE("usageDate") as date,
        "signalId",
        COUNT(*) as count
      FROM signal_events
      WHERE "organizationId" = ${organizationId}::uuid
        AND "usageDate" >= ${startDate}::timestamptz
        AND "usageDate" <= ${endDate}::timestamptz
        ${agentCondition}
        ${signalCondition}
      GROUP BY DATE("usageDate"), "signalId"
      ORDER BY date ASC, count DESC
    `;

    const dateWiseData: any = {};
    for (const record of dateWiseEvents) {
      const date = record.date.toISOString().split('T')[0];
      const signalId = record.signalId;
      const count = parseInt(record.count, 10);
      const signal = signalId ? signalMap.get(signalId) : null;

      if (!dateWiseData[date]) {
        dateWiseData[date] = [];
      }

      dateWiseData[date].push({
        signalId,
        signalName: signal?.name || 'Unknown',
        signalShortName: signal?.shortName || 'Unknown',
        count,
      });
    }

    return {
      timeRange: {
        startDate,
        endDate,
      },
      rawEvents: rawEventsStats,
      processedEvents: {
        total: totalProcessedEvents,
      },
      signalDistribution: signalDistributionWithNames,
      dateWiseEvents: Object.keys(dateWiseData)
        .sort()
        .map((date) => ({
          date,
          signals: dateWiseData[date],
        })),
    };
  }

  async getNeedsCostBackfill(organizationId: string, queryDto: NeedsCostBackfillQueryDto) {
    this.logger.log(`Querying needs-cost-backfill events for organization: ${organizationId}`);

    const endDate = queryDto.endDate ? new Date(queryDto.endDate) : new Date();
    const startDate = queryDto.startDate
      ? new Date(queryDto.startDate)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Group on the children, never on raw_ingest_events.payload: multi-service
    // events carry NULL model/provider at the parent level, which would collapse
    // every multi-service unmapped service into one (NULL, NULL) row.
    const groups = await this.prisma.$queryRaw<
      { model: string; provider: string; count: number; oldestEventDate: Date }[]
    >`
      SELECT
        ses.model              AS "model",
        ses."modelProvider"    AS "provider",
        COUNT(*)::int          AS "count",
        MIN(se."usageDate")    AS "oldestEventDate"
      FROM signal_event_services ses
      JOIN signal_events se ON ses."signalEventId" = se.id
      WHERE se."organizationId" = ${organizationId}::uuid
        AND ses."eventStatus" = 'NEEDS_COST_BACKFILL'
        AND se."usageDate" >= ${startDate}::timestamptz
        AND se."usageDate" <= ${endDate}::timestamptz
      GROUP BY ses.model, ses."modelProvider"
      ORDER BY "count" DESC
    `;

    const totalEvents = groups.reduce((sum, g) => sum + g.count, 0);

    return { groups, totalEvents };
  }

  // Map an unknown model onto a known pricing row, then retroactively price every
  // child left at NEEDS_COST_BACKFILL so already-issued invoices come out right.
  async mapModel(organizationId: string, dto: MapModelDto) {
    const normalizedModel = dto.sourceModel.trim().toLowerCase();
    const normalizedProvider = dto.sourceProvider.trim().toLowerCase();

    if (!normalizedModel || !normalizedProvider) {
      throw new BadRequestException('sourceModel and sourceProvider are required');
    }

    // Mapping in a short tx, per-child backfill outside it: a large match set
    // blows the 5-second Prisma transaction timeout.
    const { target, mapping } = await this.prisma.$transaction(async (tx) => {
      let target: any;

      if (dto.targetPricingId) {
        target = await tx.service_pricing.findUnique({
          where: { id: dto.targetPricingId },
        });
        if (!target) {
          throw new NotFoundException(`Target pricing row not found: ${dto.targetPricingId}`);
        }
      } else if (dto.targetModel && dto.targetProvider) {
        const targetModel = dto.targetModel.trim().toLowerCase();
        const targetProvider = dto.targetProvider.trim().toLowerCase();

        target = await tx.service_pricing.findFirst({
          where: {
            canonicalName: targetModel,
            provider: targetProvider,
            isActive: true,
          },
        });

        // Date-strip fallback (same regex as lookupModel)
        if (!target) {
          const stripped = targetModel.replace(/-(\d{4}-\d{2}-\d{2}|\d{6,8}|\d{3})$/, '');
          if (stripped !== targetModel && stripped.length > 0) {
            target = await tx.service_pricing.findFirst({
              where: {
                canonicalName: stripped,
                provider: targetProvider,
                isActive: true,
              },
            });
          }
        }

        if (!target) {
          throw new NotFoundException(
            `No active pricing found for model "${dto.targetModel}" provider "${dto.targetProvider}"`,
          );
        }
      } else {
        throw new BadRequestException(
          'Provide either targetPricingId or both targetModel and targetProvider',
        );
      }

      // Org-scoped mapping only: future events auto-resolve for THIS org and the
      // global service_pricing catalog is never hand-edited from here.
      const mapping = await tx.org_model_mappings.upsert({
        where: {
          organizationId_sourceModel_sourceProvider: {
            organizationId,
            sourceModel: normalizedModel,
            sourceProvider: normalizedProvider,
          },
        },
        create: {
          organizationId,
          sourceModel: normalizedModel,
          sourceProvider: normalizedProvider,
          targetPricingId: target.id,
        },
        update: {
          targetPricingId: target.id,
        },
      });
      this.logger.log(
        `[mapModel] created org mapping ${mapping.id}: ` +
          `${normalizedModel}/${normalizedProvider} → ${target.canonicalName}/${target.provider}`,
      );

      return { target, mapping };
    });

    // Every event has at least one mirroring child row, so working child-level
    // covers single- and multi-service events alike.
    const childrenToBackfill = await this.prisma.signal_event_services.findMany({
      where: {
        eventStatus: 'NEEDS_COST_BACKFILL',
        model: { equals: normalizedModel, mode: 'insensitive' },
        modelProvider: { equals: normalizedProvider, mode: 'insensitive' },
        signal_events: { organizationId },
      },
      select: {
        id: true,
        signalEventId: true,
        model: true,
        modelProvider: true,
        inputTokens: true,
        outputTokens: true,
        quantity: true,
        // Omit these and the recomputed cost drops cache spend the child is
        // already carrying, then stamps it PROCESSED.
        cacheReadTokens: true,
        cacheWriteTokens: true,
        // metadata carries the cache-write TTL hint, so a remap
        // re-derives the same rate the original event was priced at.
        signal_events: { select: { signalId: true, metadata: true } },
      },
    });

    // Pre-fetched pricing row keeps the resolver pure — no DB lookup per child.
    // resolveCost, not calculateCost: this path reads real cache tokens, and a
    // row missing a rate they used must refuse rather than price them at $0.
    const preFetched = {
      inputCost: target.inputCost ? Number(target.inputCost) : 0,
      outputCost: target.outputCost ? Number(target.outputCost) : 0,
      cacheReadCost: target.cacheReadCost != null ? Number(target.cacheReadCost) : undefined,
      cacheWriteCost: target.cacheWriteCost != null ? Number(target.cacheWriteCost) : undefined,
      costUnit: target.costUnit,
    };

    const affectedParents = new Set<string>();
    const declaredLinks = new Set<string>(); // dedupe (signalId, servicePricingId) upserts
    const refusedRates = new Set<string>();
    let refused = 0;
    let childrenUpdated = 0;

    for (const child of childrenToBackfill) {
      const inputTokens = child.inputTokens ?? 0;
      const outputTokens = child.outputTokens ?? 0;
      const quantity = child.quantity ? Number(child.quantity) : 1;
      const cacheReadTokens = Number(child.cacheReadTokens ?? 0);
      const cacheWriteTokens = Number(child.cacheWriteTokens ?? 0);

      const resolution = await this.modelPricingService.resolveCost(
        normalizedModel,
        inputTokens,
        outputTokens,
        quantity,
        child.modelProvider ?? normalizedProvider,
        preFetched,
        cacheReadTokens,
        cacheWriteTokens,
        (child.signal_events?.metadata as Record<string, unknown> | null | undefined)
          ?.cacheWriteTtl,
      );
      if (isCostRefused(resolution)) {
        refused += 1;
        for (const rate of resolution.missingRates) refusedRates.add(rate);
        this.logger.warn(`[mapModel] child ${child.id} left unresolved: ${resolution.reason}`);
        continue;
      }
      const costResult = resolution.cost;

      const usageCostData: Record<
        string,
        { cost: number; units: number | null; costPerUnit: number }
      > = {
        [`${child.model}/input`]: {
          cost: costResult.inputCostUsd.toNumber(),
          units: child.inputTokens,
          costPerUnit: costResult.inputCostPerToken,
        },
        [`${child.model}/output`]: {
          cost: costResult.outputCostUsd.toNumber(),
          units: child.outputTokens,
          costPerUnit: costResult.outputCostPerToken,
        },
      };
      // Cache lines only when the child stored counts, so a child with no cache
      // counts gets input and output lines only. `!= null`: a stored 0 is a real count.
      if (child.cacheReadTokens != null) {
        usageCostData[`${child.model}/cache_read`] = {
          cost: costResult.cacheReadCostUsd.toNumber(),
          units: cacheReadTokens,
          costPerUnit: costResult.cacheReadCostPerToken,
        };
      }
      if (child.cacheWriteTokens != null) {
        usageCostData[`${child.model}/cache_write`] = {
          cost: costResult.cacheWriteCostUsd.toNumber(),
          units: cacheWriteTokens,
          costPerUnit: costResult.cacheWriteCostPerToken,
        };
      }
      childrenUpdated += 1;

      await this.prisma.signal_event_services.update({
        where: { id: child.id },
        data: {
          servicePricingId: target.id,
          usageCost: costResult.totalCostUsd,
          usageCostData: usageCostData as Prisma.InputJsonValue,
          eventStatus: 'PROCESSED',
        },
      });

      affectedParents.add(child.signalEventId);

      // Auto-declare the (signal, servicePricing) link, mirroring recordUsage in
      // sdk.service.ts. Non-fatal by design: a link failure must not block the backfill.
      const signalId = child.signal_events.signalId;
      if (signalId) {
        const linkKey = `${signalId}|${target.id}`;
        if (!declaredLinks.has(linkKey)) {
          declaredLinks.add(linkKey);
          try {
            await this.prisma.signal_services.upsert({
              where: {
                signalId_servicePricingId: {
                  signalId,
                  servicePricingId: target.id,
                },
              },
              create: {
                id: crypto.randomUUID(),
                signalId,
                servicePricingId: target.id,
              },
              update: {},
            });
          } catch (linkErr: any) {
            this.logger.warn(
              `[mapModel] signal_services upsert failed (non-fatal): ` +
                `signalId=${signalId} servicePricingId=${target.id} ` +
                `error=${linkErr?.message ?? linkErr}`,
            );
          }
        }
      }
    }

    // recomputeParentUsageCost enforces both parent rules: usageCost = SUM(children)
    // or null if ANY child is unresolved, and eventProcessed flips to PROCESSED
    // only when EVERY child resolved — a resolved child keeps its own cost either way.
    for (const parentId of affectedParents) {
      await recomputeParentUsageCost(parentId, this.prisma as any);
    }

    this.logger.log(
      `[mapModel] backfilled ${childrenUpdated} children across ` +
        `${affectedParents.size} parent events` +
        (refused > 0 ? ` — ${refused} left unresolved (missing cache rates)` : ''),
    );

    return {
      backfilled: affectedParents.size,
      // Children actually priced, not considered: a refused child is still
      // unresolved and must never read as backfilled.
      childrenUpdated,
      refused,
      refusedRates: [...refusedRates],
      mappingId: mapping.id,
    };
  }

  /**
   * Carries costUnit from service_pricing so the UI knows whether to prompt for
   * tokens (LLM) or quantity (non-LLM).
   */
  async getMissingVolumeGroups(organizationId: string, queryDto: MissingVolumeQueryDto) {
    this.logger.log(`Querying missing-volume events for organization: ${organizationId}`);

    const endDate = queryDto.endDate ? new Date(queryDto.endDate) : new Date();
    const startDate = queryDto.startDate
      ? new Date(queryDto.startDate)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Group on the children, not raw_ingest_events.payload — same NULL
    // model/provider collapse as getNeedsCostBackfill. The service_pricing join
    // hangs off the child's model/modelProvider to keep costUnit for the prompt.
    const groups = await this.prisma.$queryRaw<
      {
        model: string;
        provider: string;
        costUnit: string | null;
        count: number;
        oldestEventDate: Date;
      }[]
    >`
      SELECT
        ses.model              AS "model",
        ses."modelProvider"    AS "provider",
        sp."costUnit"          AS "costUnit",
        COUNT(*)::int          AS "count",
        MIN(se."usageDate")    AS "oldestEventDate"
      FROM signal_event_services ses
      JOIN signal_events se ON ses."signalEventId" = se.id
      LEFT JOIN service_pricing sp
        ON LOWER(TRIM(sp."canonicalName")) = LOWER(TRIM(ses.model))
        AND LOWER(TRIM(sp.provider)) = LOWER(TRIM(ses."modelProvider"))
        AND sp."isActive" = true
      WHERE se."organizationId" = ${organizationId}::uuid
        AND ses."eventStatus" = 'MISSING_VOLUME_DATA'
        AND se."usageDate" >= ${startDate}::timestamptz
        AND se."usageDate" <= ${endDate}::timestamptz
      GROUP BY ses.model, ses."modelProvider", sp."costUnit"
      ORDER BY "count" DESC
    `;

    const totalEvents = groups.reduce((sum, g) => sum + g.count, 0);

    return { groups, totalEvents };
  }

  /**
   * The model is already known; the caller supplies only the missing volume —
   * tokens for LLM rows, quantity for non-LLM ones.
   */
  async fillVolume(organizationId: string, dto: FillVolumeDto) {
    const normalizedModel = dto.sourceModel.trim().toLowerCase();
    const normalizedProvider = dto.sourceProvider.trim().toLowerCase();

    // A hit is expected: the model was recognized at ingest, which is how the
    // child got MISSING_VOLUME_DATA rather than NEEDS_COST_BACKFILL.
    let target = await this.prisma.service_pricing.findFirst({
      where: {
        canonicalName: normalizedModel,
        provider: normalizedProvider,
        isActive: true,
      },
    });

    // Fallback: strip date suffix (same strategy as lookupModelInCatalog)
    if (!target) {
      const stripped = normalizedModel.replace(/-(\d{4}-\d{2}-\d{2}|\d{6,8}|\d{3})$/, '');
      if (stripped !== normalizedModel && stripped.length > 0) {
        target = await this.prisma.service_pricing.findFirst({
          where: {
            canonicalName: stripped,
            provider: normalizedProvider,
            isActive: true,
          },
        });
      }
    }

    if (!target) {
      throw new NotFoundException(
        `Model "${dto.sourceModel}" (provider "${dto.sourceProvider}") not found in ` +
          `service_pricing. This is unexpected for MISSING_VOLUME_DATA children. The model ` +
          `should have been recognized at ingestion time.`,
      );
    }

    const isLlm = target.costUnit === '1M tokens';

    if (isLlm && (dto.inputTokens == null || dto.outputTokens == null)) {
      throw new BadRequestException(
        `Model "${dto.sourceModel}" is an LLM (costUnit = "1M tokens"). ` +
          `Both inputTokens and outputTokens are required.`,
      );
    }

    if (!isLlm && dto.quantity == null) {
      throw new BadRequestException(
        `Model "${dto.sourceModel}" is a non-LLM service (costUnit = "${target.costUnit}"). ` +
          `quantity is required.`,
      );
    }

    // Child-level like mapModel: every event has at least one mirroring child.
    const childrenToFill = await this.prisma.signal_event_services.findMany({
      where: {
        eventStatus: 'MISSING_VOLUME_DATA',
        model: { equals: normalizedModel, mode: 'insensitive' },
        modelProvider: { equals: normalizedProvider, mode: 'insensitive' },
        signal_events: { organizationId },
      },
      select: {
        id: true,
        signalEventId: true,
        model: true,
        modelProvider: true,
        // MISSING_VOLUME_DATA is about input/output only; the cache counts were
        // captured at ingest and must be priced back in, not dropped.
        cacheReadTokens: true,
        cacheWriteTokens: true,
        // metadata carries the cache-write TTL hint, as in mapModel.
        signal_events: { select: { signalId: true, metadata: true } },
      },
    });

    if (childrenToFill.length === 0) {
      return { backfilled: 0, childrenUpdated: 0, refused: 0, refusedRates: [] };
    }

    // The caller's volume applies to EVERY matching child — two same-model calls
    // in one outcome cannot be told apart (a known limitation). Cache counts are
    // the exception, read per child, so pricing has to happen inside the loop.
    const costEntry = {
      inputCost: target.inputCost ? Number(target.inputCost) : 0,
      outputCost: target.outputCost ? Number(target.outputCost) : 0,
      cacheReadCost: target.cacheReadCost != null ? Number(target.cacheReadCost) : undefined,
      cacheWriteCost: target.cacheWriteCost != null ? Number(target.cacheWriteCost) : undefined,
      costUnit: target.costUnit,
    };

    const affectedParents = new Set<string>();
    const declaredLinks = new Set<string>();
    const refusedRates = new Set<string>();
    let refused = 0;
    let childrenUpdated = 0;

    for (const child of childrenToFill) {
      const cacheReadTokens = Number(child.cacheReadTokens ?? 0);
      const cacheWriteTokens = Number(child.cacheWriteTokens ?? 0);

      const resolution = await this.modelPricingService.resolveCost(
        normalizedModel,
        dto.inputTokens ?? 0,
        dto.outputTokens ?? 0,
        dto.quantity ?? 1,
        child.modelProvider ?? normalizedProvider,
        costEntry,
        cacheReadTokens,
        cacheWriteTokens,
        (child.signal_events?.metadata as Record<string, unknown> | null | undefined)
          ?.cacheWriteTtl,
      );
      if (isCostRefused(resolution)) {
        refused += 1;
        for (const rate of resolution.missingRates) refusedRates.add(rate);
        this.logger.warn(`[fillVolume] child ${child.id} left unresolved: ${resolution.reason}`);
        continue;
      }
      const costResult = resolution.cost;

      const usageCostData: Record<string, { cost: number; units: number; costPerUnit: number }> = {
        [`${child.model}/input`]: {
          cost: costResult.inputCostUsd.toNumber(),
          units: dto.inputTokens ?? 0,
          costPerUnit: costResult.inputCostPerToken,
        },
        [`${child.model}/output`]: {
          cost: costResult.outputCostUsd.toNumber(),
          units: dto.outputTokens ?? 0,
          costPerUnit: costResult.outputCostPerToken,
        },
      };
      // Cache lines only when the child stored counts, so a child with no cache
      // counts gets input and output lines only. `!= null`: a stored 0 is a real count.
      if (child.cacheReadTokens != null) {
        usageCostData[`${child.model}/cache_read`] = {
          cost: costResult.cacheReadCostUsd.toNumber(),
          units: cacheReadTokens,
          costPerUnit: costResult.cacheReadCostPerToken,
        };
      }
      if (child.cacheWriteTokens != null) {
        usageCostData[`${child.model}/cache_write`] = {
          cost: costResult.cacheWriteCostUsd.toNumber(),
          units: cacheWriteTokens,
          costPerUnit: costResult.cacheWriteCostPerToken,
        };
      }
      childrenUpdated += 1;

      await this.prisma.signal_event_services.update({
        where: { id: child.id },
        data: {
          inputTokens: dto.inputTokens ?? null,
          outputTokens: dto.outputTokens ?? null,
          quantity: dto.quantity ?? null,
          // Rewritten unconditionally: same row the ingest lookup resolved, so
          // this is a no-op except on a child that somehow lost it.
          servicePricingId: target.id,
          usageCost: costResult.totalCostUsd,
          usageCostData: usageCostData as Prisma.InputJsonValue,
          eventStatus: 'PROCESSED',
        },
      });

      affectedParents.add(child.signalEventId);

      // Auto-declare the (signal, servicePricing) link. Usually redundant here
      // since the model was known at ingest; the upsert is idempotent.
      const signalId = child.signal_events.signalId;
      if (signalId) {
        const linkKey = `${signalId}|${target.id}`;
        if (!declaredLinks.has(linkKey)) {
          declaredLinks.add(linkKey);
          try {
            await this.prisma.signal_services.upsert({
              where: {
                signalId_servicePricingId: {
                  signalId,
                  servicePricingId: target.id,
                },
              },
              create: {
                id: crypto.randomUUID(),
                signalId,
                servicePricingId: target.id,
              },
              update: {},
            });
          } catch (linkErr: any) {
            this.logger.warn(
              `[fillVolume] signal_services upsert failed (non-fatal): ` +
                `signalId=${signalId} servicePricingId=${target.id} ` +
                `error=${linkErr?.message ?? linkErr}`,
            );
          }
        }
      }
    }

    // Same all-or-nothing parent rule as mapModel: usageCost = SUM(children) or
    // null, PROCESSED only when EVERY child resolved; otherwise the worst
    // remaining sibling status stands.
    for (const parentId of affectedParents) {
      await recomputeParentUsageCost(parentId, this.prisma as any);
    }

    this.logger.log(
      `[fillVolume] filled ${childrenUpdated} children across ` +
        `${affectedParents.size} parent events for ` +
        `${normalizedModel}/${normalizedProvider}` +
        (refused > 0 ? ` — ${refused} left unresolved (missing cache rates)` : ''),
    );

    return {
      backfilled: affectedParents.size,
      // Children actually priced, not considered: a refused child is still
      // unresolved and must never read as filled.
      childrenUpdated,
      refused,
      refusedRates: [...refusedRates],
    };
  }
}
