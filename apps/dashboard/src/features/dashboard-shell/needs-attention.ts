import type { AlertListItem } from '@/features/dashboard-shell/tiles/alert-list'

export interface NeedsAttentionCounts {
  mismatchedCount: number
  backfillModelCount: number
  backfillTotalEvents: number
}

// GetMismatchedSignalCount counts signals booked
// to the WRONG ACCOUNT TYPE (chart-of-accounts.ts), not unmapped
// ones, so the label says exactly that. Same phrasing as the FinOps close
// derivation's alert item.
export function mismatchedSignalsItem(mismatchedCount: number): AlertListItem {
  return {
    severity: 'amber',
    text: `${mismatchedCount.toLocaleString()} signal${mismatchedCount === 1 ? '' : 's'} booked to the wrong account type`,
    href: '/finops?tab=settings',
  }
}

// Every surface leads with the ACTIONABLE count (models = table
// rows on the needs-attention page; fixing one fixes all its events), with
// events as the impact parenthetical.
export function costBackfillItem(
  backfillModelCount: number,
  backfillTotalEvents: number
): AlertListItem {
  return {
    severity: 'amber',
    text: `${backfillModelCount.toLocaleString()} model${backfillModelCount === 1 ? ' needs' : 's need'} cost backfill (${backfillTotalEvents.toLocaleString()} event${backfillTotalEvents === 1 ? '' : 's'})`,
    href: '/metrics-events/needs-attention',
  }
}

// The missing-volume queue sits beside backfill as "events whose cost is
// incomplete". Default href = the volume fix loop, consistent with its
// siblings; MF IQ overrides to /build at its call site. NOT composed into
// composeNeedsAttention, whose output a test pins byte for byte.
export function missingVolumeItem(
  missingVolumeModelCount: number,
  missingVolumeEvents: number
): AlertListItem {
  return {
    severity: 'amber',
    text: `${missingVolumeModelCount.toLocaleString()} model${missingVolumeModelCount === 1 ? ' is' : 's are'} missing volume data (${missingVolumeEvents.toLocaleString()} event${missingVolumeEvents === 1 ? '' : 's'})`,
    href: '/metrics-events/needs-attention',
  }
}

// Credit pools at or near zero. Amber, not red: a drained pool
// blocks nothing, so a red row would wrongly say something broke. NOT
// composed into composeNeedsAttention, whose output a test pins byte for
// byte.
//
// Alone among the four, this default carries ?tab=: the bare page href
// opens the first tab WITH ROWS, which is cost
// backfill whenever backfill is non-empty. Contract belongs on the item so
// every surface rendering it (Money, MF IQ) lands on the same tab.
export function creditPoolItem(lowPoolCount: number): AlertListItem {
  return {
    severity: 'amber',
    text: `${lowPoolCount.toLocaleString()} credit pool${lowPoolCount === 1 ? ' is' : 's are'} running low`,
    href: '/metrics-events/needs-attention?tab=credit-pools',
  }
}

/**
 * Overview's needs-attention list, composed from two real counts
 * (chart-of-accounts.ts#getMismatchedSignalCount,
 * signal-events.ts#getNeedsCostBackfillGroups). Rows that would need data
 * this code does not compute (margin-floor breach, cost spike, savings
 * estimate) are never fabricated.
 *
 * The item builders above are exported separately so Build can render the
 * backfill item ALONE while Money/Overview
 * keep composing both — one text/href home per item, no copy forks.
 */
export function composeNeedsAttention({
  mismatchedCount,
  backfillModelCount,
  backfillTotalEvents,
}: NeedsAttentionCounts): AlertListItem[] {
  const items: AlertListItem[] = []

  if (mismatchedCount > 0) {
    items.push(mismatchedSignalsItem(mismatchedCount))
  }

  if (backfillModelCount > 0) {
    items.push(costBackfillItem(backfillModelCount, backfillTotalEvents))
  }

  return items
}
