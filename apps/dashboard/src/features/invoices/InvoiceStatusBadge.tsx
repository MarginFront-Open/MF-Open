/**
 * Invoice Status Badge Component
 *
 * A specialized wrapper around StatusBadge that:
 * - Handles the overdue computed state
 * - Maps LegacyInvoiceStatus values to the right display status
 * - Shows appropriate tooltips for invoice context
 */
import { StatusBadge, BadgeSize } from '@/components/ui/status-badge'
import {
  getDisplayStatus,
  type LegacyInvoiceStatus,
  type InvoiceStatusType,
} from './invoiceStateMachine'

interface InvoiceStatusBadgeProps {
  /**
   * The invoice status (InvoiceStatusType or LegacyInvoiceStatus)
   */
  status: InvoiceStatusType | LegacyInvoiceStatus

  /**
   * Due date for computing overdue status
   */
  dueDate?: string

  /**
   * Badge size variant
   */
  size?: BadgeSize

  /**
   * Additional CSS classes
   */
  className?: string

  /**
   * Custom tooltip override
   */
  tooltip?: string
}

/**
 * Status to tooltip mapping for invoice context
 */
const invoiceTooltips: Record<string, string> = {
  draft: 'Draft - Not yet sent to customer',
  finalized: 'Sent to customer, awaiting payment',
  pending: 'Awaiting payment',
  issued: 'Sent to customer',
  sent: 'Sent to customer, awaiting payment',
  paid: 'Payment received',
  void: 'Invoice voided',
  overdue: 'Payment is past due',
}

/**
 * Map status to the StatusBadge expected format.
 *
 * Invoices with status 'issued' (or 'finalized' in the 4-state
 * reducer) render with the label "Issued", not "Pending". The states
 * that matter to users are sent (issued), paid, and overdue. 'finalized'
 * passes straight through to StatusBadge, which has matching 'issued' +
 * 'finalized' config entries that both resolve to the "Issued" label.
 */
function mapStatusForBadge(
  displayStatus: InvoiceStatusType | 'overdue'
): string {
  return displayStatus
}

export function InvoiceStatusBadge({
  status,
  dueDate,
  size = 'md',
  className,
  tooltip,
}: InvoiceStatusBadgeProps) {
  // Get the display status (handles overdue computation)
  const displayStatus = getDisplayStatus(status, dueDate)

  // Map to StatusBadge format
  const badgeStatus = mapStatusForBadge(displayStatus)

  // Get appropriate tooltip
  const finalTooltip = tooltip || invoiceTooltips[displayStatus] || undefined

  return (
    <StatusBadge
      status={badgeStatus}
      size={size}
      className={className}
      tooltip={finalTooltip}
      showIcon
    />
  )
}
