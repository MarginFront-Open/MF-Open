import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CCC_AGENT_CODES } from '@marginfront/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CapAlertTriggerService } from '../cost-control/cap-alert-trigger.service';
import { CreditLedgerService } from '../credit-pool/credit-ledger.service';
import { PoolAlertTriggerService } from '../credit-pool/pool-alert-trigger.service';
import { CustomerAlertTriggerService } from '../customer-alerts/customer-alert-trigger.service';
import {
  RecordUsageDto,
  UsageRecordDto,
  ServiceEntryDto,
  UsageEnvironment,
} from './dto/record-usage.dto';
import { CreateSdkCustomerDto } from './dto/create-sdk-customer.dto';
import { UpdateSdkCustomerDto } from './dto/update-sdk-customer.dto';
import { QuerySdkInvoicesDto } from './dto/query-sdk-invoices.dto';
import { QuerySdkUsageDto, SdkGroupByEnum } from './dto/query-sdk-usage.dto';
import { QuerySdkSubscriptionsDto } from './dto/query-sdk-subscriptions.dto';
import * as crypto from 'crypto';
import { ModelPricingService, isCostRefused } from '../event-processing/model-pricing.service';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
import {
  createSignalEventWithServices,
  SignalEventServiceInput,
  SignalEventStatus,
} from '../../common/utils/signal-event';
import {
  collectMatterTags,
  resolveMatterAttribution,
  EMPTY_MATTER_CONTEXT,
  MatterAttributionContext,
} from './matter-attribution.util';

/**
 * Production inference is COGS, development/testing is R&D OpEx (ASC 730).
 * Staging is operator-defined, so null means "leave the signal's existing
 * classification alone" — it is not a default.
 */
export function environmentToCostCategory(
  environment: UsageEnvironment | undefined | null,
): 'PRODUCTION_COGS' | 'DEVELOPMENT_RD' | null {
  if (environment === 'production') return 'PRODUCTION_COGS';
  if (environment === 'development' || environment === 'testing') {
    return 'DEVELOPMENT_RD';
  }
  return null;
}

// The SDK pins money as numbers, but Prisma Decimal columns JSON-serialize to
// strings. NaN degrades to null so one corrupt row can't poison a list response.
function toMoneyNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

@Injectable()
export class SdkService {
  private readonly logger = new Logger(SdkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly modelPricingService: ModelPricingService,
    private readonly revenueMetrics: RevenueMetricsService,
    // Cap alerts evaluate at the point of spend.
    private readonly capAlertTrigger: CapAlertTriggerService,
    // Credit-pool draw after event storage. Never throws.
    private readonly creditLedger: CreditLedgerService,
    // Pool alerts evaluate at the point of spend.
    private readonly poolAlertTrigger: PoolAlertTriggerService,
    // Customer watches evaluate at the point of spend (non-code-cost-clarity events).
    private readonly customerAlertTrigger: CustomerAlertTriggerService,
  ) {}

  /** Response shape is pinned by @marginfront/sdk: { organization: { id, name } }. */
  async verifyApiKey(organizationId: string) {
    const organization = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return {
      organization: {
        id: organization.id,
        name: organization.name,
      },
      verified: true,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    };
  }

