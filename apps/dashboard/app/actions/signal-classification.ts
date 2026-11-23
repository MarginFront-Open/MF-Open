'use server'

/**
 * Signal Classification Server Actions.
 *
 * Used by the Cost Management dashboard's COGS/R&D classification table to
 * list signals with their current accounting bucket and to mutate that
 * bucket via inline edits. Mirrors the API surface
 * `PATCH /v1/signals/:id/classification` (signals.controller.ts) but routes
 * through Prisma directly because dashboard server actions speak to the
 * canonical DB without a network hop.
 *
 * Every mutation logs a `signal_classification_overrides` row capturing
 * what was suggested vs. chosen.
 * SDK auto-classifications are NOT logged here (they go through
 * sdk.service.recordUsage); the audit log is for user-initiated overrides.
 *
 * Auth + window scope follow the same pattern as cost-command-center.ts:
 * org from the active session before any read or write.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Classifying a signal moves its cost onto a P&L bucket, so it's a
// money write — only owner/admin/finance may reclassify.
import { assertMoneyManager } from './_shared/assert-money-manager'
import type { CostCategoryKey } from '@/features/cost-management/classification-utils'

export type { CostCategoryKey } from '@/features/cost-management/classification-utils'

const COST_CATEGORY_KEYS: CostCategoryKey[] = [
  'PRODUCTION_COGS',
  'DEVELOPMENT_RD',
  'SALES_SM',
  'GENERAL_GA',
  'INTERNAL_TOOL',
  'UNCLASSIFIED',
]

type OverrideSource = 'inline_dropdown' | 'bulk_suggest_button' | 'api_patch'

export type SignalClassificationRow = {
  id: string
  name: string
  shortName: string | null
  agentId: string
  agentName: string
  costCategory: CostCategoryKey
  /** Whether the classification was auto-set by an environment-tagged event
   *  (signal still in the default UNCLASSIFIED state means the operator
   *  hasn't seen it yet — drives the onboarding nudge). */
  isUnclassified: boolean
  /** GL code this signal is mapped to (`signals.glCodeId`). Null when the
   *  signal hasn't been mapped to a chart-of-accounts entry yet — drives
   *  the "needs GL code" indicator on the row. */
  glCodeId: string | null
  /** Display string ("5100 — AI Inference") for the table cell. Null when
   *  no GL code is mapped. */
  glCodeDisplay: string | null
}

/**
 * List every signal in the active org with its current classification.
 * Pulled in one query (signals + agents join) and shaped for the table.
 * Soft-deleted signals are excluded.
 */
export async function getSignalsForClassification(): Promise<
  SignalClassificationRow[]
> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return []
  const orgId = session.session.activeOrganizationId

  const signals = await db.signals.findMany({
    where: { orgId, deletedAt: null },
    include: {
      agents: { select: { id: true, name: true } },
      chart_of_accounts: { select: { id: true, glCode: true, glName: true } },
    },
    orderBy: [{ name: 'asc' }],
  })

  return signals.map((s) => {
    // The chart-of-accounts include is missing on a Prisma client generated
    // without it, so tolerate both shapes.
    const gl = (
      s as unknown as {
        chart_of_accounts?: {
          id: string
          glCode: string
          glName: string
        } | null
      }
    ).chart_of_accounts
    return {
      id: s.id,
      name: s.name,
      shortName: s.shortName,
      agentId: s.agentId,
      agentName: s.agents?.name ?? 'Unknown agent',
      costCategory: ((s as { costCategory?: string }).costCategory ??
        'UNCLASSIFIED') as CostCategoryKey,
      isUnclassified:
        ((s as { costCategory?: string }).costCategory ?? 'UNCLASSIFIED') ===
        'UNCLASSIFIED',
      glCodeId: gl?.id ?? null,
      glCodeDisplay: gl ? `${gl.glCode}: ${gl.glName}` : null,
    }
  })
}

