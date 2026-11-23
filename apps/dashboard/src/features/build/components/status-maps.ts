/**
 * Pure, node-testable view maps for the
 * Build page's status pills and event chips. The event map is a TOTAL
 * Record over eventProcessed so a new status is a compile error here, and
 * the labels are honest: there is no "Billed" event status (billing
 * state lives on invoices, not events), so the map uses the real
 * five-status enum.
 */

import type { SignalEvent } from '@/app/actions/signal-events'

export type EventProcessedStatus = SignalEvent['eventProcessed']

export interface StatusChip {
  label: string
  className: string
}

export const EVENT_STATUS_CHIPS: Record<EventProcessedStatus, StatusChip> = {
  PROCESSED: { label: 'Processed', className: 'bg-mf-card2 text-mf-green' },
  NEEDS_COST_BACKFILL: {
    label: 'Needs cost backfill',
    className: 'bg-mf-card2 text-mf-amber',
  },
  MISSING_VOLUME_DATA: {
    label: 'Missing volume',
    className: 'bg-mf-card2 text-mf-amber',
  },
  PENDING: { label: 'Pending', className: 'bg-mf-card2 text-mf-tx2' },
  ERROR: { label: 'Error', className: 'bg-mf-card2 text-mf-red' },
}

/**
 * Agents-table status pill. null = the deleted-agents catch-all
 * row, which carries no status — render nothing, not a fabricated state.
 * "Paused" is a label, not a behavior: isActive gates nothing in ingest or
 * billing, and the pause dialog copy says so.
 */
export function agentStatusPill(isActive: boolean | null): StatusChip | null {
  if (isActive === null) return null
  return isActive
    ? { label: 'Active', className: 'bg-mf-card2 text-mf-green' }
    : { label: 'Paused', className: 'bg-mf-card2 text-mf-tx2' }
}

/**
 * Event-stream Model cell: the PARENT event is the honest unit
 * (grouping by child service rows fans out counts), so multi-service events
 * show the first model plus a count.
 */
export function eventModelLabel(services: Array<{ model: string }>): string {
  if (services.length === 0) return '—'
  return services.length === 1
    ? services[0].model
    : `${services[0].model} +${services.length - 1} more`
}
