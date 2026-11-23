'use server'

/**
 * WHAT THIS FILE DOES: Server actions for the Law tab's matters —
 * list matters with their actual AI cost, create/edit/close them, list the
 * Unassigned events, and manually assign/unassign an event to a matter.
 *
 * WHY IT EXISTS: law firms may bill AI work only at actual per-matter cost
 * (ABA Op. 512); these actions are how a firm creates the matters and
 * corrects the attribution the ingest hook couldn't decide.
 *
 * CONNECTS TO: _shared/assert-law-manager.ts (every action's gate),
 * matter-rules.ts (routing rules + Apply rules), matter-export.ts (the audit
 * CSV), src/features/law/* (the UI), api-nest matter-attribution.util.ts
 * (the ingest half of the same precedence).
 *
 * Every action — reads included — gates on LAW_MANAGE_ROLES.
 */

import { Prisma } from '@prisma/client'
import { getMatterCostRollups } from '@marginfront/db'
import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
import { assertLawManager } from './_shared/assert-law-manager'

export type MatterStatus = 'open' | 'closed'
export type MatterSource = 'tag' | 'rule' | 'manual'

export type MatterRow = {
  id: string
  matterNumber: string
  name: string
  clientName: string
  status: MatterStatus
  responsibleUserId: string | null
  /** SUM(signal_events.usageCost) over ALL time (canon C1; null costs add 0). */
  actualCost: number
  eventCount: number
  /** Events whose cost is still unresolved — they add 0 to actualCost and
   * must show as pending, never hide (canon C1). */
  eventsMissingCost: number
}

export type MatterEventRow = {
  eventId: string
  usageDate: string
  agentName: string
  signalName: string
  quantity: number | null
  /** Null = cost not yet resolved (needs backfill) — shown as missing, never 0. */
  usageCost: number | null
  source: MatterSource | null
}

export type MatterDetail = {
  matter: Omit<MatterRow, 'actualCost' | 'eventCount' | 'eventsMissingCost'>
  actualCost: number
  eventCount: number
  eventsMissingCost: number
  /** Most recent 100 events; the export carries the full record. */
  events: MatterEventRow[]
}

export type UnassignedSummary = {
  count: number
  totalCost: number
  eventsMissingCost: number
  events: MatterEventRow[]
}

const toNum = (d: Prisma.Decimal | null) => (d === null ? null : Number(d))

const EVENT_SELECT = {
  id: true,
  usageDate: true,
  quantity: true,
  usageCost: true,
  matterSource: true,
  agents: { select: { name: true } },
  signals: { select: { name: true } },
} satisfies Prisma.signal_eventsSelect

function serializeEvent(ev: {
  id: string
  usageDate: Date
  quantity: Prisma.Decimal | null
  usageCost: Prisma.Decimal | null
  matterSource: MatterSource | null
  agents: { name: string }
  signals: { name: string } | null
}): MatterEventRow {
  return {
    eventId: ev.id,
    usageDate: ev.usageDate.toISOString(),
    agentName: ev.agents.name,
    signalName: ev.signals?.name ?? '(no signal)',
    quantity: toNum(ev.quantity),
    usageCost: toNum(ev.usageCost),
    source: ev.matterSource,
  }
}

/** The org's matters with all-time cost + event count (one canonical rollup
 * call — canon C1 lives in getMatterCostRollups — no N+1). */
export async function getMatters(): Promise<MatterRow[]> {
  const gate = await assertLawManager()
  if (!gate.ok) return []
  const orgId = gate.orgId

  const [matters, rollups] = await Promise.all([
    db.matters.findMany({
      where: { orgId },
      orderBy: [{ status: 'asc' }, { matterNumber: 'asc' }],
    }),
    // Unfiltered = every bucket with events; the Unassigned (null) bucket
    // rides along and the id lookup below just never hits it.
    getMatterCostRollups(db, orgId),
  ])

  const rollupByMatter = new Map(rollups.map((r) => [r.matterId, r]))

  return matters.map((m) => ({
    id: m.id,
    matterNumber: m.matterNumber,
    name: m.name,
    clientName: m.clientName,
    status: m.status,
    responsibleUserId: m.responsibleUserId,
    actualCost: rollupByMatter.get(m.id)?.cost ?? 0,
    eventCount: rollupByMatter.get(m.id)?.eventCount ?? 0,
    eventsMissingCost: rollupByMatter.get(m.id)?.eventsMissingCost ?? 0,
  }))
}

/** One matter + its most recent events (the drill-in view). */
export async function getMatterDetail(
  matterId: string
): Promise<MatterDetail | null> {
  const gate = await assertLawManager()
  if (!gate.ok) return null
  const orgId = gate.orgId

  const matter = await db.matters.findFirst({
    where: { id: matterId, orgId },
  })
  if (!matter) return null

  const [events, [rollup]] = await Promise.all([
    db.signal_events.findMany({
      where: { organizationId: orgId, matterId },
      select: EVENT_SELECT,
      orderBy: { usageDate: 'desc' },
      take: 100,
    }),
    // Zero-filled by contract: the requested bucket always comes back.
    getMatterCostRollups(db, orgId, { matterIds: [matterId] }),
  ])

  return {
    matter: {
      id: matter.id,
      matterNumber: matter.matterNumber,
      name: matter.name,
      clientName: matter.clientName,
      status: matter.status,
      responsibleUserId: matter.responsibleUserId,
    },
    actualCost: rollup.cost,
    eventCount: rollup.eventCount,
    eventsMissingCost: rollup.eventsMissingCost,
    events: events.map(serializeEvent),
  }
}

