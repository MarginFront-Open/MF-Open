/**
 * Signal-event parent rollup helpers — shared across api-nest and the
 * dashboard so backfill-flow callers do not drift apart.
 *
 * Both surfaces (api-nest's mapModel/fillVolume and the dashboard's
 * mapModelAndBackfill/fillMissingVolume Server Actions) need to:
 *   1. Update specific signal_event_services children
 *   2. Recompute the parent signal_event's usageCost + eventProcessed
 *      from the union of its children
 *
 * The recompute logic enforces the canon invariant: if ANY child has
 * null usageCost, parent stays null. Parent flips to PROCESSED only
 * when ALL children are PROCESSED.
 *
 * Lives in @marginfront/db so the API and the dashboard's Server Actions
 * share one source of truth.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * The five status values defined by enum_signal_events_eventProcessed.
 * Repeated here as a string-literal union so callers can pass values
 * without importing Prisma's generated enum.
 */
export type SignalEventStatus =
  | "PENDING"
  | "PROCESSED"
  | "ERROR"
  | "NEEDS_COST_BACKFILL"
  | "MISSING_VOLUME_DATA";

/**
 * Status priority used when deriving a parent's status from its children.
 * Worst-case wins so the parent reflects the most-blocked child.
 */
export const STATUS_PRIORITY: SignalEventStatus[] = [
  "ERROR",
  "NEEDS_COST_BACKFILL",
  "MISSING_VOLUME_DATA",
  "PENDING",
  "PROCESSED",
];

/**
 * Pick the worst-case status across a list of child statuses.
 */
export function worstStatus(statuses: SignalEventStatus[]): SignalEventStatus {
  for (const candidate of STATUS_PRIORITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "PROCESSED";
}

/**
 * Recompute a parent signal_event's usageCost + eventProcessed from the
 * union of its children. Used by backfill flows (mapModel, fillVolume)
 * after a previously-unresolved child becomes resolvable.
 *
 * Per canon invariant: if ANY child has null usageCost, parent stays
 * null. Parent flips to PROCESSED only when ALL children are PROCESSED.
 *
 * If the parent has no children rows, returns the parent's current
 * state without modification (defensive: avoids writing null over
 * legitimate parent costs on single-service events with no child rows).
 *
 * Returns the final (usageCost, eventProcessed) pair after the update.
 */
export async function recomputeParentUsageCost(
  signalEventId: string,
  prisma: PrismaClient,
  transaction?: Prisma.TransactionClient,
): Promise<{
  usageCost: Prisma.Decimal | null;
  eventProcessed: SignalEventStatus;
}> {
  const client = transaction ?? prisma;

  const children = await client.signal_event_services.findMany({
    where: { signalEventId },
    select: { usageCost: true, eventStatus: true },
  });

  if (children.length === 0) {
    const event = await client.signal_events.findUnique({
      where: { id: signalEventId },
      select: { usageCost: true, eventProcessed: true },
    });
    return {
      usageCost: event?.usageCost ?? null,
      eventProcessed: (event?.eventProcessed ?? "PENDING") as SignalEventStatus,
    };
  }

  const parentStatus = worstStatus(
    children.map((c) => c.eventStatus as SignalEventStatus),
  );

  const anyNullCost = children.some((c) => c.usageCost === null);
  const parentUsageCost: Prisma.Decimal | null = anyNullCost
    ? null
    : children.reduce(
        (sum, c) => sum.add(c.usageCost ?? new Prisma.Decimal(0)),
        new Prisma.Decimal(0),
      );

  await client.signal_events.update({
    where: { id: signalEventId },
    data: {
      usageCost: parentUsageCost,
      eventProcessed: parentStatus,
      eventProcessedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  return { usageCost: parentUsageCost, eventProcessed: parentStatus };
}

/**
 * Dev-mode invariant assertion. Throws on violation, no-op on pass.
 *
 * Canon invariant for a parent signal_event with children:
 *   - If ANY child has null usageCost, parent.usageCost MUST be null.
 *   - Otherwise, parent.usageCost MUST equal SUM(children.usageCost).
 *
 * Intended for use in test fixtures, seed scripts, repair scripts, and
 * dev-mode hooks. Not enforced in production hot paths because the cost is
 * a query per call. Callers that need it in prod should gate behind a flag.
 *
 * Lives beside recomputeParentUsageCost, the write it verifies; api-nest's
 * signal-event.utils.ts re-exports it.
 */
export async function assertEventCostInvariant(
  signalEventId: string,
  prisma: PrismaClient,
  transaction?: Prisma.TransactionClient,
): Promise<void> {
  const client = transaction ?? prisma;

  const event = await client.signal_events.findUnique({
    where: { id: signalEventId },
    select: { id: true, usageCost: true, eventProcessed: true },
  });
  if (!event) {
    throw new Error(
      `assertEventCostInvariant: signal_event ${signalEventId} not found`,
    );
  }

  const children = await client.signal_event_services.findMany({
    where: { signalEventId },
    select: { usageCost: true, eventStatus: true },
  });

  // No children means a single-service event with no child rows, or an
  // in-flight write. Invariant doesn't
  // apply (no children to compare against).
  if (children.length === 0) {
    return;
  }

  const anyNullCost = children.some((c) => c.usageCost === null);
  const childCostSum = children.reduce(
    (sum, c) => sum.add(c.usageCost ?? new Prisma.Decimal(0)),
    new Prisma.Decimal(0),
  );

  if (anyNullCost) {
    if (event.usageCost !== null) {
      throw new Error(
        `assertEventCostInvariant violation on event ${signalEventId}: ` +
          `at least one child has null usageCost, but parent.usageCost = ` +
          `${event.usageCost.toString()}. Expected parent to be null per ` +
          `canon invariant.`,
      );
    }
    return;
  }

  if (event.usageCost === null) {
    throw new Error(
      `assertEventCostInvariant violation on event ${signalEventId}: ` +
        `all children have usageCost set, but parent.usageCost is null. ` +
        `Expected parent = SUM(children) = ${childCostSum.toString()}.`,
    );
  }

  if (!event.usageCost.equals(childCostSum)) {
    throw new Error(
      `assertEventCostInvariant violation on event ${signalEventId}: ` +
        `parent.usageCost = ${event.usageCost.toString()}, ` +
        `SUM(children.usageCost) = ${childCostSum.toString()}. ` +
        `Expected equal.`,
    );
  }
}
