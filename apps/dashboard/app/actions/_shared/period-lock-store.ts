/**
 * WHAT THIS FILE DOES: the read side of the month-end "period lock".
 * When a billing period is CLOSED, its posted numbers are frozen into
 * the `finance_period_locks` table. This module answers one question for the
 * finance read path: "is THIS exact window a closed period, and if so, what are
 * its frozen numbers?" — so the journal export / audit trail / cost breakdown /
 * defensibility score can serve the snapshot instead of recomputing from live
 * signal state (which would let a reclassification silently rewrite a posted
 * journal).
 *
 * WHY IT'S A SEPARATE LEAF MODULE: it breaks the data-action ↔ lock-action
 * import cycle — see the inline block at the `import { db }` line below for the
 * full rationale (kept next to the code it constrains so it can't drift).
 *
 * CONNECTS TO: finance-period-lock.ts (the lock/unlock/status actions that
 * WRITE these rows), journal-export.ts + cost-command-center.ts +
 * finance-metrics.ts (the four read paths that call findLockedPeriod), and
 * @/app/lib/db (the Prisma client — reads only here).
 */

import { db } from '@/app/lib/db'

// DELIBERATELY this module references NONE of the four data modules
// (journal-export / cost-command-center / finance-metrics) — not even for
// types. Any reference (top-level `import type` OR inline `import(...).Type`)
// is treated by the bundler as a real module edge, which closes a cycle
// (journal-export → period-lock-store → …data module… → journal-export) that
// resolves journal-export to an empty module at build time. So the snapshot
// payloads are typed `unknown` here, and each read-path guard casts the payload
// to its own locally-defined return type (which it already has in scope). The
// only thing this module imports at runtime is the Prisma client.

/**
 * Snapshot format version. Bump this whenever the SHAPE of any frozen payload
 * changes in a way an old snapshot can't satisfy. A row whose stored version
 * doesn't match is treated as "no usable snapshot" and the read path falls back
 * to a live recompute — a frozen number going slightly stale is far better than
 * a closed period throwing on a snapshot shape it can't read.
 */
// Version 3 payloads carry productLineMargins, so the "Margin by product line"
// panel on a closed page freezes too, with `earned` per row and `totalEarned`
// on its summary. A lower-version snapshot can pass the shape gate without
// totalEarned and would render `$NaN earned`, so the version gate sends it to
// a live recompute instead.
export const PERIOD_SNAPSHOT_VERSION = 3

/**
 * Everything the Month-End Close view + the three CSV exports render for a
 * period, frozen at close time. We snapshot the OUTPUT (not the inputs) on
 * purpose: the posted artifact is exactly what the accountant saw, not a
 * re-derivation that could drift.
 */
export type PeriodSnapshot = {
  version: number
  /** JournalExport — cast at the getJournalExport guard. */
  journal: unknown
  /** JournalAuditDetail — cast at the getJournalAuditDetail guard. */
  audit: unknown
  /** CostClassificationBreakdown — cast at the getCostClassificationBreakdown guard. */
  breakdown: unknown
  /** DefensibilityScore — cast at the getDefensibilityScore guard. */
  score: unknown
  /** ProductLineMarginSummary — cast at the getProductLineMargins guard. */
  productLineMargins: unknown
}

/** A closed period: its frozen numbers plus who/when it was closed. */
export type LockedPeriod = {
  lockedAt: string
  lockedByUserId: string | null
  periodLabel: string
  snapshot: PeriodSnapshot
}

/**
 * Can this period be closed? Only a period that has fully ELAPSED can be
 * closed — you can't close a month that isn't over. This also dodges a real
 * technical trap: parseWindowFilter caps a window's end at `now`, so the
 * current month's window keeps moving and a stored lock could never match it.
 *
 * `endDate` is the UI's "yyyy-mm-dd" end-of-period date. We compare its
 * end-of-day UTC against `nowMs`; a future end-of-day means the period is still
 * open. Pure + deterministic so it can be unit-tested without a clock.
 */
export function isPeriodClosable(endDate: string, nowMs: number): boolean {
  const endOfDayUtc = new Date(`${endDate}T23:59:59.999Z`).getTime()
  if (Number.isNaN(endOfDayUtc)) return false
  return endOfDayUtc < nowMs
}

/** Exact-equality window match (ms). The lock guard never matches "close" windows. */
export function windowsMatch(
  lockStart: Date,
  lockEnd: Date,
  windowStart: Date,
  windowEnd: Date
): boolean {
  return (
    lockStart.getTime() === windowStart.getTime() &&
    lockEnd.getTime() === windowEnd.getTime()
  )
}

/**
 * Validate + narrow a stored snapshot JSON blob into a PeriodSnapshot. Returns
 * null on a version mismatch or a shape that's missing any of the five frozen
 * payloads — both cases mean "no usable snapshot", and the caller degrades to a
 * live recompute rather than rendering a half-frozen close.
 */
export function parseSnapshot(
  raw: unknown,
  storedVersion: number
): PeriodSnapshot | null {
  if (storedVersion !== PERIOD_SNAPSHOT_VERSION) return null
  if (!raw || typeof raw !== 'object') return null
  const snap = raw as Partial<PeriodSnapshot>
  if (
    snap.version !== PERIOD_SNAPSHOT_VERSION ||
    !snap.journal ||
    !snap.audit ||
    !snap.breakdown ||
    !snap.score ||
    !snap.productLineMargins
  ) {
    return null
  }
  return snap as PeriodSnapshot
}

/**
 * Find the frozen snapshot for an EXACT period window in one org, or null when
 * the period isn't closed. Org-scoped by construction (the unique key leads
 * with orgId, and we filter on it) — a leaked period window from another org
 * can't widen the result.
 *
 * Safe-degrades to null (→ live recompute upstream) on a parse/version failure
 * so a closed period can never crash the page because its snapshot no longer
 * matches the current shape.
 */
export async function findLockedPeriod(
  orgId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<LockedPeriod | null> {
  const lock = await db.finance_period_locks.findUnique({
    where: {
      orgId_periodStart_periodEnd: {
        orgId,
        periodStart: windowStart,
        periodEnd: windowEnd,
      },
    },
  })
  if (!lock) return null

  const snapshot = parseSnapshot(lock.snapshot, lock.snapshotVersion)
  if (!snapshot) return null

  return {
    lockedAt: lock.lockedAt.toISOString(),
    lockedByUserId: lock.lockedByUserId ?? null,
    periodLabel: lock.periodLabel,
    snapshot,
  }
}
