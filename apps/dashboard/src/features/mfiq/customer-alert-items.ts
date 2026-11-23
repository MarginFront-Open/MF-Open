/**
 * WHAT THIS FILE DOES: turns customer-alert notification rows into the
 * pre-composed AlertList items the MFiQ "Customer alerts" card renders —
 * severity, copy, deep link, and timestamp all decided HERE, never in
 * index.tsx (the page-composition guard bans hrefs and severity literals
 * there, and this module is node-jest testable while .tsx is not).
 * CONNECTS TO: app/actions/customer-alert-notifications.ts (the rows),
 * index.tsx (the card), dashboard-shell/tiles/alert-list.tsx (the renderer).
 */

import type { AlertListItem } from '@/features/dashboard-shell/tiles/alert-list'
import { formatCost } from '@/lib/canon-format'
import type { CustomerAlertNotificationView } from '@/app/actions/customer-alert-notifications'

/** The dashboard period selector's own labels, matching the email copy. */
const WINDOW_LABELS: Record<string, string> = {
  month: 'This month',
  rolling: 'Last 30 days',
  custom: 'Custom range',
}

function windowLabel(windowMode: string): string {
  return WINDOW_LABELS[windowMode] ?? windowMode
}

/** "Aug 26" — compact fire stamp for the row's right edge, UTC like the window math. */
function fireStamp(firedAtIso: string): string {
  const d = new Date(firedAtIso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * One row per fire, newest first (the action already orders them). Red on
 * purpose: a fired watch is the user's own tripwire going off, the exact
 * urgency the red badge on the sidebar promises. Deep link = the internal
 * customer UUID (never externalId — the route param the customer page
 * resolves). A hard-deleted customer degrades to a generic label; the ledger
 * row is still real money history.
 */
export function buildCustomerAlertItems(
  rows: CustomerAlertNotificationView[]
): AlertListItem[] {
  return rows.map((row) => ({
    severity: 'red' as const,
    text: `${row.customerName ?? 'A deleted customer'} passed ${formatCost(
      row.thresholdUsd
    )} ${row.metric} (${windowLabel(row.windowMode)}): ${formatCost(row.valueUsd)}`,
    href: `/customers/${row.customerId}`,
    timestamp: fireStamp(row.firedAt),
  }))
}
