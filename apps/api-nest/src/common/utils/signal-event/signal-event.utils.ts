import { Prisma, PrismaClient } from '@prisma/client';
// Parent-rollup helpers live in @marginfront/db so the dashboard Server Actions and
// the repair scripts run the same code path; re-exported below for the api-nest
// callers that import them from here.
import {
  recomputeParentUsageCost as recomputeParentUsageCostShared,
  assertEventCostInvariant as assertEventCostInvariantShared,
  worstStatus as worstStatusShared,
  STATUS_PRIORITY as STATUS_PRIORITY_SHARED,
  type SignalEventStatus as SignalEventStatusShared,
} from '@marginfront/db';

export type SignalEventStatus = SignalEventStatusShared;
export const STATUS_PRIORITY = STATUS_PRIORITY_SHARED;
export const worstStatus = worstStatusShared;
export const recomputeParentUsageCost = recomputeParentUsageCostShared;
export const assertEventCostInvariant = assertEventCostInvariantShared;

/** One signal_event_services child row. The caller pre-computes all cost math. */
export interface SignalEventServiceInput {
  model: string;
  modelProvider: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Prompt-cache read/write token counts. Null when the caller sent none. */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  quantity?: Prisma.Decimal | number | null;
  servicePricingId?: string | null;
  usageCost?: Prisma.Decimal | number | null;
  usageCostData?: Prisma.InputJsonValue | null;
  eventStatus: SignalEventStatus;
}

export interface CreateSignalEventInput {
  id: string; // caller-provided UUID for the parent
  customerExternalId: string;
  customerId: string;
  subscriptionId?: string | null;
  organizationId: string;
  agentId: string;
  signalId?: string | null;
  rawIngestEventId: string;
  usageDate: Date;
  quantity?: Prisma.Decimal | number | null;
  metadata?: Prisma.InputJsonValue | null;
  /** SUM of children's usageCost, or null if any child is unresolved (per canon invariant). */
  usageCost?: Prisma.Decimal | number | null;
  /** Per-service breakdown JSON, keyed by `${model}/input` etc. */
  usageCostData?: Prisma.InputJsonValue | null;
  /** Worst-case status across children, per canon all-or-nothing semantics. */
  eventProcessed: SignalEventStatus;
  eventProcessedAt?: Date | null;
  /** Drives the COGS vs R&D accounting split. Null when the caller sent none. */
  environment?: 'production' | 'staging' | 'development' | 'testing' | null;
  /**
   * A repeat ingest with the same (organizationId, idempotencyKey)
   * collides on the NULL-safe unique index instead of duplicating. Null for the
   * common SDK path, which sends no key — NULLs never collide.
   */
  idempotencyKey?: string | null;
  /** Which matter this event bills to. Null = Unassigned (a visible
   * bucket, never a silent drop). Resolved at ingest (tag|rule) or set by an
   * operator later (manual). */
  matterId?: string | null;
  matterSource?: 'tag' | 'rule' | 'manual' | null;

  services: SignalEventServiceInput[];
}

/**
 * Sequential writes, not a nested create, so a partial failure names the child
 * that failed — without the `transaction` argument the parent stays written.
 * Caller owns the cost math: parent.usageCost = SUM(children), or null if ANY
 * child is unresolved; parent.eventProcessed = worst status across children.
 */
export async function createSignalEventWithServices(
  input: CreateSignalEventInput,
  prisma: PrismaClient,
  transaction?: Prisma.TransactionClient,
): Promise<{
  event: Awaited<ReturnType<PrismaClient['signal_events']['create']>>;
  services: Awaited<ReturnType<PrismaClient['signal_event_services']['create']>>[];
}> {
  if (input.services.length === 0) {
    throw new Error(
      `createSignalEventWithServices: services array is empty for event ` +
        `${input.id}. Every event must have at least one service entry ` +
        `(single-service callers default to one entry). This is a caller bug.`,
    );
  }

  const client = transaction ?? prisma;
  const now = new Date();

  const event = await client.signal_events.create({
    data: {
      id: input.id,
      customerExternalId: input.customerExternalId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId ?? null,
      organizationId: input.organizationId,
      agentId: input.agentId,
      signalId: input.signalId ?? null,
      rawIngestEventId: input.rawIngestEventId,
      usageDate: input.usageDate,
      quantity: input.quantity ?? null,
      metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      usageCost: input.usageCost ?? null,
      usageCostData: (input.usageCostData ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      eventProcessed: input.eventProcessed,
      eventProcessedAt: input.eventProcessedAt ?? now,
      environment: input.environment ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      matterId: input.matterId ?? null,
      matterSource: input.matterSource ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });

  const writtenServices: Awaited<ReturnType<PrismaClient['signal_event_services']['create']>>[] =
    [];
  for (const svc of input.services) {
    try {
      const child = await client.signal_event_services.create({
        data: {
          signalEventId: event.id,
          model: svc.model,
          modelProvider: svc.modelProvider,
          inputTokens: svc.inputTokens ?? null,
          outputTokens: svc.outputTokens ?? null,
          cacheReadTokens: svc.cacheReadTokens ?? null,
          cacheWriteTokens: svc.cacheWriteTokens ?? null,
          quantity: svc.quantity ?? null,
          servicePricingId: svc.servicePricingId ?? null,
          usageCost: svc.usageCost ?? null,
          usageCostData: (svc.usageCostData ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          eventStatus: svc.eventStatus,
        },
      });
      writtenServices.push(child);
    } catch (err) {
      throw new Error(
        `createSignalEventWithServices: failed to write child for event ` +
          `${event.id} (model=${svc.model}, provider=${svc.modelProvider}): ` +
          `${(err as Error).message}`,
      );
    }
  }

  return { event, services: writtenServices };
}