/**
 * Set a single signal's costCategory. Server-action variant of the API's
 * `PATCH /v1/signals/:id/classification`. Once set to anything other than
 * UNCLASSIFIED, the SDK ingest auto-classifier (sdk.service.recordUsage)
 * respects the operator's choice and stops overwriting.
 *
 * Optional `suggestedCategory` records what the dashboard had pre-filled
 * (e.g., from a rule suggestion) in the override log. Optional `source` lets
 * the API path emit `api_patch` instead of the default `inline_dropdown`.
 */
export async function classifySignal(
  signalId: string,
  costCategory: CostCategoryKey,
  options?: {
    suggestedCategory?: CostCategoryKey | null
    source?: OverrideSource
  }
): Promise<{ success: boolean; error?: string }> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId
  const userId = gate.userId

  if (!COST_CATEGORY_KEYS.includes(costCategory)) {
    return { success: false, error: `Invalid costCategory: ${costCategory}` }
  }

  // findFirst ensures the signal belongs to the active org before we mutate.
  const signal = await db.signals.findFirst({
    where: { id: signalId, orgId, deletedAt: null },
    select: { id: true, name: true, agentId: true },
  })
  if (!signal) {
    return { success: false, error: 'Signal not found' }
  }

  await db.$transaction([
    db.signals.update({
      where: { id: signalId },
      data: { costCategory, updatedAt: new Date() } as never,
    }),
    db.signal_classification_overrides.create({
      data: {
        orgId,
        signalId: signal.id,
        signalNameSnapshot: signal.name,
        agentIdSnapshot: signal.agentId,
        suggestedCategory: options?.suggestedCategory ?? null,
        chosenCategory: costCategory,
        userId,
        source: options?.source ?? 'inline_dropdown',
      },
    }),
  ])

  revalidatePath('/cost-management')
  return { success: true }
}

/**
 * Bulk classification for the onboarding flow — set every UNCLASSIFIED
 * signal in the org to the suggested bucket in one transaction. Each
 * assignment can optionally include `suggestedCategory` (what the dashboard
 * computed via rule evaluation) so the override log captures the full
 * suggestion-vs-choice pair.
 */
export async function bulkClassifyUnclassifiedSignals(
  assignments: Array<{
    id: string
    costCategory: CostCategoryKey
    suggestedCategory?: CostCategoryKey | null
  }>
): Promise<{ success: boolean; updated: number; error?: string }> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, updated: 0, error: gate.error }
  const orgId = gate.orgId
  const userId = gate.userId

  for (const a of assignments) {
    if (!COST_CATEGORY_KEYS.includes(a.costCategory)) {
      return {
        success: false,
        updated: 0,
        error: `Invalid costCategory in assignments: ${a.costCategory}`,
      }
    }
  }

  // Confirm every id belongs to this org before any write — one extra
  // round-trip but prevents cross-org mutations if a stale id leaks in.
  // We also pull name + agentId for the override log snapshots.
  const ids = assignments.map((a) => a.id)
  const owned = await db.signals.findMany({
    where: { id: { in: ids }, orgId, deletedAt: null },
    select: { id: true, name: true, agentId: true },
  })
  const ownedMap = new Map(owned.map((s) => [s.id, s]))
  const valid = assignments.filter((a) => ownedMap.has(a.id))

  await db.$transaction([
    ...valid.map((a) =>
      db.signals.update({
        where: { id: a.id },
        data: { costCategory: a.costCategory, updatedAt: new Date() } as never,
      })
    ),
    db.signal_classification_overrides.createMany({
      data: valid.map((a) => {
        const owned = ownedMap.get(a.id)!
        return {
          orgId,
          signalId: a.id,
          signalNameSnapshot: owned.name,
          agentIdSnapshot: owned.agentId,
          suggestedCategory: a.suggestedCategory ?? a.costCategory,
          chosenCategory: a.costCategory,
          userId,
          source: 'bulk_suggest_button' as const,
        }
      }),
    }),
  ])

  revalidatePath('/cost-management')
  return { success: true, updated: valid.length }
}
