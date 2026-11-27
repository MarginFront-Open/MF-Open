'use server'

/**
 * ROI page initiatives + targets.
 *
 * An initiative is an org-level goal with a start/end window ("the ROI
 * page's window"); its targets are manual per-metric goals (cost/revenue/
 * margin/etc. with a direction). No actuals are stored — the ROI page
 * computes actuals at read time from canon over the initiative's window.
 *
 * This is org-content, not per-user personalization, so writes are money
 * writes: gated with assertMoneyManager, same as
 * chart_of_accounts.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
import { assertMoneyManager } from './_shared/assert-money-manager'
import { computeAutoBaselines } from './_shared/initiative-actuals'
import { z } from 'zod'

export type InitiativeStatus = 'active' | 'archived'
export type InitiativeMetric =
  | 'cost'
  | 'revenue'
  | 'margin'
  | 'marginPercent'
  | 'costPerTask'
  | 'eventCount'
  | 'unmappedCount'
  // Trackable metrics. 'new seats' is
  // deliberately absent: no seat-delta history exists to compute it honestly.
  | 'mrr'
  | 'arr'
  | 'newCustomers'
  | 'internalCost'
  | 'externalCost'
export type InitiativeTargetDirection = 'lte' | 'gte'
/** How a stored baseline was written: measured from org data as of the
 * start date, or typed by a person. A null source is treated as manual
 * (never re-measured behind the user's back). */
export type InitiativeBaselineSource = 'auto' | 'manual'

export interface InitiativeTarget {
  id: string
  metric: InitiativeMetric
  targetValue: number
  /** Starting value; null = no baseline (progress falls back to the no-baseline forms). */
  baselineValue: number | null
  baselineSource: InitiativeBaselineSource | null
  direction: InitiativeTargetDirection
}

export interface Initiative {
  id: string
  name: string
  description: string | null
  status: InitiativeStatus
  startDate: string
  endDate: string | null
  /** The one matter this initiative measures; null = the whole
   * organization. */
  matterId: string | null
  /** The matter's CURRENT number, via the relation. What surfaces display. */
  matterNumber: string | null
  /** The number recorded when the scope was set. Outlives the matter (the FK
   * is SET NULL), so matterId null + this set means the matter was deleted. */
  scopedMatterNumber: string | null
  createdByUserId: string | null
  targets: InitiativeTarget[]
  createdAt: string
  updatedAt: string
}

const INITIATIVE_STATUSES = ['active', 'archived'] as const
const INITIATIVE_METRICS = [
  'cost',
  'revenue',
  'margin',
  'marginPercent',
  'costPerTask',
  'eventCount',
  'unmappedCount',
  'mrr',
  'arr',
  'newCustomers',
  'internalCost',
  'externalCost',
] as const
const TARGET_DIRECTIONS = ['lte', 'gte'] as const

const MatterIdSchema = z
  .string()
  .uuid('Pick a matter from the list')
  .nullable()
  .optional()

const InitiativeInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(255),
    description: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(INITIATIVE_STATUSES).optional(),
    startDate: z.string().min(1, 'Start date is required'),
    endDate: z.string().min(1).nullable().optional(),
    matterId: MatterIdSchema,
  })
  .strict()
  .refine(
    (input) =>
      !input.endDate || new Date(input.endDate) >= new Date(input.startDate),
    {
      message: 'End date must be on or after the start date',
      path: ['endDate'],
    }
  )

const InitiativeUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(INITIATIVE_STATUSES).optional(),
    startDate: z.string().min(1).optional(),
    endDate: z.string().min(1).nullable().optional(),
    matterId: MatterIdSchema,
  })
  .strict()

/** The one refusal for a matter id the caller has no claim to. */
const MATTER_NOT_IN_ORG =
  "That matter isn't in your organization, so nothing was saved. Pick a matter from the list and try again."

/**
 * Resolve a matter scope against the caller's org. Null = no such matter
 * there, which every
 * caller turns into MATTER_NOT_IN_ORG before writing anything.
 */
async function resolveMatterScope(
  orgId: string,
  matterId: string
): Promise<{ matterId: string; scopedMatterNumber: string } | null> {
  const matter = await db.matters.findFirst({
    where: { id: matterId, orgId },
    select: { id: true, matterNumber: true },
  })
  if (!matter) return null
  return { matterId: matter.id, scopedMatterNumber: matter.matterNumber }
}

// margin/marginPercent can legitimately go negative (a loss-leader phase
// targeting "keep the loss above -10%"); cost/revenue/costPerTask/eventCount
// can't — a target of "-50 events" isn't a real goal.
const METRICS_ALLOWING_NEGATIVE_TARGETS: ReadonlySet<InitiativeMetric> =
  new Set(['margin', 'marginPercent'])

const BASELINE_SOURCES = ['auto', 'manual'] as const

