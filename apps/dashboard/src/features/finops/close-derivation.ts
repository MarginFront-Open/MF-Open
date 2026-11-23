/**
 * Pure derivation of the FinOps close status.
 * Framework-free and node-testable: takes CloseStatusFacts (the composed
 * close-engine reads) plus `now`, returns everything the page renders —
 * checklist steps, close-tile values + subtexts, the PageShell subtitle, and
 * the alert items. NO fetching, NO money math beyond canon-format display
 * strings, null (undefined-for-window renders "—", never 0).
 */

import { formatCost } from '@/lib/canon-format'
import type { CloseStatusFacts } from '@/app/actions/finops-close-status'
import type { ChecklistItem } from '@/features/dashboard-shell/tiles/checklist'
import type { AlertListItem } from '@/features/dashboard-shell/tiles/alert-list'

/**
 * Close deadline = this many calendar days after month end. A MarginFront
 * CONVENTION, not schema truth — no close-deadline concept exists anywhere
 * in the data model. Replace it with an org setting if you add one. The daysToClose tooltip names the convention to the user.
 */
export const CLOSE_WINDOW_DAYS = 5

const CLOSE_STEP_COUNT = 5
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** The four close-backed kpi-tile values (CLOSE_TILE_METRICS keys — the
 * registry's `satisfies` in component-catalog.ts checks against this shape). */
export interface CloseTileValues {
  closeProgress: number | null
  unmappedCount: number | null
  categorizedPct: number | null
  daysToClose: number | null
}

export interface DerivedCloseStatus {
  steps: ChecklistItem[]
  doneCount: number
  tiles: CloseTileValues
  subtexts: Record<keyof CloseTileValues, string>
  subtitle: string
  alerts: AlertListItem[]
}

/** Start of the deadline day (UTC): the CLOSE_WINDOW_DAYS-th calendar day
 * after the month ends. periodEnd is the month's last instant
 * (…-30T23:59:59.999Z), so flooring after the add lands on day 5, 00:00.
 * Exported so MF IQ's close-deadline rule shares this ONE deadline
 * arithmetic instead of forking the convention. */
export function closeDeadline(periodEndIso: string): number {
  const periodEnd = new Date(periodEndIso).getTime()
  return (
    Math.floor((periodEnd + CLOSE_WINDOW_DAYS * MS_PER_DAY) / MS_PER_DAY) *
    MS_PER_DAY
  )
}

export function deriveCloseStatus(
  facts: CloseStatusFacts,
  now: Date
): DerivedCloseStatus {
  const stepConditions: Array<{
    label: string
    done: boolean
    detail?: string
  }> = [
    {
      label: 'Record usage events',
      done: facts.eventCount > 0,
      detail:
        facts.eventCount > 0
          ? `${facts.eventCount.toLocaleString()} events`
          : 'No usage yet',
    },
    {
      label: 'Map costs to GL codes',
      done: facts.unmappedAmount === 0,
      detail:
        facts.unmappedAmount === 0
          ? undefined
          : facts.unmappedSignalCount !== null
            ? `${facts.unmappedSignalCount} left`
            : `${formatCost(facts.unmappedAmount)} left`,
    },
    {
      label: 'Categorize COGS / R&D',
      done: facts.unclassifiedCost === 0,
      detail:
        facts.unclassifiedCost === 0
          ? undefined
          : `${formatCost(facts.unclassifiedCost)} left`,
    },
    {
      label: 'Fix account-type mismatches',
      done: facts.mismatchedSignalCount === 0,
      detail:
        facts.mismatchedSignalCount === 0
          ? undefined
          : `${facts.mismatchedSignalCount} to review`,
    },
    {
      label: 'Sign off month',
      done: facts.lock.locked,
      detail: facts.lock.locked
        ? undefined
        : facts.lock.closable
          ? 'Ready to close'
          : 'Month still open',
    },
  ]

  // Status rule: a met condition is 'done' wherever
  // it sits; the FIRST not-done step is 'active'; every later not-done is 'todo'.
  let activeAssigned = false
  const steps: ChecklistItem[] = stepConditions.map((step) => {
    if (step.done) {
      return { label: step.label, status: 'done', detail: step.detail }
    }
    const status = activeAssigned ? 'todo' : 'active'
    activeAssigned = true
    return { label: step.label, status, detail: step.detail }
  })

  const doneCount = stepConditions.filter((step) => step.done).length

  const deadline = closeDeadline(facts.journal.periodEnd)
  const inCloseWindow =
    facts.lock.closable &&
    !facts.lock.locked &&
    now.getTime() > new Date(facts.journal.periodEnd).getTime() &&
    now.getTime() < deadline + MS_PER_DAY
  const daysToClose =
    facts.lock.closable && !facts.lock.locked
      ? Math.max(0, Math.ceil((deadline - now.getTime()) / MS_PER_DAY))
      : null

  const tiles: CloseTileValues = {
    closeProgress: (doneCount / CLOSE_STEP_COUNT) * 100,
    unmappedCount: facts.unmappedSignalCount,
    categorizedPct:
      facts.classifiedShare === null ? null : facts.classifiedShare * 100,
    daysToClose,
  }

  const subtexts: DerivedCloseStatus['subtexts'] = {
    closeProgress: `${doneCount} of ${CLOSE_STEP_COUNT} steps done`,
    unmappedCount: 'signals need a GL code',
    categorizedPct: `of ${facts.monthLabel} AI cost`,
    daysToClose: 'until the close deadline',
  }

  const subtitle = facts.lock.locked
    ? `${facts.monthLabel} · closed`
    : inCloseWindow
      ? `${facts.monthLabel} · day ${now.getUTCDate()} of close`
      : `${facts.monthLabel} · ${doneCount} of ${CLOSE_STEP_COUNT} steps done`

  const alerts: AlertListItem[] =
    facts.mismatchedSignalCount > 0
      ? [
          {
            severity: 'amber',
            text: `${facts.mismatchedSignalCount} signal${
              facts.mismatchedSignalCount === 1 ? '' : 's'
            } booked to the wrong account type`,
            href: '/finops?tab=settings',
          },
        ]
      : []

  return { steps, doneCount, tiles, subtexts, subtitle, alerts }
}
