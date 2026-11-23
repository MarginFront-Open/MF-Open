'use server'

/**
 * WHAT THIS FILE DOES: closing (and reopening) a month-end billing period,
 * the write side of the period lock ("the close must close").
 *
 * When a finance person CLOSES a period, we compute that period's numbers ONE
 * last time and freeze them into `finance_period_locks`. From then on the read
 * path (getJournalExport / getJournalAuditDetail / getCostClassificationBreakdown
 * / getDefensibilityScore) serves that frozen snapshot for the period, so later
 * reclassifying a signal (or remapping its GL code) can't silently rewrite a
 * journal CSV that was already posted to the ledger. Reopening
 * deletes the snapshot and returns the period to a live recompute.
 *
 * WHY IT EXISTS: without it every finance number would stay mutable after the
 * fact, and a closed P&L would silently change the moment anyone reclassified a
 * signal. This is the durable lock that makes a posted close final.
 *
 * SECURITY POSTURE: lockPeriod and unlockPeriod ENFORCE a server-side role gate.
 * Only finance, admin, or owner may close or reopen a period, checked against the
 * caller's org membership (ba_member on session.session.activeOrganizationId).
 * Hiding the buttons in the UI is not enough, because a
 * member can POST the action directly. Both paths also write an append-only audit
 * row to finance_period_lock_events (actor + timestamp, 'closed' / 'reopened'), the
 * durable segregation-of-duties record, and the ONLY place a reopen is recorded
 * since unlockPeriod deletes the lock row. NOTE: this is the finance role's only
 * server-side WRITE power; it is otherwise view-only (see src/lib/permissions.ts),
 * and the gate uses an inline allowed-role array, not an isFinance() helper, which
 * permissions.ts deliberately forbids.
 *
 * CONNECTS TO: _shared/period-lock-store.ts (the read + pure helpers), the data
 * actions lockPeriod loads to build the snapshot, and
 * features/month-end-close/index.tsx (the Close / Reopen UI).
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
import { parseWindowFilter } from './_shared/parse-window-filter'
import {
  PERIOD_SNAPSHOT_VERSION,
  isPeriodClosable,
  type PeriodSnapshot,
} from './_shared/period-lock-store'
// The data actions are pulled in DYNAMICALLY inside lockPeriod (the only
// place they're used), not statically. A static fan-out from this 'use server'
// module to those client-imported server-action modules forms a server-action
// graph cycle that the bundler resolves to an empty module; deferring the edge
// to call-time breaks it. Module imports are cached, so the cost is one-time.

export type PeriodLockStatus = {
  /** True when this exact period window is closed/locked. */
  locked: boolean
  /** ISO timestamp the period was closed, or null when open. */
  lockedAt: string | null
  /** User id who closed it, or null. */
  lockedByUserId: string | null
  /** Display name of who closed it (best-effort), or null. */
  lockedByName: string | null
  /** Stored period label, e.g. "May 2026", or null when open. */
  periodLabel: string | null
  /**
   * Whether this period is even eligible to be closed (it has fully elapsed).
   * The current/in-progress month is never closable — you can't close a month
   * that isn't over, and its window keeps moving so a lock couldn't match it.
   */
  closable: boolean
}

/**
 * Read the close status for a single period window (for the badge + button
 * state on Month-End Close). Org-scoped; never returns another org's lock.
 */
export async function getPeriodLockStatus(params: {
  startDate: string
  endDate: string
}): Promise<PeriodLockStatus> {
  const closable = isPeriodClosable(params.endDate, Date.now())
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return {
      locked: false,
      lockedAt: null,
      lockedByUserId: null,
      lockedByName: null,
      periodLabel: null,
      closable,
    }
  }
  const orgId = session.session.activeOrganizationId
  const { windowStart, windowEnd } = parseWindowFilter(params)

  const lock = await db.finance_period_locks.findUnique({
    where: {
      orgId_periodStart_periodEnd: {
        orgId,
        periodStart: windowStart,
        periodEnd: windowEnd,
      },
    },
    select: {
      lockedAt: true,
      lockedByUserId: true,
      periodLabel: true,
    },
  })

  if (!lock) {
    return {
      locked: false,
      lockedAt: null,
      lockedByUserId: null,
      lockedByName: null,
      periodLabel: null,
      closable,
    }
  }

  // Best-effort name for the badge. Org-scoped: only resolve a name for a user
  // who is a member of this org, so a stale/foreign user id can't leak a name.
  let lockedByName: string | null = null
  if (lock.lockedByUserId) {
    const member = await db.ba_member.findFirst({
      where: { organizationId: orgId, userId: lock.lockedByUserId },
      select: { users: { select: { name: true } } },
    })
    lockedByName =
      (member as { users?: { name?: string } } | null)?.users?.name ?? null
  }

  return {
    locked: true,
    lockedAt: lock.lockedAt.toISOString(),
    lockedByUserId: lock.lockedByUserId ?? null,
    lockedByName,
    periodLabel: lock.periodLabel,
    closable,
  }
}