const TargetInputSchema = z
  .object({
    metric: z.enum(INITIATIVE_METRICS),
    targetValue: z.number().finite(),
    baselineValue: z.number().finite().nullable().optional(),
    baselineSource: z.enum(BASELINE_SOURCES).optional(),
    direction: z.enum(TARGET_DIRECTIONS),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (
      target.targetValue < 0 &&
      !METRICS_ALLOWING_NEGATIVE_TARGETS.has(target.metric)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${target.metric}" targets can't be negative`,
        path: ['targetValue'],
      })
    }
  })

const TargetsInputSchema = z.array(TargetInputSchema).max(50)

// zod reads every item before applying .max(), so refuse a long list first.
const MAX_LIST_ITEMS = 50
const TOO_MANY_TARGETS = `A goal can have at most ${MAX_LIST_ITEMS} targets, so nothing was saved. Remove some and try again.`
const TOO_MANY_METRICS = `This preview can measure at most ${MAX_LIST_ITEMS} metrics at once, so nothing was measured. Ask for fewer and try again.`

function serializeInitiative(row: {
  id: string
  name: string
  description: string | null
  status: string
  startDate: Date
  endDate: Date | null
  matterId: string | null
  scopedMatterNumber: string | null
  matters?: { matterNumber: string } | null
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
  initiative_targets: Array<{
    id: string
    metric: string
    targetValue: unknown
    baselineValue?: unknown
    baselineSource?: string | null
    direction: string
  }>
}): Initiative {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as InitiativeStatus,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate ? row.endDate.toISOString() : null,
    matterId: row.matterId,
    matterNumber: row.matters?.matterNumber ?? null,
    scopedMatterNumber: row.scopedMatterNumber,
    createdByUserId: row.createdByUserId,
    targets: row.initiative_targets.map((t) => ({
      id: t.id,
      metric: t.metric as InitiativeMetric,
      targetValue: Number(t.targetValue),
      baselineValue: t.baselineValue == null ? null : Number(t.baselineValue),
      baselineSource: (t.baselineSource ??
        null) as InitiativeBaselineSource | null,
      direction: t.direction as InitiativeTargetDirection,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * List the active org's initiatives (all statuses) with their targets.
 */
export async function getInitiatives(): Promise<{
  success: boolean
  data?: Initiative[]
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    const orgId = session.session.activeOrganizationId

    const rows = await db.initiatives.findMany({
      where: { orgId },
      include: {
        initiative_targets: true,
        matters: { select: { matterNumber: true } },
      },
      orderBy: { startDate: 'desc' },
    })

    return { success: true, data: rows.map(serializeInitiative) }
  } catch (error) {
    console.error('[getInitiatives] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to load initiatives',
    }
  }
}

/**
 * Create a new initiative. Money write — Manage-MONEY roles only.
 */
export async function createInitiative(input: {
  name: string
  description?: string | null
  status?: InitiativeStatus
  startDate: string
  endDate?: string | null
  /** Null or absent = the whole organization. */
  matterId?: string | null
}): Promise<{ success: boolean; data?: Initiative; error?: string }> {
  try {
    const parsed = InitiativeInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues.map((i) => i.message).join('; '),
      }
    }

    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId

    const scope = parsed.data.matterId
      ? await resolveMatterScope(orgId, parsed.data.matterId)
      : null
    if (parsed.data.matterId && !scope) {
      return { success: false, error: MATTER_NOT_IN_ORG }
    }

    const created = await db.initiatives.create({
      data: {
        orgId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? 'active',
        startDate: new Date(parsed.data.startDate),
        endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
        matterId: scope ? scope.matterId : null,
        scopedMatterNumber: scope ? scope.scopedMatterNumber : null,
        createdByUserId: gate.userId,
      },
      include: {
        initiative_targets: true,
        matters: { select: { matterNumber: true } },
      },
    })

    revalidatePath('/', 'layout')
    return { success: true, data: serializeInitiative(created) }
  } catch (error) {
    console.error('[createInitiative] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to create initiative',
    }
  }
}

/**
 * Update an existing initiative's fields. Money write — Manage-MONEY roles
 * only. Ownership is checked before the update (the initiative must belong
 * to the caller's org).
 */
export async function updateInitiative(
  id: string,
  input: {
    name?: string
    description?: string | null
    status?: InitiativeStatus
    startDate?: string
    endDate?: string | null
    /** Null widens back to org-wide; ABSENT keeps the stored scope. */
    matterId?: string | null
  }
): Promise<{ success: boolean; data?: Initiative; error?: string }> {
  try {
    const parsed = InitiativeUpdateSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues.map((i) => i.message).join('; '),
      }
    }

    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId

    const existing = await db.initiatives.findFirst({
      where: { id, orgId },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        matterId: true,
        initiative_targets: {
          select: { id: true, metric: true, baselineSource: true },
        },
      },
    })
    if (!existing) return { success: false, error: 'Initiative not found' }

    // Resolved BEFORE any write, so a borrowed matter id leaves the whole
    // edit unwritten rather than half-applied.
    const scope = parsed.data.matterId
      ? await resolveMatterScope(orgId, parsed.data.matterId)
      : null
    if (parsed.data.matterId && !scope) {
      return { success: false, error: MATTER_NOT_IN_ORG }
    }
    const nextMatterId =
      parsed.data.matterId === undefined
        ? existing.matterId
        : (scope?.matterId ?? null)

    const nextStartDate = parsed.data.startDate
      ? new Date(parsed.data.startDate)
      : existing.startDate
    const nextEndDate =
      parsed.data.endDate === undefined
        ? existing.endDate
        : parsed.data.endDate
          ? new Date(parsed.data.endDate)
          : null
    if (nextEndDate && nextEndDate < nextStartDate) {
      return {
        success: false,
        error: 'End date must be on or after the start date',
      }
    }

    // A moved start date invalidates MEASURED starting values, so 'auto'
    // targets re-measure; 'manual' (and null-source) baselines are a
    // person's choice and are never replaced here. A moved
    // matter scope invalidates them the same way: the old number
    // measured a different slice of the org's spend.
    const startDateChanged =
      parsed.data.startDate !== undefined &&
      nextStartDate.toISOString().slice(0, 10) !==
        existing.startDate.toISOString().slice(0, 10)
    const scopeChanged =
      parsed.data.matterId !== undefined && nextMatterId !== existing.matterId
    if (startDateChanged || scopeChanged) {
      const autoTargets = existing.initiative_targets.filter(
        (t) => t.baselineSource === 'auto'
      )
      if (autoTargets.length > 0) {
        const measured = await computeAutoBaselines(
          orgId,
          {
            startDate: nextStartDate.toISOString().slice(0, 10),
            endDate: nextEndDate
              ? nextEndDate.toISOString().slice(0, 10)
              : null,
          },
          autoTargets.map((t) => t.metric as InitiativeMetric),
          nextMatterId
        )
        for (const target of autoTargets) {
          await db.initiative_targets.update({
            where: { id: target.id },
            data: {
              baselineValue:
                measured.get(target.metric as InitiativeMetric) ?? null,
            },
          })
        }
      }
    }

    const updated = await db.initiatives.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.status !== undefined
          ? { status: parsed.data.status }
          : {}),
        ...(parsed.data.startDate !== undefined
          ? { startDate: nextStartDate }
          : {}),
        ...(parsed.data.endDate !== undefined ? { endDate: nextEndDate } : {}),
        // The recorded number moves with the id, always — it is what tells a
        // later reader that a now-deleted matter was once the scope.
        ...(parsed.data.matterId !== undefined
          ? {
              matterId: scope ? scope.matterId : null,
              scopedMatterNumber: scope ? scope.scopedMatterNumber : null,
            }
          : {}),
      },
      include: {
        initiative_targets: true,
        matters: { select: { matterNumber: true } },
      },
    })

    revalidatePath('/', 'layout')
    return { success: true, data: serializeInitiative(updated) }
  } catch (error) {
    console.error('[updateInitiative] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to update initiative',
    }
  }
}

