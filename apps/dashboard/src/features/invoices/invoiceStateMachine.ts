/**
 * Invoice State Machine
 *
 * A 4-state model:
 * - draft: Can be edited, not yet sent
 * - finalized: Sent to customer, awaiting payment
 * - paid: Terminal state, payment received
 * - void: Cancelled/written off
 *
 * Note: "overdue" is NOT a state - it's computed from finalized + dueDate < now
 */

export const InvoiceStatus = {
  DRAFT: 'draft',
  FINALIZED: 'finalized',
  PAID: 'paid',
  VOID: 'void',
} as const

export type InvoiceStatusType =
  (typeof InvoiceStatus)[keyof typeof InvoiceStatus]

// Status strings the API can return, mapped onto the 4-state model by mapLegacyStatus.
export type LegacyInvoiceStatus =
  | 'pending'
  | 'paid'
  | 'overdue'
  | 'void'
  | 'draft'
  | 'issued'
  | 'sent'

export type InvoiceAction = 'finalize' | 'markPaid' | 'void'

interface Transition {
  from: InvoiceStatusType | InvoiceStatusType[]
  to: InvoiceStatusType
  action: InvoiceAction
}

const transitions: Transition[] = [
  { from: 'draft', to: 'finalized', action: 'finalize' },
  { from: 'draft', to: 'void', action: 'void' },
  { from: 'finalized', to: 'paid', action: 'markPaid' },
  { from: 'finalized', to: 'void', action: 'void' },
]

/**
 * Check if a transition is valid and return the target state
 */
export function canTransition(
  current: InvoiceStatusType,
  action: InvoiceAction
): InvoiceStatusType | null {
  const transition = transitions.find((t) => {
    const fromMatch = Array.isArray(t.from)
      ? t.from.includes(current)
      : t.from === current
    return fromMatch && t.action === action
  })
  return transition?.to ?? null
}

/**
 * Get available actions for a given status
 */
export function getAvailableActions(
  status: InvoiceStatusType
): InvoiceAction[] {
  return transitions
    .filter((t) =>
      Array.isArray(t.from) ? t.from.includes(status) : t.from === status
    )
    .map((t) => t.action)
}

/**
 * Check if an invoice is overdue (computed property, not a state)
 */
export function isOverdue(
  status: InvoiceStatusType | LegacyInvoiceStatus,
  dueDate: string
): boolean {
  // Finalized, and the API's "pending"/"issued" aliases for it, can be overdue
  const overdueEligibleStatuses = ['finalized', 'pending', 'issued', 'overdue']
  return (
    overdueEligibleStatuses.includes(status) && new Date(dueDate) < new Date()
  )
}

/**
 * Map API status strings to the 4-state model
 */
export function mapLegacyStatus(
  legacyStatus: LegacyInvoiceStatus
): InvoiceStatusType {
  switch (legacyStatus) {
    case 'draft':
      return 'draft'
    case 'pending':
    case 'issued':
    case 'overdue': // Overdue is computed, map to finalized
      return 'finalized'
    case 'paid':
      return 'paid'
    case 'void':
      return 'void'
    default:
      return 'draft'
  }
}

/**
 * Get display status (handles overdue as visual state)
 */
export function getDisplayStatus(
  status: InvoiceStatusType | LegacyInvoiceStatus,
  dueDate?: string
): InvoiceStatusType | 'overdue' {
  // A persisted `overdue` status is authoritative (the daily cron writes it);
  // resolve it straight to the overdue badge so it never falls back to "Issued"
  // when no dueDate is passed. issued/finalized still compute overdue from dueDate.
  if (status === 'overdue') return 'overdue'

  const normalizedStatus = mapLegacyStatus(status as LegacyInvoiceStatus)

  // Check if overdue (only for finalized invoices)
  if (dueDate && isOverdue(status, dueDate)) {
    return 'overdue'
  }

  return normalizedStatus
}