/**
 * Close a billing period: snapshot its current numbers and lock them. Refuses
 * an in-progress month (server-side defense in depth — the UI also disables the
 * button) and refuses a double-close.
 */
export async function lockPeriod(params: {
  startDate: string
  endDate: string
  periodLabel: string
}): Promise<{ success: boolean; error?: string }> {
  const { startDate, endDate, periodLabel } = params
  if (!startDate || !endDate) {
    return { success: false, error: 'Missing period dates' }
  }

  // You can only close a period that has fully ended.
  if (!isPeriodClosable(endDate, Date.now())) {
    return {
      success: false,
      error: 'This period has not ended yet. You can close it after the month is over.',
    }
  }

  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return { success: false, error: 'Not authenticated' }
  }

  // Server-side role gate. Closing the books is a finance control
  // (SOX segregation of duties), so only finance, admin, or owner may do it. The
  // UI already hides the button from a plain member (nav-visibility), but a
  // member could POST this action directly. Mirrors the idiom in
  // set-dashboard-mode.ts.
  const orgId = session.session.activeOrganizationId
  const userId = session.user?.id ?? null
  const membership = await db.ba_member.findFirst({
    where: { organizationId: orgId, userId },
    select: { role: true },
  })
  if (!membership || !['owner', 'admin', 'finance'].includes(membership.role)) {
    return {
      success: false,
      error: 'Only finance, admin, or owner roles can close or reopen a period.',
    }
  }

  const { windowStart, windowEnd } = parseWindowFilter(params)

  // Already closed? Bail cleanly before the expensive recompute.
  const existing = await db.finance_period_locks.findUnique({
    where: {
      orgId_periodStart_periodEnd: {
        orgId,
        periodStart: windowStart,
        periodEnd: windowEnd,
      },
    },
    select: { id: true },
  })
  if (existing) {
    return { success: false, error: 'This period is already closed.' }
  }

  // Compute every number the close view + the three CSVs render, ONE last time.
  // No lock exists yet, so each of these resolves live (the read-path guard is a
  // no-op until this row lands). The filter shape matches what the page passes,
  // so parseWindowFilter resolves the identical window we store below. Imported
  // dynamically (see the import note above) to avoid a server-action cycle.
  const filter = { startDate, endDate }
  const [journalMod, costMod, metricsMod] = await Promise.all([
    import('./journal-export'),
    import('./cost-command-center'),
    import('./finance-metrics'),
  ])
  const [journal, audit, breakdown, score, productLineMargins] =
    await Promise.all([
      journalMod.getJournalExport(filter),
      journalMod.getJournalAuditDetail(filter),
      costMod.getCostClassificationBreakdown(filter),
      metricsMod.getDefensibilityScore(filter),
      // productLineMargins: the "Margin by product line" panel
      // is on the close page too, so it must freeze with the rest of the close.
      metricsMod.getProductLineMargins(filter),
    ])

  // Freeze ONLY if all five payloads came back. Each is included here so the
  // write guard matches parseSnapshot's read check (which rejects a snapshot
  // missing any of the five) — otherwise a freeze with a null payload would
  // "succeed" yet silently fall back to a live recompute on every later read.
  // breakdown/productLineMargins are typed non-nullable, but the guard still
  // checks them to stay in lockstep with parseSnapshot. A null here means the
  // session/org was lost mid-flight — don't freeze a half-empty close.
  if (!journal || !audit || !breakdown || !score || !productLineMargins) {
    return {
      success: false,
      error: 'Could not read the period numbers. Reload and try again.',
    }
  }

  const snapshot: PeriodSnapshot = {
    version: PERIOD_SNAPSHOT_VERSION,
    journal,
    audit,
    breakdown,
    score,
    productLineMargins,
  }

  try {
    await db.finance_period_locks.create({
      data: {
        orgId,
        periodStart: windowStart,
        periodEnd: windowEnd,
        periodLabel,
        snapshot: snapshot as unknown as object,
        snapshotVersion: PERIOD_SNAPSHOT_VERSION,
        lockedByUserId: userId,
      } as never,
    })
  } catch (err) {
    // Unique-constraint race: someone closed the same period between our check
    // and our write. Treat as already-closed, not a crash.
    if ((err as { code?: string })?.code === 'P2002') {
      return { success: false, error: 'This period is already closed.' }
    }
    throw err
  }

  // Append-only audit row for the close. The lock row above already
  // carries who/when (lockedByUserId/lockedAt), so this is the symmetric mirror
  // that lets the close AND the reopen live in one queryable history. Scoped to
  // the same orgId as the lock write. It's best-effort ON PURPOSE:
  // the close is already durable and attributed on the lock row, so a hiccup
  // writing this mirror must NOT fail an otherwise-successful close (that would
  // toast "couldn't close" for a period that IS closed). The reopen path is the
  // opposite — there the event row is the ONLY record, so it is NOT best-effort
  // (see unlockPeriod).
  try {
    await db.finance_period_lock_events.create({
      data: {
        orgId,
        periodStart: windowStart,
        periodEnd: windowEnd,
        periodLabel,
        action: 'closed',
        actorUserId: userId,
      },
    })
  } catch (auditErr) {
    console.error('[lockPeriod] close audit-log write failed:', auditErr)
  }

  revalidatePath('/month-end-close')
  return { success: true }
}