/**
 * Delete an initiative (and its targets, via FK cascade). Money write —
 * Manage-MONEY roles only.
 */
export async function deleteInitiative(
  id: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId

    const existing = await db.initiatives.findFirst({
      where: { id, orgId },
      select: { id: true },
    })
    if (!existing) return { success: false, error: 'Initiative not found' }

    await db.initiatives.delete({ where: { id } })

    revalidatePath('/', 'layout')
    return { success: true }
  } catch (error) {
    console.error('[deleteInitiative] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to delete initiative',
    }
  }
}

/**
 * Replace the full set of targets for an initiative. There's no uniqueness
 * on (initiativeId, metric) in the schema, so "edit the targets" is
 * replace-all rather than per-metric upsert — the caller sends the complete
 * desired set every time. Money write — Manage-MONEY roles only.
 *
 * Starting values: a row that arrives without a baseline is
 * MEASURED here, server-side, from the org's own numbers as of the
 * initiative's start date (computeAutoBaselines — the same read path the
 * actuals use). A row that arrives with baselineSource 'manual' (or with a
 * value and no source) is stored exactly as sent.
 * An 'auto' row that arrives WITH a value is a carry-forward of an earlier
 * measurement and is stored as sent — the dialog clears the value when the
 * start date moves, which is what forces a re-measure.
 */