  /**
   * The org's matter lookup + routing rules, loaded ONCE per ingest
   * batch — the rules read doubles as the "does this org route matters at all"
   * probe, and the matters read is skipped when no record in the batch carries
   * a metadata.matterId tag. The ORDER BY tie-break keys (createdAt, id) are
   * load-bearing: every rule defaults to priority 100, and without them
   * same-priority rules resolve by database row order — nondeterministic.
   *
   * Tolerates Prisma P2021/P2022 (table or column missing) on these two READS only.
   * Any OTHER error rethrows and fails the request like any DB error — a
   * blip confined to these two reads must not silently mis-attribute a whole
   * tagged batch to Unassigned (there is no retroactive tag re-sweep).
   */
  private async loadMatterAttributionContext(
    organizationId: string,
    records: UsageRecordDto[],
  ): Promise<MatterAttributionContext> {
    try {
      const rules = await this.prisma.matter_routing_rules.findMany({
        where: { orgId: organizationId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          matterId: true,
          priority: true,
          agentCode: true,
          customerExternalId: true,
          signalPattern: true,
        },
      });

      const tags = collectMatterTags(records);
      const matterIdByNumber = new Map<string, string>();
      if (tags.length > 0) {
        const matters = await this.prisma.matters.findMany({
          where: { orgId: organizationId, matterNumber: { in: tags } },
          select: { id: true, matterNumber: true },
        });
        for (const matter of matters) {
          matterIdByNumber.set(matter.matterNumber, matter.id);
        }
      }

      return { matterIdByNumber, rules };
    } catch (err) {
      const isMissingTableOrColumn =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === 'P2021' || err.code === 'P2022');
      if (!isMissingTableOrColumn) throw err;
      this.logger.warn(
        `[recordUsage] matter tables not migrated yet (org=${organizationId}): ` +
          `${err.message}. The event writes below will fail until the ` +
          `database migrations are applied; SDK retries re-deliver them.`,
      );
      return EMPTY_MATTER_CONTEXT;
    }
  }

  async recordUsage(organizationId: string, recordDto: RecordUsageDto) {
    const results = {
      success: [] as any[],
      failed: [] as any[],
    };

    // Matter attribution context — <=2 indexed queries per batch,
    // zero per record.
    const matterContext = await this.loadMatterAttributionContext(
      organizationId,
      recordDto.records,
    );

    for (const record of recordDto.records) {
      const usageDate = record.usageDate ? new Date(record.usageDate) : new Date();
      const eventNow = new Date();
      // Declared out here so the catch can flip the row to ERROR. Null only if
      // the raw_ingest_events.create itself failed.
      let rawIngestEvent: { id: string } | null = null;

      try {
        // --- STEP 0: idempotency pre-check ---
        // Return the prior event BEFORE any create — a replay must grow neither
        // raw_ingest_events nor signal_events. Keyed on signal_events (the
        // SUCCESS artifact) so a prior FAILED attempt is still free to retry;
        // a NULL key never dedups; org comes from the API-key guard, never the
        // body, so the same key under another org can't cross-tenant-collide.
        if (record.idempotencyKey) {
          const prior = await this.prisma.signal_events.findFirst({
            where: { organizationId, idempotencyKey: record.idempotencyKey },
            select: { id: true, usageCost: true, rawIngestEventId: true },
          });
          if (prior) {
            // (pre-check) tags the sequential-replay path; the P2002 catch
            // below logs (race). Keep both greppable — the rate is the signal.
            this.logger.log(
              `[recordUsage] idempotent replay collapsed (pre-check): org=${organizationId} key=${record.idempotencyKey} event=${prior.id}`,
            );
            results.success.push(this.buildDeduplicatedSuccess(record, prior, usageDate));
            continue;
          }
        }

        // --- STEP 1: capture the raw payload first, before anything that can
        // fail — this is the audit anchor. Explicit whitelist, never spread
        // `record`: future DTO fields (auth metadata, trace IDs) must not leak
        // into this GIN-indexed JSONB column. Preserve whichever shape the
        // caller sent so audit replays see the original, not a normalized copy.
        const isMultiService = Array.isArray(record.services);
        const rawPayload: Record<string, unknown> = {
          customerExternalId: record.customerExternalId,
          agentCode: record.agentCode,
          signalName: record.signalName,
          quantity: record.quantity ?? 1,
          metadata: record.metadata || {},
          usageDate: usageDate.toISOString(),
          environment: record.environment ?? null,
        };
        if (isMultiService) {
          rawPayload.services = record.services!.map((s: ServiceEntryDto) => ({
            model: s.model,
            modelProvider: s.modelProvider,
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheReadTokens: s.cacheReadTokens,
            cacheWriteTokens: s.cacheWriteTokens,
            quantity: s.quantity,
          }));
        } else {
          rawPayload.model = record.model;
          rawPayload.modelProvider = record.modelProvider;
          rawPayload.inputTokens = record.inputTokens;
          rawPayload.outputTokens = record.outputTokens;
          rawPayload.cacheReadTokens = record.cacheReadTokens;
          rawPayload.cacheWriteTokens = record.cacheWriteTokens;
        }
        rawIngestEvent = await this.prisma.raw_ingest_events.create({
          data: {
            id: crypto.randomUUID(),
            organizationId: organizationId,
            payload: rawPayload as any,
            status: 'PENDING',
            receivedAt: eventNow,
            createdAt: eventNow,
            updatedAt: eventNow,
          } as any,
        });

        // --- STEP 2: find or auto-provision customer ---
        let customerCreated = false;
        let customer = await this.prisma.customers.findFirst({
          where: {
            externalId: record.customerExternalId,
            organizationId: organizationId,
            deletedAt: null,
          },
        });

        if (!customer) {
          // A soft-deleted row still owns the unique key, so create() would
          // P2002. updateMany is an atomic compare-and-swap on deletedAt —
          // concurrent resurrectors can't both flip it. Subscriptions
          // soft-deleted with the customer stay deleted.
          const resurrected = await this.prisma.customers.updateMany({
            where: {
              externalId: record.customerExternalId,
              organizationId: organizationId,
              deletedAt: { not: null },
            },
            data: { deletedAt: null, updatedAt: new Date() },
          });
          customer = await this.prisma.customers.findFirst({
            where: {
              externalId: record.customerExternalId,
              organizationId: organizationId,
              deletedAt: null,
            },
          });
          if (customer && resurrected.count > 0) {
            this.logger.log(
              `[recordUsage] Resurrected soft-deleted customer externalId=${record.customerExternalId}`,
            );
          }
        }

        if (!customer) {
          customerCreated = true;
          const now = new Date();
          customer = await this.prisma.customers.create({
            data: {
              id: crypto.randomUUID(),
              organizationId: organizationId,
              externalId: record.customerExternalId,
              name: record.customerExternalId,
              status: 'active',
              timezone: 'UTC',
              netTerms: 30,
              invoiceEmailRecipients: [],
              metadata: {},
              // Cost-split bucketing ONLY. Revenue/invoice math never
              // reads isInternal, and caps/coverage key on agentCode, not this.
              isInternal: (CCC_AGENT_CODES as readonly string[]).includes(record.agentCode),
              createdAt: now,
              updatedAt: now,
            } as any,
          });
          this.logger.log(
            `[recordUsage] Auto-provisioned customer externalId=${record.customerExternalId}`,
          );
        }

        // --- STEP 3: find or auto-provision agent ---
        let agentCreated = false;
        let agent = await this.prisma.agents.findFirst({
          where: {
            agentCode: record.agentCode,
            orgId: organizationId,
            deletedAt: null,
          },
        });

        if (!agent) {
          // Same resurrection dance as the customer above — revive, never
          // re-create: (agentCode, orgId) is unique with no deletedAt column.
          const resurrected = await this.prisma.agents.updateMany({
            where: {
              agentCode: record.agentCode,
              orgId: organizationId,
              deletedAt: { not: null },
            },
            data: { deletedAt: null, updatedAt: new Date() },
          });
          agent = await this.prisma.agents.findFirst({
            where: {
              agentCode: record.agentCode,
              orgId: organizationId,
              deletedAt: null,
            },
          });
          if (agent && resurrected.count > 0) {
            this.logger.log(
              `[recordUsage] Resurrected soft-deleted agent agentCode=${record.agentCode}`,
            );
          }
        }

        if (!agent) {
          agentCreated = true;
          const now = new Date();
          agent = await this.prisma.agents.create({
            data: {
              id: crypto.randomUUID(),
              orgId: organizationId,
              agentCode: record.agentCode,
              name: record.agentCode,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            } as any,
          });
          this.logger.log(`[recordUsage] Auto-provisioned agent agentCode=${record.agentCode}`);
        }

        // --- STEP 4: find or auto-provision signal ---
        const now = new Date();
        const signal = await this.prisma.signals.upsert({
          where: {
            agentId_name: {
              agentId: agent.id,
              name: record.signalName,
            },
          },
          update: {},
          create: {
            id: crypto.randomUUID(),
            orgId: organizationId,
            agentId: agent.id,
            name: record.signalName,
            createdAt: now,
            updatedAt: now,
          } as any,
        });

        // This upsert has no deletedAt filter, so a soft-deleted signal is
        // FOUND, not re-created — and would keep accruing events while hidden
        // from every deletedAt:null dashboard read. Revive it; update-by-id is
        // idempotent under races.
        if ((signal as any).deletedAt != null) {
          await this.prisma.signals.update({
            where: { id: signal.id },
            data: { deletedAt: null, updatedAt: new Date() } as any,
          });
          (signal as any).deletedAt = null;
          this.logger.log(
            `[recordUsage] Resurrected soft-deleted signal name=${record.signalName} agentId=${agent.id}`,
          );
        }

        // Upsert can't report create-vs-found; createdAt === the `now` we passed
        // can, for zero extra queries. Informational only — a same-millisecond
        // collision (a same-batch record reusing the signalName) falsely reports
        // true. instanceof guard: a malformed createdAt must degrade to false,
        // never throw mid-ingest.
        const signalCreated =
          signal.createdAt instanceof Date && signal.createdAt.getTime() === now.getTime();

        // --- STEP 4b: soft auto-classify the signal's costCategory ---
        // Operator-set classifications are sticky: only UNCLASSIFIED is ever
        // overwritten. Failure here is non-fatal; the event still flows.
        const inferredCategory = environmentToCostCategory(
          record.environment as UsageEnvironment | undefined,
        );
        if (inferredCategory && (signal as any).costCategory === 'UNCLASSIFIED') {
          try {
            await this.prisma.signals.update({
              where: { id: signal.id },
              data: { costCategory: inferredCategory, updatedAt: new Date() } as any,
            });
            (signal as any).costCategory = inferredCategory;
          } catch (autoClassifyErr: any) {
            this.logger.warn(
              `[recordUsage] auto-classify failed (non-fatal): ` +
                `signalId=${signal.id} env=${record.environment} ` +
                `target=${inferredCategory} error=${autoClassifyErr?.message ?? autoClassifyErr}`,
            );
          }
        }

        // --- STEP 5: optional subscription lookup (non-fatal) ---
        // Matched through agent_pricing_plans, not subscriptions.agentId: a
        // customer on a multi-agent plan may fire events for ANY agent on it.
        const subscription =
          (await this.prisma.subscriptions.findFirst({
            where: {
              customerId: customer.id,
              status: 'active',
              deletedAt: null,
              pricing_plans: {
                agent_pricing_plans: {
                  some: { agentId: agent.id },
                },
              },
            },
          })) ?? null;

        // --- STEP 6: normalize to a services array ---
        // Single-service callers get one virtual entry that inherits the
        // top-level (signal-level) quantity; multi-service entries each bring
        // their own services[].quantity.
        const incomingServices: Array<
          Pick<
            ServiceEntryDto,
            | 'model'
            | 'modelProvider'
            | 'inputTokens'
            | 'outputTokens'
            | 'cacheReadTokens'
            | 'cacheWriteTokens'
            | 'quantity'
          >
        > = record.services ?? [
          {
            model: record.model!,
            modelProvider: record.modelProvider!,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            cacheReadTokens: record.cacheReadTokens,
            cacheWriteTokens: record.cacheWriteTokens,
            quantity: record.quantity,
          },
        ];

        // --- STEP 7: per-service cost lookup + volume validation + cost calc ---
        // All cost math is pre-computed here; createSignalEventWithServices
        // only writes rows. All-or-nothing rollup rules are applied in STEP 8.
        const serviceInputs: SignalEventServiceInput[] = [];
        const aggregatedCostData: Record<
          string,
          { cost: number; units: number | null | undefined; costPerUnit: number }
        > = {};
        const mismatchMessages: string[] = [];

        for (const svc of incomingServices) {
          const modelEntry = await this.modelPricingService.lookupModel(
            svc.model,
            svc.modelProvider,
            organizationId,
          );

          let svcStatus: SignalEventStatus = 'PROCESSED';
          let svcCost: Prisma.Decimal | null = null;
          let svcCostData: Record<string, unknown> | null = null;
          let svcMessage: string | null = null;
          let svcServicePricingId: string | null = null;

          if (!modelEntry) {
            // Store, never drop the event.
            svcStatus = 'NEEDS_COST_BACKFILL';
            svcMessage =
              `Model "${svc.model}" (provider "${svc.modelProvider}") ` +
              `not found in service_pricing. Event stored with usageCost: null. ` +
              `Map this model in the MarginFront dashboard under "Needs ` +
              `attention" to calculate cost and backfill this event.`;
            this.logger.warn(
              `[recordUsage] unknown model: org=${organizationId} ` +
                `model="${svc.model}" provider="${svc.modelProvider}" — ` +
                `child stored with usageCost: null, eventStatus: NEEDS_COST_BACKFILL`,
            );
          } else {
            svcServicePricingId = modelEntry.servicePricingId;
            // Canon V1/V2/V4: an explicit 0 is a VALID volume — only null or
            // undefined counts as missing, and missing is flagged
            // (MISSING_VOLUME_DATA), never silently zeroed into a $0 charge.
            const isLlm = modelEntry.costUnit === '1M tokens';

            if (isLlm && (svc.inputTokens == null || svc.outputTokens == null)) {
              svcStatus = 'MISSING_VOLUME_DATA';
              svcMessage =
                `LLM model "${svc.model}" (provider "${svc.modelProvider}") requires ` +
                `both inputTokens and outputTokens. Without token counts, cost cannot be ` +
                `calculated. Got inputTokens=${svc.inputTokens}, outputTokens=${svc.outputTokens}. ` +
                `Event stored with usageCost: null.`;
              this.logger.warn(
                `[recordUsage] missing volume: org=${organizationId} ` +
                  `model="${svc.model}" provider="${svc.modelProvider}" — ` +
                  `LLM child missing tokens, storing with MISSING_VOLUME_DATA`,
              );
            } else if (!isLlm && svc.quantity == null) {
              svcStatus = 'MISSING_VOLUME_DATA';
              svcMessage =
                `Non-LLM service "${svc.model}" (provider "${svc.modelProvider}", ` +
                `costUnit: "${modelEntry.costUnit}") requires quantity. Without a unit ` +
                `count, cost cannot be calculated. Event stored with usageCost: null.`;
              this.logger.warn(
                `[recordUsage] missing volume: org=${organizationId} ` +
                  `model="${svc.model}" provider="${svc.modelProvider}" — ` +
                  `non-LLM child missing quantity, storing with MISSING_VOLUME_DATA`,
              );
            } else {
              const resolution = await this.modelPricingService.resolveCost(
                svc.model,
                svc.inputTokens ?? 0,
                svc.outputTokens ?? 0,
                svc.quantity ?? 1,
                svc.modelProvider,
                modelEntry,
                svc.cacheReadTokens ?? 0,
                svc.cacheWriteTokens ?? 0,
                // Cache-write TTL hint. Read from the SAME metadata
                // persisted on the event row so a later backfill re-derives an
                // identical rate.
                (record.metadata as Record<string, unknown> | null | undefined)?.cacheWriteTtl,
              );

              if (isCostRefused(resolution)) {
                // Cache tokens with no matching cache rate. Pricing the gap at
                // $0 would under-state real spend while rolling up to PROCESSED
                // looking final — the "under-bill in silence" CANON C1 forbids.
                // Detection lives in resolveEventPrice (@marginfront/db); this block
                // is only the ingest reaction to a refusal.
                this.logger.warn(
                  `[recordUsage] cache tokens with no cache rate: org=${organizationId} ` +
                    `model="${svc.model}" provider="${svc.modelProvider}" — ` +
                    `cacheReadTokens=${svc.cacheReadTokens} cacheWriteTokens=${svc.cacheWriteTokens} ` +
                    `but the pricing row has no ${resolution.missingRates.join('/')}. ` +
                    `Flagging NEEDS_COST_BACKFILL (cost null) instead of pricing cache at $0 — ` +
                    `run the pricing sync to populate cache rates for this model.`,
                );
                // costData is nulled too: an unresolved child must never seed
                // the parent's cost-by-service aggregate (same posture as the
                // unknown-model child).
                svcStatus = 'NEEDS_COST_BACKFILL';
                svcCost = null;
                svcCostData = null;
                svcMessage = resolution.reason;
              } else {
                const costResult = resolution.cost;
                svcCost = costResult.totalCostUsd;
                svcCostData = {
                  [`${svc.model}/input`]: {
                    cost: costResult.inputCostUsd.toNumber(),
                    units: svc.inputTokens,
                    costPerUnit: costResult.inputCostPerToken,
                  },
                  [`${svc.model}/output`]: {
                    cost: costResult.outputCostUsd.toNumber(),
                    units: svc.outputTokens,
                    costPerUnit: costResult.outputCostPerToken,
                  },
                };
                // Only emit cache lines when the caller actually sent cache
                // tokens, so non-cache events' usageCostData keeps the
                // input/output-only shape.
                if (svc.cacheReadTokens != null) {
                  svcCostData[`${svc.model}/cache_read`] = {
                    cost: costResult.cacheReadCostUsd.toNumber(),
                    units: svc.cacheReadTokens,
                    costPerUnit: costResult.cacheReadCostPerToken,
                  };
                }
                if (svc.cacheWriteTokens != null) {
                  svcCostData[`${svc.model}/cache_write`] = {
                    cost: costResult.cacheWriteCostUsd.toNumber(),
                    units: svc.cacheWriteTokens,
                    costPerUnit: costResult.cacheWriteCostPerToken,
                  };
                }
                this.logger.log(
                  `[recordUsage] resolved service: model=${svc.model} ` +
                    `provider=${svc.modelProvider} inputTokens=${svc.inputTokens} ` +
                    `outputTokens=${svc.outputTokens} ` +
                    `totalCostUsd=${costResult.totalCostUsd.toFixed(10)}`,
                );
              }

              // Same keyed shape as the single-service path so analytics
              // and dashboard consumers keep walking Object.entries unchanged.
              // Two services on the same model collide: sum cost and units —
              // per-call truth lives in the signal_event_services rows.
              for (const [key, val] of Object.entries(svcCostData ?? {})) {
                const v = val as {
                  cost: number;
                  units: number | null | undefined;
                  costPerUnit: number;
                };
                if (aggregatedCostData[key]) {
                  aggregatedCostData[key].cost += v.cost;
                  if (
                    typeof v.units === 'number' &&
                    typeof aggregatedCostData[key].units === 'number'
                  ) {
                    aggregatedCostData[key].units =
                      (aggregatedCostData[key].units as number) + v.units;
                  }
                  // costPerUnit stays the same (same model = same rate).
                } else {
                  aggregatedCostData[key] = { ...v };
                }
              }
            }
          }

          if (svcMessage) mismatchMessages.push(svcMessage);

          serviceInputs.push({
            model: svc.model,
            modelProvider: svc.modelProvider,
            inputTokens: svc.inputTokens ?? null,
            outputTokens: svc.outputTokens ?? null,
            cacheReadTokens: svc.cacheReadTokens ?? null,
            cacheWriteTokens: svc.cacheWriteTokens ?? null,
            quantity: svc.quantity ?? null,
            servicePricingId: svcServicePricingId,
            usageCost: svcCost,
            usageCostData: svcCostData as Prisma.InputJsonValue | null,
            eventStatus: svcStatus,
          });
        }

        // --- STEP 8: aggregate parent state from children ---
        // Priority must stay in lockstep with signal-event.utils.worstStatus.
        // Cost invariant: parent usageCost is the SUM of children, or null if
        // ANY child is unresolved — never a partial sum.
        const childStatuses = serviceInputs.map((s) => s.eventStatus);
        let parentStatus: SignalEventStatus;
        if (childStatuses.includes('ERROR')) parentStatus = 'ERROR';
        else if (childStatuses.includes('NEEDS_COST_BACKFILL'))
          parentStatus = 'NEEDS_COST_BACKFILL';
        else if (childStatuses.includes('MISSING_VOLUME_DATA'))
          parentStatus = 'MISSING_VOLUME_DATA';
        else if (childStatuses.includes('PENDING')) parentStatus = 'PENDING';
        else parentStatus = 'PROCESSED';

        const anyChildUnresolved = serviceInputs.some((s) => s.usageCost === null);
        const parentUsageCost: Prisma.Decimal | null = anyChildUnresolved
          ? null
          : serviceInputs.reduce(
              (sum, s) => sum.add(s.usageCost as Prisma.Decimal),
              new Prisma.Decimal(0),
            );
        const parentUsageCostData =
          Object.keys(aggregatedCostData).length > 0 ? aggregatedCostData : null;
        const aggregateMismatchMessage =
          mismatchMessages.length > 0 ? mismatchMessages.join(' | ') : null;

        // --- STEP 9: write parent + N children atomically ---
        // The utility does sequential writes, not Prisma nested writes, so this
        // $transaction is the only thing stopping a failed child from leaving
        // an orphaned parent behind.
        // Matter attribution: a valid tag beats a rule; neither
        // matching leaves NULL — the visible Unassigned bucket on the Law tab.
        const { matterId, matterSource } = resolveMatterAttribution(record, matterContext);

        const parentEventId = crypto.randomUUID();
        const { event: signalEvent } = await this.prisma.$transaction(async (tx) => {
          return await createSignalEventWithServices(
            {
              id: parentEventId,
              customerExternalId: record.customerExternalId,
              customerId: customer.id,
              subscriptionId: subscription?.id ?? null,
              organizationId,
              agentId: agent.id,
              signalId: signal.id,
              rawIngestEventId: rawIngestEvent.id,
              usageDate,
              quantity: record.quantity ?? 1,
              metadata: (record.metadata || {}) as Prisma.InputJsonValue,
              usageCost: parentUsageCost,
              usageCostData: (parentUsageCostData ?? null) as Prisma.InputJsonValue,
              eventProcessed: parentStatus,
              eventProcessedAt: eventNow,
              environment: (record.environment as UsageEnvironment | undefined) ?? null,
              // Stamped on the success artifact so a later replay collides here
              // instead of duplicating.
              idempotencyKey: record.idempotencyKey ?? null,
              matterId,
              matterSource,
              services: serviceInputs,
            },
            this.prisma,
            tx,
          );
        });

        // --- STEP 10: auto-declare signal_services for each resolved child ---
        // PROCESSED children ONLY: a MISSING_VOLUME_DATA or NEEDS_COST_BACKFILL
        // child declares no link until a backfill resolves it. Non-fatal — the
        // event is already stored.
        for (const svc of serviceInputs) {
          if (svc.eventStatus !== 'PROCESSED' || !svc.servicePricingId) continue;
          try {
            await this.prisma.signal_services.upsert({
              where: {
                signalId_servicePricingId: {
                  signalId: signal.id,
                  servicePricingId: svc.servicePricingId,
                },
              },
              create: {
                id: crypto.randomUUID(),
                signalId: signal.id,
                servicePricingId: svc.servicePricingId,
              },
              update: {},
            });
          } catch (linkErr: any) {
            this.logger.warn(
              `[recordUsage] signal_services upsert failed (non-fatal): ` +
                `signalId=${signal.id} servicePricingId=${svc.servicePricingId} ` +
                `error=${linkErr?.message ?? linkErr}`,
            );
          }
        }

        // --- STEP 11: flip the raw row from PENDING to its final status ---
        // PROCESSED only when every child is; anything else stays PENDING so
        // the dashboard's needs-attention surface keeps the aggregated message.
        await this.prisma.raw_ingest_events.update({
          where: { id: rawIngestEvent.id },
          data: {
            status: parentStatus === 'PROCESSED' ? 'PROCESSED' : 'PENDING',
            errorMsg: aggregateMismatchMessage,
            processedAt: eventNow,
          },
        });

        // --- STEP 11.5: credit-pool draw (track-only) ---
        // AFTER storage, never before: a billing-feature bug must not cost a
        // customer their usage data. Draws for EVERY stored event, not just
        // PROCESSED ones — invoice-calculator.service.ts selects with no status
        // filter, so a NEEDS_COST_BACKFILL event still bills its quantity and
        // the pool must draw the same units.
        try {
          const draw = await this.creditLedger.consumeForEvent({
            subscription,
            signalId: signal.id,
            signalEventId: signalEvent.id,
            quantity: record.quantity ?? 1,
            usageDate,
          });
          // Poke AFTER the decrement, reusing the membership the
          // draw already resolved.
          this.poolAlertTrigger.maybeTrigger(subscription?.id ?? null, draw?.creditPool === true);
        } catch (creditErr: any) {
          this.logger.warn(
            `[recordUsage] credit-pool draw failed (non-fatal): ` +
              `eventId=${signalEvent.id} error=${creditErr?.message ?? creditErr}`,
          );
        }

        // --- STEP 12: bucket the result for the response body ---
        // The "failed" bucket also holds stored-but-unpriced events
        // (NEEDS_COST_BACKFILL, MISSING_VOLUME_DATA); `stored: true` is what
        // tells the caller not to retry.
        if (parentStatus === 'PROCESSED') {
          const successPayload: any = {
            customerExternalId: record.customerExternalId,
            agentCode: record.agentCode,
            signalName: record.signalName,
            totalCostUsd: (parentUsageCost as Prisma.Decimal).toFixed(10),
            eventId: signalEvent.id,
            rawEventId: rawIngestEvent.id,
            timestamp: usageDate.toISOString(),
            created: {
              customer: customerCreated,
              agent: agentCreated,
              signal: signalCreated,
            },
          };
          if (isMultiService) {
            successPayload.services = serviceInputs.map((s) => ({
              model: s.model,
              modelProvider: s.modelProvider,
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              cacheReadTokens: s.cacheReadTokens,
              cacheWriteTokens: s.cacheWriteTokens,
              quantity:
                s.quantity !== null && typeof s.quantity === 'object' && 'toNumber' in s.quantity
                  ? (s.quantity as Prisma.Decimal).toNumber()
                  : (s.quantity as number | null),
              usageCost: s.usageCost ? (s.usageCost as Prisma.Decimal).toFixed(10) : null,
              eventStatus: s.eventStatus,
            }));
          } else {
            successPayload.model = record.model;
            successPayload.modelProvider = record.modelProvider;
            successPayload.inputTokens = record.inputTokens;
            successPayload.outputTokens = record.outputTokens;
            successPayload.cacheReadTokens = record.cacheReadTokens;
            successPayload.cacheWriteTokens = record.cacheWriteTokens;
            successPayload.quantity = record.quantity ?? 1;
          }
          results.success.push(successPayload);

          // Must never disturb ingest; the trigger also catches internally.
          try {
            this.capAlertTrigger.maybeTrigger(organizationId, record.agentCode);
          } catch (err) {
            this.logger.warn(`[recordUsage] cap-alert trigger failed (non-fatal): ${err}`);
          }

          // Customer watches, the inverse gate (skips code-cost-clarity agent codes).
          // AFTER the cap trigger, never between the credit-pool draw and it —
          // sdk.service.credit-pool.spec.ts pins the draw -> cap-trigger order.
          try {
            this.customerAlertTrigger.maybeTrigger(organizationId, record.agentCode);
          } catch (err) {
            this.logger.warn(`[recordUsage] customer-alert trigger failed (non-fatal): ${err}`);
          }
        } else {
          const failedPayload: any = {
            record,
            code: parentStatus,
            stored: true,
            eventId: signalEvent.id,
            rawEventId: rawIngestEvent.id,
            error: aggregateMismatchMessage!,
            // Entities are provisioned before pricing resolves, so a stored
            // failure still created them — report `created` here, not only
            // on the success path.
            created: {
              customer: customerCreated,
              agent: agentCreated,
              signal: signalCreated,
            },
          };
          if (isMultiService) {
            failedPayload.servicesStatus = serviceInputs.map((s) => ({
              model: s.model,
              modelProvider: s.modelProvider,
              eventStatus: s.eventStatus,
            }));
          }
          results.failed.push(failedPayload);
        }
      } catch (error: any) {
        // --- Concurrent double-POST race ---
        // P2002 on (organizationId, idempotencyKey) is not a real failure: the
        // winner's event landed, so return the same no-op replay shape. Gated on
        // key-present AND a successful re-query so any OTHER P2002 falls through
        // to the generic handler below — the provisioning writes (customers,
        // agents, signals) carry unique keys of their own, and those races are
        // genuinely retryable.
        if (
          record.idempotencyKey &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const winner = await this.prisma.signal_events.findFirst({
            where: { organizationId, idempotencyKey: record.idempotencyKey },
            select: { id: true, usageCost: true, rawIngestEventId: true },
          });
          if (winner) {
            // (race) tags the concurrent path; (pre-check) above is sequential.
            this.logger.log(
              `[recordUsage] idempotent replay collapsed (race): org=${organizationId} key=${record.idempotencyKey} event=${winner.id}`,
            );
            // The loser's STEP 1 raw row stays PENDING — a harmless audit
            // artifact of the true-concurrent case, not a stuck event.
            results.success.push(this.buildDeduplicatedSuccess(record, winner, usageDate));
            continue;
          }
        }

        this.logger.error(
          `Error recording usage for customer ${record.customerExternalId}:`,
          error,
        );
        // Best-effort: flip the raw row to ERROR so the dashboard's Errors
        // tile reflects the failure.
        if (rawIngestEvent) {
          try {
            await this.prisma.raw_ingest_events.update({
              where: { id: rawIngestEvent.id },
              data: {
                status: 'ERROR',
                errorMsg: error.message || 'Unknown error during ingestion',
                processedAt: new Date(),
              },
            });
          } catch (updateErr) {
            this.logger.error(
              '[recordUsage] CRITICAL: failed to mark raw_ingest_events as ERROR',
              updateErr,
            );
          }
        }
        // stored: false means signal_events was NOT created — the caller SHOULD
        // retry (the inverse of the stored: true branch above). rawEventId is
        // null only when the raw create itself failed.
        results.failed.push({
          record,
          code: 'INTERNAL_ERROR',
          stored: false,
          rawEventId: rawIngestEvent?.id ?? null,
          error: error.message || 'Unknown error. Event NOT stored. Safe to retry.',
        });
      }
    }

    return {
      processed: recordDto.records.length,
      successful: results.success.length,
      failed: results.failed.length,
      results,
    };
  }

  /**
   * Success-row for a deduplicated replay: the same shape
   * STEP 12 returns, so a replay is indistinguishable from the original POST —
   * same eventId, same totalCostUsd. The multi-service echo deliberately omits
   * per-child usageCost/eventStatus; reconstructing them would cost a
   * signal_event_services query the parent rollup already makes unnecessary.
   */
  private buildDeduplicatedSuccess(
    record: UsageRecordDto,
    prior: { id: string; usageCost: Prisma.Decimal | null; rawIngestEventId: string },
    usageDate: Date,
  ): Record<string, any> {
    const isMultiService = Array.isArray(record.services);
    const payload: Record<string, any> = {
      customerExternalId: record.customerExternalId,
      agentCode: record.agentCode,
      signalName: record.signalName,
      totalCostUsd: prior.usageCost !== null ? prior.usageCost.toFixed(10) : null,
      eventId: prior.id,
      rawEventId: prior.rawIngestEventId,
      timestamp: usageDate.toISOString(),
    };
    if (isMultiService) {
      payload.services = record.services!.map((s) => ({
        model: s.model,
        modelProvider: s.modelProvider,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        quantity: s.quantity,
      }));
    } else {
      payload.model = record.model;
      payload.modelProvider = record.modelProvider;
      payload.inputTokens = record.inputTokens;
      payload.outputTokens = record.outputTokens;
      payload.cacheReadTokens = record.cacheReadTokens;
      payload.cacheWriteTokens = record.cacheWriteTokens;
      payload.quantity = record.quantity ?? 1;
    }
    return payload;
  }

  async createCustomer(organizationId: string, createDto: CreateSdkCustomerDto) {
    if (createDto.externalId) {
      const existingCustomer = await this.prisma.customers.findFirst({
        where: {
          externalId: createDto.externalId,
          organizationId: organizationId,
          deletedAt: null,
        },
      });

      if (existingCustomer) {
        throw new BadRequestException(
          `Customer with external ID '${createDto.externalId}' already exists`,
        );
      }
    }

    let agent: any = null;
    let pricingPlan: any = null;
    if (createDto.agentCode) {
      agent = await this.prisma.agents.findFirst({
        where: {
          agentCode: createDto.agentCode,
          orgId: organizationId,
          deletedAt: null,
        },
      });

      if (!agent) {
        throw new BadRequestException(`Agent with code '${createDto.agentCode}' not found`);
      }

      pricingPlan = await this.prisma.pricing_plans.findFirst({
        where: {
          agentId: agent.id,
          deletedAt: null,
        },
      });

      if (!pricingPlan) {
        throw new BadRequestException(
          `No pricing plan found for agent '${createDto.agentCode}'. Cannot create subscription.`,
        );
      }
    }

    const now = new Date();
    const customer = await this.prisma.customers.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: organizationId,
        name: createDto.name,
        externalId: createDto.externalId || null,
        email: createDto.email || null,
        phone: createDto.phone || null,
        timezone: createDto.timezone || 'UTC',
        status: createDto.status || 'active',
        billingContactName: createDto.billingContactName || null,
        billingContactEmail: createDto.billingContactEmail || null,
        netTerms: createDto.netTerms || 30,
        invoiceEmailRecipients: (createDto.invoiceEmailRecipients as any) || [],
        metadata: (createDto.metadata || {}) as any,
        createdAt: now,
        updatedAt: now,
      } as any,
    });

    let subscription: any = null;
    if (agent && pricingPlan) {
      const subNow = new Date();
      subscription = await this.prisma.subscriptions.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: organizationId,
          customerId: customer.id,
          agentId: agent.id,
          planId: pricingPlan.id,
          name: `Subscription for ${customer.name} - ${agent.name}`,
          status: 'active',
          startDate: subNow,
          billingCycle: 'monthly',
          timezone: customer.timezone || 'UTC',
          nextRecurringInvoiceAt: subNow,
          nextUsageInvoiceAt: subNow,
          createdAt: subNow,
          updatedAt: subNow,
        } as any,
      });
    }

    return {
      id: customer.id,
      organizationId: customer.organizationId,
      name: customer.name,
      externalId: customer.externalId,
      email: customer.email,
      phone: customer.phone,
      timezone: customer.timezone,
      status: customer.status,
      billingContactName: customer.billingContactName,
      billingContactEmail: customer.billingContactEmail,
      netTerms: customer.netTerms,
      invoiceEmailRecipients: customer.invoiceEmailRecipients,
      metadata: customer.metadata,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      subscription: subscription
        ? {
            id: subscription.id,
            agentId: subscription.agentId,
            planId: subscription.planId,
            status: subscription.status,
            startDate: subscription.startDate,
            billingCycle: subscription.billingCycle,
            createdAt: subscription.createdAt,
          }
        : null,
    };
  }

  async getCustomers(organizationId: string) {
    const customers = await this.prisma.customers.findMany({
      where: {
        organizationId: organizationId,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        subscriptions: {
          where: {
            deletedAt: null,
          },
          include: {
            agents: {
              select: {
                id: true,
                name: true,
                agentCode: true,
              },
            },
          },
        },
      },
    });

    return customers.map((customer) => ({
      id: customer.id,
      organizationId: customer.organizationId,
      name: customer.name,
      externalId: customer.externalId,
      email: customer.email,
      phone: customer.phone,
      timezone: customer.timezone,
      status: customer.status,
      billingContactName: customer.billingContactName,
      billingContactEmail: customer.billingContactEmail,
      netTerms: customer.netTerms,
      invoiceEmailRecipients: customer.invoiceEmailRecipients,
      metadata: customer.metadata,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      subscriptions: customer.subscriptions.map((sub) => ({
        id: sub.id,
        agentId: sub.agentId,
        agent: sub.agents
          ? {
              id: sub.agents.id,
              name: sub.agents.name,
              agentCode: sub.agents.agentCode,
            }
          : null,
        status: sub.status,
        startDate: sub.startDate,
        endDate: sub.endDate,
        billingCycle: sub.billingCycle,
        createdAt: sub.createdAt,
      })),
    }));
  }

  async getCustomer(organizationId: string, customerId: string) {
    const customer = await this.prisma.customers.findFirst({
      where: {
        id: customerId,
        organizationId: organizationId,
        deletedAt: null,
      },
      include: {
        subscriptions: {
          where: {
            deletedAt: null,
          },
          include: {
            agents: {
              select: {
                id: true,
                name: true,
                agentCode: true,
              },
            },
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    return {
      id: customer.id,
      organizationId: customer.organizationId,
      name: customer.name,
      externalId: customer.externalId,
      email: customer.email,
      phone: customer.phone,
      timezone: customer.timezone,
      status: customer.status,
      billingContactName: customer.billingContactName,
      billingContactEmail: customer.billingContactEmail,
      netTerms: customer.netTerms,
      invoiceEmailRecipients: customer.invoiceEmailRecipients,
      metadata: customer.metadata,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      subscriptions: customer.subscriptions.map((sub) => ({
        id: sub.id,
        agentId: sub.agentId,
        agent: sub.agents
          ? {
              id: sub.agents.id,
              name: sub.agents.name,
              agentCode: sub.agents.agentCode,
            }
          : null,
        status: sub.status,
        startDate: sub.startDate,
        endDate: sub.endDate,
        billingCycle: sub.billingCycle,
        createdAt: sub.createdAt,
      })),
    };
  }

  async updateCustomer(
    organizationId: string,
    customerId: string,
    updateDto: UpdateSdkCustomerDto,
  ) {
    const existingCustomer = await this.prisma.customers.findFirst({
      where: {
        id: customerId,
        organizationId: organizationId,
        deletedAt: null,
      },
    });

    if (!existingCustomer) {
      throw new NotFoundException('Customer not found');
    }

    if (updateDto.externalId && updateDto.externalId !== existingCustomer.externalId) {
      const duplicateCustomer = await this.prisma.customers.findFirst({
        where: {
          externalId: updateDto.externalId,
          organizationId: organizationId,
          deletedAt: null,
          id: { not: customerId },
        },
      });

      if (duplicateCustomer) {
        throw new BadRequestException(
          `Customer with external ID '${updateDto.externalId}' already exists`,
        );
      }
    }

    const updateData: any = {};

    if (updateDto.name !== undefined) updateData.name = updateDto.name;
    if (updateDto.externalId !== undefined) updateData.externalId = updateDto.externalId;
    if (updateDto.email !== undefined) updateData.email = updateDto.email;
    if (updateDto.phone !== undefined) updateData.phone = updateDto.phone;
    if (updateDto.timezone !== undefined) updateData.timezone = updateDto.timezone;
    if (updateDto.status !== undefined) updateData.status = updateDto.status;
    if (updateDto.billingContactName !== undefined)
      updateData.billingContactName = updateDto.billingContactName;
    if (updateDto.billingContactEmail !== undefined)
      updateData.billingContactEmail = updateDto.billingContactEmail;
    if (updateDto.netTerms !== undefined) updateData.netTerms = updateDto.netTerms;
    if (updateDto.invoiceEmailRecipients !== undefined)
      updateData.invoiceEmailRecipients = updateDto.invoiceEmailRecipients as any;
    if (updateDto.metadata !== undefined) updateData.metadata = updateDto.metadata as any;

    const customer = await this.prisma.customers.update({
      where: { id: customerId },
      data: updateData,
    });

    return {
      id: customer.id,
      organizationId: customer.organizationId,
      name: customer.name,
      externalId: customer.externalId,
      email: customer.email,
      phone: customer.phone,
      timezone: customer.timezone,
      status: customer.status,
      billingContactName: customer.billingContactName,
      billingContactEmail: customer.billingContactEmail,
      netTerms: customer.netTerms,
      invoiceEmailRecipients: customer.invoiceEmailRecipients,
      metadata: customer.metadata,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }

  async deleteCustomer(organizationId: string, customerId: string) {
    const customer = await this.prisma.customers.findFirst({
      where: {
        id: customerId,
        organizationId: organizationId,
        deletedAt: null,
      },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    await this.prisma.customers.update({
      where: { id: customerId },
      data: {
        deletedAt: new Date(),
      },
    });

    await this.prisma.subscriptions.updateMany({
      where: {
        customerId: customerId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    return;
  }

  // ============================================
  // INVOICES
  // ============================================

  async getInvoices(organizationId: string, query: QuerySdkInvoicesDto) {
    const { page = 1, limit = 20, customerId, customerExternalId, status } = query;
    const skip = (page - 1) * limit;

    const where: any = { organizationId };

    if (customerId) {
      where.customerId = customerId;
    } else if (customerExternalId) {
      const customer = await this.prisma.customers.findFirst({
        where: {
          externalId: customerExternalId,
          organizationId,
          deletedAt: null,
        },
      });
      if (customer) {
        where.customerId = customer.id;
      } else {
        return { invoices: [], page, limit, totalPages: 0, totalResults: 0 };
      }
    }

    if (status) {
      where.status = status;
    }

    const [invoices, totalResults] = await Promise.all([
      this.prisma.invoices.findMany({
        where,
        include: {
          customers: {
            select: {
              id: true,
              name: true,
              email: true,
              externalId: true,
            },
          },
          invoice_line_items: { where: { deletedAt: null } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoices.count({ where }),
    ]);

    return {
      invoices: invoices.map((inv: any) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        billingPeriodStart: inv.billingPeriodStart,
        billingPeriodEnd: inv.billingPeriodEnd,
        subtotal: toMoneyNumber(inv.subtotal),
        taxAmount: toMoneyNumber(inv.taxAmount),
        discountAmount: toMoneyNumber(inv.discountAmount),
        totalAmount: toMoneyNumber(inv.totalAmount),
        amountPaid: toMoneyNumber(inv.amountPaid),
        amountDue: toMoneyNumber(inv.amountDue),
        currency: inv.currency,
        memo: inv.memo,
        customer: inv.customers
          ? {
              id: inv.customers.id,
              name: inv.customers.name,
              email: inv.customers.email,
              externalId: inv.customers.externalId,
            }
          : null,
        lineItems: (inv.invoice_line_items || []).map((li: any) => ({
          ...li,
          quantity: toMoneyNumber(li.quantity),
          unitPrice: toMoneyNumber(li.unitPrice),
          amount: toMoneyNumber(li.amount),
        })),
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      })),
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  async getInvoice(organizationId: string, invoiceId: string) {
    const invoice = await this.prisma.invoices.findFirst({
      where: {
        id: invoiceId,
        organizationId,
      },
      include: {
        customers: {
          select: {
            id: true,
            name: true,
            email: true,
            externalId: true,
            phone: true,
            billingContactName: true,
            billingContactEmail: true,
          },
        },
        invoice_line_items: { where: { deletedAt: null } },
        invoice_payments: true,
        subscriptions: {
          select: {
            id: true,
            status: true,
            billingCycle: true,
            agents: {
              select: {
                id: true,
                name: true,
              },
            },
            pricing_plans: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }

    return {
      id: invoice.id,
      invoiceNumber: (invoice as any).invoiceNumber,
      status: invoice.status,
      invoiceDate: (invoice as any).invoiceDate,
      dueDate: invoice.dueDate,
      billingPeriodStart: (invoice as any).billingPeriodStart,
      billingPeriodEnd: (invoice as any).billingPeriodEnd,
      subtotal: toMoneyNumber((invoice as any).subtotal),
      taxAmount: toMoneyNumber((invoice as any).taxAmount),
      discountAmount: toMoneyNumber((invoice as any).discountAmount),
      totalAmount: toMoneyNumber((invoice as any).totalAmount),
      amountPaid: toMoneyNumber((invoice as any).amountPaid),
      amountDue: toMoneyNumber((invoice as any).amountDue),
      amountCredited: toMoneyNumber((invoice as any).amountCredited),
      currency: (invoice as any).currency,
      memo: (invoice as any).memo,
      customer: (invoice as any).customers
        ? {
            id: (invoice as any).customers.id,
            name: (invoice as any).customers.name,
            email: (invoice as any).customers.email,
            externalId: (invoice as any).customers.externalId,
            phone: (invoice as any).customers.phone,
            billingContactName: (invoice as any).customers.billingContactName,
            billingContactEmail: (invoice as any).customers.billingContactEmail,
          }
        : null,
      subscription: (invoice as any).subscriptions
        ? {
            id: (invoice as any).subscriptions.id,
            status: (invoice as any).subscriptions.status,
            billingCycle: (invoice as any).subscriptions.billingCycle,
            agent: (invoice as any).subscriptions.agents,
            plan: (invoice as any).subscriptions.pricing_plans,
          }
        : null,
      lineItems: ((invoice as any).invoice_line_items || []).map((li: any) => ({
        ...li,
        quantity: toMoneyNumber(li.quantity),
        unitPrice: toMoneyNumber(li.unitPrice),
        amount: toMoneyNumber(li.amount),
      })),
      payments: ((invoice as any).invoice_payments || []).map((p: any) => ({
        id: p.id,
        amount: toMoneyNumber(p.amount),
        status: p.status,
        paymentMethod: p.paymentMethod,
        createdAt: p.createdAt,
      })),
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
  }

  // ============================================
  // ANALYTICS / USAGE
  // ============================================

  /**
   * Cost totals come from canonical getCostMetrics (canon C1 + C2). Never sum
   * `metadata.calculatedCost` off signal_events: recordUsage
   * doesn't populate that projection, so the sum would be $0 for every event.
   *
   * One UTC day is the smallest bucket; weekly/monthly fold days, not events.
   */
  async getUsageAnalytics(organizationId: string, query: QuerySdkUsageDto) {
    const {
      startDate,
      endDate,
      groupBy = SdkGroupByEnum.DAILY,
      customerId,
      customerExternalId,
      agentId,
      signalId,
      subscriptionId,
    } = query;

    // The canon filter takes UUIDs only, so resolve externalId first.
    let resolvedCustomerId = customerId;
    if (!resolvedCustomerId && customerExternalId) {
      const customer = await this.prisma.customers.findFirst({
        where: { externalId: customerExternalId, organizationId },
        select: { id: true },
      });
      if (!customer) {
        return {
          dateRange: { start: startDate, end: endDate, groupBy },
          summary: {
            totalEvents: 0,
            totalCost: 0,
            uniqueCustomers: 0,
            uniqueAgents: 0,
            uniqueSignals: 0,
          },
          data: [],
        };
      }
      resolvedCustomerId = customer.id;
    }

    const windowStart = new Date(startDate);
    const windowEnd = new Date(endDate);

    const canonCost = await this.revenueMetrics.getCostMetrics(
      organizationId,
      { start: windowStart, end: windowEnd },
      {
        customerId: resolvedCustomerId || undefined,
        agentId: agentId || undefined,
        signalId: signalId || undefined,
        subscriptionId: subscriptionId || undefined,
      },
    );

    const timeSeriesData = this._foldByDayIntoBuckets(canonCost.byDay, groupBy);

    return {
      dateRange: {
        start: startDate,
        end: endDate,
        groupBy,
      },
      summary: {
        totalEvents: canonCost.eventCount,
        totalCost: canonCost.cost,
        uniqueCustomers: canonCost.byCustomer.length,
        uniqueAgents: canonCost.byAgent.length,
        // signalId is nullable; a null signal counts as one distinct value.
        uniqueSignals: canonCost.bySignal.length,
      },
      data: timeSeriesData,
    };
  }

  /**
   * Keys are ISO date-only strings, the shape SDK and dashboard consumers read.
   */
  private _foldByDayIntoBuckets(
    byDay: { date: Date; cost: number; eventCount: number }[],
    groupBy: SdkGroupByEnum,
  ): { date: string; cost: number; eventCount: number }[] {
    if (groupBy === SdkGroupByEnum.DAILY) {
      return byDay
        .map((row) => ({
          date: row.date.toISOString().split('T')[0],
          cost: row.cost,
          eventCount: row.eventCount,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    const buckets = new Map<string, { date: string; cost: number; eventCount: number }>();
    for (const row of byDay) {
      const date = new Date(row.date);
      let key: string;
      if (groupBy === SdkGroupByEnum.WEEKLY) {
        // Monday-start week: switching to Sunday-start silently reshuffles
        // every historical weekly bucket key.
        const dayOfWeek = date.getUTCDay();
        const diff = date.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const weekStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), diff));
        key = weekStart.toISOString().split('T')[0];
      } else {
        key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
      }

      const existing = buckets.get(key) ?? { date: key, cost: 0, eventCount: 0 };
      existing.cost += row.cost;
      existing.eventCount += row.eventCount;
      buckets.set(key, existing);
    }

    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  // ============================================
  // SUBSCRIPTIONS
  // ============================================

  async getSubscriptions(organizationId: string, query: QuerySdkSubscriptionsDto) {
    const { page = 1, limit = 20, customerId, customerExternalId, agentId, status } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      organizationId,
      deletedAt: null,
    };

    if (customerId) {
      where.customerId = customerId;
    } else if (customerExternalId) {
      const customer = await this.prisma.customers.findFirst({
        where: {
          externalId: customerExternalId,
          organizationId,
          deletedAt: null,
        },
      });
      if (customer) {
        where.customerId = customer.id;
      } else {
        return { subscriptions: [], page, limit, totalPages: 0, totalResults: 0 };
      }
    }

    if (agentId) {
      where.agentId = agentId;
    }

    if (status) {
      where.status = status;
    }

    const [subscriptions, totalResults] = await Promise.all([
      this.prisma.subscriptions.findMany({
        where,
        include: {
          customers: {
            select: {
              id: true,
              name: true,
              email: true,
              externalId: true,
            },
          },
          agents: {
            select: {
              id: true,
              name: true,
              agentCode: true,
            },
          },
          pricing_plans: {
            select: {
              id: true,
              name: true,
              description: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.subscriptions.count({ where }),
    ]);

    return {
      subscriptions: subscriptions.map((sub: any) => ({
        id: sub.id,
        status: sub.status,
        startDate: sub.startDate,
        endDate: sub.endDate,
        billingCycle: sub.billingCycle,
        timezone: sub.timezone,
        customer: sub.customers
          ? {
              id: sub.customers.id,
              name: sub.customers.name,
              email: sub.customers.email,
              externalId: sub.customers.externalId,
            }
          : null,
        agent: sub.agents
          ? {
              id: sub.agents.id,
              name: sub.agents.name,
              agentCode: sub.agents.agentCode,
            }
          : null,
        plan: sub.pricing_plans
          ? {
              id: sub.pricing_plans.id,
              name: sub.pricing_plans.name,
              description: sub.pricing_plans.description,
            }
          : null,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
      })),
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  async getSubscription(organizationId: string, subscriptionId: string) {
    const subscription = await this.prisma.subscriptions.findFirst({
      where: {
        id: subscriptionId,
        organizationId,
        deletedAt: null,
      },
      include: {
        customers: {
          select: {
            id: true,
            name: true,
            email: true,
            externalId: true,
            phone: true,
          },
        },
        agents: {
          select: {
            id: true,
            name: true,
            agentCode: true,
            description: true,
          },
        },
        pricing_plans: {
          select: {
            id: true,
            name: true,
            description: true,
            featuresList: true,
          },
        },
      },
    });

    if (!subscription) {
      throw new NotFoundException('Subscription not found');
    }

    const sub = subscription as any;

    const now = new Date();
    const periodStart = subscription.startDate || now;

    const periodEnd = new Date(periodStart);
    if (subscription.billingCycle === 'monthly') {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    } else if (subscription.billingCycle === 'yearly') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const usageEvents = await this.prisma.signal_events.findMany({
      where: {
        subscriptionId: subscription.id,
        usageDate: {
          gte: periodStart,
          lte: now > periodEnd ? periodEnd : now,
        },
      },
    });

    const usageSummary = {
      totalEvents: usageEvents.length,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    };

    return {
      id: subscription.id,
      status: subscription.status,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      billingCycle: subscription.billingCycle,
      timezone: subscription.timezone,
      customer: sub.customers
        ? {
            id: sub.customers.id,
            name: sub.customers.name,
            email: sub.customers.email,
            externalId: sub.customers.externalId,
            phone: sub.customers.phone,
          }
        : null,
      agent: sub.agents
        ? {
            id: sub.agents.id,
            name: sub.agents.name,
            agentCode: sub.agents.agentCode,
            description: sub.agents.description,
          }
        : null,
      plan: sub.pricing_plans
        ? {
            id: sub.pricing_plans.id,
            name: sub.pricing_plans.name,
            description: sub.pricing_plans.description,
            features: sub.pricing_plans.featuresList,
          }
        : null,
      usage: usageSummary,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    };
  }
}