/**
 * Reopen a closed period: delete its snapshot so the numbers go back to a live
 * recompute. deleteMany (not delete) so reopening an already-open period is a
 * harmless no-op rather than a throw.
 */
export async function unlockPeriod(params: {
  startDate: string
  endDate: string
}): Promise<{ success: boolean; error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return { success: false, error: 'Not authenticated' }
  }

  // Same server-side role gate as lockPeriod — reopening is the more
  // sensitive half of the control (it can silently undo a posted close), so it
  // gets the same finance/admin/owner gate.
  const orgId = session.session.activeOrganizationId
  const userId = session.user?.id ?? null
  const membership = await db.ba_member.findFirst({
    where: { organizationId: orgId, userId },
    select: { role: true },
  })
  if (!membership || !['owner', 'admin', 'finance'].includes(membership.role)) {
    return {
      success: false,
      error: 'Only finance, admin, or owner roles can close or reopen a period.',
    }
  }

  const { windowStart, windowEnd } = parseWindowFilter(params)

  // Find the lock we're about to delete. No lock → reopening is a harmless
  // no-op (reopen stays idempotent) and there's nothing to
  // record. We also read its periodLabel so the audit row carries the same label
  // the close did.
  const existing = await db.finance_period_locks.findUnique({
    where: {
      orgId_periodStart_periodEnd: {
        orgId,
        periodStart: windowStart,
        periodEnd: windowEnd,
      },
    },
    select: { periodLabel: true },
  })

  if (existing) {
    // Write the reopen audit row BEFORE deleting the lock. Once the
    // lock row is gone there is NO other trace of the reopen — so unlike the
    // close mirror, this write is NOT best-effort. Writing it first means a
    // failed audit insert throws before the delete runs (fail-closed): a reopen
    // we can't record is a reopen we don't perform.
    await db.finance_period_lock_events.create({
      data: {
        orgId,
        periodStart: windowStart,
        periodEnd: windowEnd,
        periodLabel: existing.periodLabel,
        action: 'reopened',
        actorUserId: userId,
      },
    })

    await db.finance_period_locks.deleteMany({
      where: { orgId, periodStart: windowStart, periodEnd: windowEnd },
    })
  }

  revalidatePath('/month-end-close')
  return { success: true }
}