export async function setInitiativeTargets(
  initiativeId: string,
  targets: Array<{
    metric: InitiativeMetric
    targetValue: number
    baselineValue?: number | null
    baselineSource?: InitiativeBaselineSource
    direction: InitiativeTargetDirection
  }>
): Promise<{ success: boolean; data?: InitiativeTarget[]; error?: string }> {
  try {
    if (Array.isArray(targets) && targets.length > MAX_LIST_ITEMS) {
      return { success: false, error: TOO_MANY_TARGETS }
    }

    const parsed = TargetsInputSchema.safeParse(targets)
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid targets: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      }
    }

    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId

    const existing = await db.initiatives.findFirst({
      where: { id: initiativeId, orgId },
      select: { id: true, startDate: true, endDate: true, matterId: true },
    })
    if (!existing) return { success: false, error: 'Initiative not found' }

    const resolvedRows = parsed.data.map((t) => ({
      metric: t.metric,
      targetValue: t.targetValue,
      direction: t.direction,
      baselineValue: t.baselineValue ?? null,
      baselineSource:
        t.baselineSource ?? (t.baselineValue != null ? 'manual' : 'auto'),
    }))

    const metricsToMeasure = resolvedRows
      .filter((t) => t.baselineSource === 'auto' && t.baselineValue === null)
      .map((t) => t.metric)
    const measured =
      metricsToMeasure.length > 0
        ? await computeAutoBaselines(
            orgId,
            {
              startDate: existing.startDate.toISOString().slice(0, 10),
              endDate: existing.endDate
                ? existing.endDate.toISOString().slice(0, 10)
                : null,
            },
            metricsToMeasure,
            existing.matterId
          )
        : new Map<InitiativeMetric, number | null>()

    await db.initiative_targets.deleteMany({ where: { initiativeId } })
    if (resolvedRows.length > 0) {
      await db.initiative_targets.createMany({
        data: resolvedRows.map((t) => ({
          initiativeId,
          metric: t.metric,
          targetValue: t.targetValue,
          baselineValue:
            t.baselineSource === 'auto' && t.baselineValue === null
              ? (measured.get(t.metric) ?? null)
              : t.baselineValue,
          baselineSource: t.baselineSource,
          direction: t.direction,
        })),
      })
    }

    const rows = await db.initiative_targets.findMany({
      where: { initiativeId },
    })

    revalidatePath('/', 'layout')
    return {
      success: true,
      data: rows.map((t) => ({
        id: t.id,
        metric: t.metric as InitiativeMetric,
        targetValue: Number(t.targetValue),
        baselineValue: t.baselineValue == null ? null : Number(t.baselineValue),
        baselineSource: (t.baselineSource ??
          null) as InitiativeBaselineSource | null,
        direction: t.direction as InitiativeTargetDirection,
      })),
    }
  } catch (error) {
    console.error('[setInitiativeTargets] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to save initiative targets',
    }
  }
}

/**
 * Measure what each metric's starting value WOULD be for an initiative
 * window, without saving anything — the dialog shows this inside the
 * starting-figure disclosure before the user commits. Same gate as
 * the writes it previews (the preview exists only to feed them), same
 * computeAutoBaselines the save path stores.
 */
export async function previewAutoBaselines(input: {
  startDate: string
  endDate?: string | null
  metrics: InitiativeMetric[]
  /** Measure through the same scope the save will use, so the
   * previewed number is the one that gets stored. */
  matterId?: string | null
}): Promise<{
  success: boolean
  data?: Array<{ metric: InitiativeMetric; baseline: number | null }>
  error?: string
}> {
  try {
    if (
      Array.isArray(input?.metrics) &&
      input.metrics.length > MAX_LIST_ITEMS
    ) {
      return { success: false, error: TOO_MANY_METRICS }
    }

    const parsed = z
      .object({
        startDate: z.string().min(1, 'Start date is required'),
        endDate: z.string().min(1).nullable().optional(),
        metrics: z.array(z.enum(INITIATIVE_METRICS)).min(1).max(50),
        matterId: MatterIdSchema,
      })
      .strict()
      .safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues.map((i) => i.message).join('; '),
      }
    }

    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }
    const orgId = gate.orgId

    const scope = parsed.data.matterId
      ? await resolveMatterScope(orgId, parsed.data.matterId)
      : null
    if (parsed.data.matterId && !scope) {
      return { success: false, error: MATTER_NOT_IN_ORG }
    }

    const measured = await computeAutoBaselines(
      orgId,
      {
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate ?? null,
      },
      parsed.data.metrics,
      scope ? scope.matterId : null
    )

    return {
      success: true,
      data: parsed.data.metrics.map((metric) => ({
        metric,
        baseline: measured.get(metric) ?? null,
      })),
    }
  } catch (error) {
    console.error('[previewAutoBaselines] Error:', error)
    return {
      success: false,
      error:
        "Couldn't measure a starting value from your data. The database query failed. You can still type one in yourself, or save and we'll measure it then.",
    }
  }
}