export type MatterInput = {
  id?: string
  matterNumber: string
  name: string
  clientName: string
  status?: MatterStatus
  responsibleUserId?: string | null
}

/** Create or update a matter. matterNumber is the firm's own case id — unique
 * per org, matched exactly (trimmed) against metadata.matterId at ingest. */
export async function upsertMatter(
  input: MatterInput
): Promise<{ success: boolean; matterId?: string; error?: string }> {
  const gate = await assertLawManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  const matterNumber = input.matterNumber.trim()
  const name = input.name.trim()
  const clientName = input.clientName.trim()
  if (!matterNumber)
    return { success: false, error: 'Matter number is required.' }
  if (!name) return { success: false, error: 'Matter name is required.' }
  if (!clientName) return { success: false, error: 'Client name is required.' }
  for (const [label, value] of [
    ['Matter number', matterNumber],
    ['Matter name', name],
    ['Client name', clientName],
  ] as const) {
    if (value.length > 255) {
      return {
        success: false,
        error: `${label} must be 255 characters or fewer.`,
      }
    }
  }

  const data = {
    matterNumber,
    name,
    clientName,
    status: input.status ?? ('open' as const),
    responsibleUserId: input.responsibleUserId ?? null,
  }

  try {
    if (input.id) {
      const updated = await db.matters.updateMany({
        where: { id: input.id, orgId },
        data,
      })
      if (updated.count === 0) {
        return {
          success: false,
          error: 'Matter not found in this organization.',
        }
      }
      revalidatePath('/law')
      return { success: true, matterId: input.id }
    }

    const created = await db.matters.create({ data: { orgId, ...data } })
    revalidatePath('/law')
    return { success: true, matterId: created.id }
  } catch (err) {
    // P2002 = unique-constraint violation; raw Prisma messages name models and
    // columns, so nothing else from err reaches the customer's toast.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return {
        success: false,
        error: `A matter numbered "${matterNumber}" already exists in this organization.`,
      }
    }
    console.error('[upsertMatter] Error:', err)
    return {
      success: false,
      error: "Couldn't save the matter. Try again.",
    }
  }
}

/**
 * Delete a matter. Its events survive (FK SetNull) and return to Unassigned;
 * the same transaction clears their matterSource so a stale tag/rule stamp
 * can't outlive the matter it pointed at — that invariant is what lets
 * "Apply rules" treat (matterId null, matterSource null) as re-sweepable.
 */
export async function deleteMatter(
  matterId: string
): Promise<{ success: boolean; error?: string }> {
  const gate = await assertLawManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  try {
    const matter = await db.matters.findFirst({
      where: { id: matterId, orgId },
      select: { id: true },
    })
    if (!matter) {
      return { success: false, error: 'Matter not found in this organization.' }
    }

    await db.$transaction([
      db.signal_events.updateMany({
        where: { organizationId: orgId, matterId },
        data: { matterSource: null },
      }),
      db.matters.delete({ where: { id: matterId } }),
    ])
  } catch (err) {
    console.error('[deleteMatter] Error:', err)
    return {
      success: false,
      error: "Couldn't delete the matter. Nothing changed. Try again.",
    }
  }

  revalidatePath('/law')
  return { success: true }
}

/** The always-visible Unassigned badge count. NO date window on purpose —
 * it must never read zero while unassigned events exist, anywhere in
 * history. */
export async function getUnassignedCount(): Promise<number | null> {
  const gate = await assertLawManager()
  if (!gate.ok) return null
  const orgId = gate.orgId

  return db.signal_events.count({
    where: { organizationId: orgId, matterId: null },
  })
}

/** The Unassigned tab: total count + cost, and the most recent 100 events. */
export async function getUnassignedEvents(): Promise<UnassignedSummary | null> {
  const gate = await assertLawManager()
  if (!gate.ok) return null
  const orgId = gate.orgId

  const where = { organizationId: orgId, matterId: null }
  const [events, [rollup]] = await Promise.all([
    db.signal_events.findMany({
      where,
      select: EVENT_SELECT,
      orderBy: { usageDate: 'desc' },
      take: 100,
    }),
    // matterIds: [null] = the Unassigned bucket; zero-filled by contract.
    getMatterCostRollups(db, orgId, { matterIds: [null] }),
  ])

  return {
    count: rollup.eventCount,
    totalCost: rollup.cost,
    eventsMissingCost: rollup.eventsMissingCost,
    events: events.map(serializeEvent),
  }
}

/**
 * Manual assignment — the operator's correction, and the top of the
 * precedence order: it overrides a prior tag or rule. `matterId: null`
 * unassigns (recorded as source 'manual' so "Apply rules" won't silently
 * re-sweep an event an operator explicitly pulled off a matter).
 */
export async function assignEventToMatter(
  eventId: string,
  matterId: string | null
): Promise<{ success: boolean; error?: string }> {
  const gate = await assertLawManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  try {
    if (matterId !== null) {
      const matter = await db.matters.findFirst({
        where: { id: matterId, orgId },
        select: { id: true },
      })
      if (!matter) {
        return {
          success: false,
          error: 'Matter not found in this organization.',
        }
      }
    }

    // updateMany scoped by org so a foreign event id is a no-op, not a leak.
    const updated = await db.signal_events.updateMany({
      where: { id: eventId, organizationId: orgId },
      data: { matterId, matterSource: 'manual' },
    })
    if (updated.count === 0) {
      return {
        success: false,
        error: 'Usage event not found in this organization.',
      }
    }
  } catch (err) {
    console.error('[assignEventToMatter] Error:', err)
    return {
      success: false,
      error: "Couldn't move the event. Try again.",
    }
  }

  revalidatePath('/law')
  return { success: true }
}
