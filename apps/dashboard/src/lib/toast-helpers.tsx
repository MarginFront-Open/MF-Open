/**
 * Toast helpers: toast notifications with icons and actions.
 */
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  Loader2,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'

export interface ToastOptions {
  title: string
  description?: string
  duration?: number
  action?: {
    label: string
    onClick: () => void
  }
}

/**
 * Success Toast - Green with checkmark
 * Auto-dismisses in 3s
 *
 * @example
 * showSuccessToast({
 *   title: 'Customer created',
 *   description: 'BrightSignal Labs has been added to your account',
 *   action: { label: 'View Customer', onClick: () => navigate('/customers/123') }
 * })
 */
export function showSuccessToast({
  title,
  description,
  duration,
  action,
}: ToastOptions) {
  return toast({
    variant: 'success',
    duration,
    title: (
      <div className='flex items-center gap-2'>
        <CheckCircle className='h-5 w-5 text-secondary-dark' />
        <span>{title}</span>
      </div>
    ) as any,
    description,
    action: action ? (
      <ToastAction altText={action.label} onClick={action.onClick}>
        {action.label}
      </ToastAction>
    ) : undefined,
  })
}

/**
 * Error Toast - Red with X icon
 * Auto-dismisses in 6s (or never if action provided)
 *
 * @example
 * showErrorToast({
 *   title: 'Failed to create customer',
 *   description: 'Email already exists in the system',
 *   action: { label: 'Retry', onClick: () => retryCreate() }
 * })
 */
export function showErrorToast({
  title,
  description,
  duration,
  action,
}: ToastOptions) {
  return toast({
    variant: 'destructive',
    duration: action ? undefined : duration, // Don't auto-dismiss if there's an action
    title: (
      <div className='flex items-center gap-2'>
        <XCircle className='h-5 w-5 text-red-600' />
        <span>{title}</span>
      </div>
    ) as any,
    description,
    action: action ? (
      <ToastAction altText={action.label} onClick={action.onClick}>
        {action.label}
      </ToastAction>
    ) : undefined,
  })
}

/**
 * Warning Toast - Amber with warning triangle
 * Auto-dismisses in 4s
 *
 * @example
 * showWarningToast({
 *   title: 'Subscription expiring soon',
 *   description: 'Tamarack Commerce subscription ends in 3 days',
 *   action: { label: 'Renew', onClick: () => navigate('/subscriptions/123/renew') }
 * })
 */
export function showWarningToast({
  title,
  description,
  duration,
  action,
}: ToastOptions) {
  return toast({
    variant: 'warning',
    duration,
    title: (
      <div className='flex items-center gap-2'>
        <AlertTriangle className='h-5 w-5 text-amber-600' />
        <span>{title}</span>
      </div>
    ) as any,
    description,
    action: action ? (
      <ToastAction altText={action.label} onClick={action.onClick}>
        {action.label}
      </ToastAction>
    ) : undefined,
  })
}

/**
 * Info Toast - Blue with info icon
 * Auto-dismisses in 4s
 *
 * @example
 * showInfoToast({
 *   title: 'Filter applied',
 *   description: 'Showing 5 customers filtered by Agent: Support Bot',
 *   action: { label: 'Clear Filter', onClick: () => clearFilters() }
 * })
 */
export function showInfoToast({
  title,
  description,
  duration,
  action,
}: ToastOptions) {
  return toast({
    variant: 'info',
    duration,
    title: (
      <div className='flex items-center gap-2'>
        <Info className='h-5 w-5 text-blue-600' />
        <span>{title}</span>
      </div>
    ) as any,
    description,
    action: action ? (
      <ToastAction altText={action.label} onClick={action.onClick}>
        {action.label}
      </ToastAction>
    ) : undefined,
  })
}

/**
 * Processing Toast - Purple with spinner
 * Does NOT auto-dismiss (must be manually dismissed)
 *
 * @example
 * const toastId = showProcessingToast({
 *   title: 'Exporting data...',
 *   description: 'This may take a few moments'
 * })
 *
 * // Later, update to success
 * toastId.dismiss()
 * showSuccessToast({ title: 'Export complete', ... })
 */
export function showProcessingToast({
  title,
  description,
}: Omit<ToastOptions, 'action' | 'duration'>) {
  return toast({
    variant: 'info',
    duration: undefined, // Never auto-dismiss
    title: (
      <div className='flex items-center gap-2'>
        <Loader2 className='h-5 w-5 animate-spin text-purple-600' />
        <span>{title}</span>
      </div>
    ) as any,
    description,
  })
}

/**
 * Filter Applied Toast - Shows when filters are applied
 * Auto-dismisses in 3s
 *
 * @example
 * showFilterAppliedToast({
 *   filterType: 'Agent',
 *   filterValue: 'Support Bot',
 *   count: 5,
 *   onClear: () => clearAgentFilter()
 * })
 */
export function showFilterAppliedToast({
  filterType,
  filterValue,
  count,
  onClear,
}: {
  filterType: string
  filterValue: string
  count?: number
  onClear?: () => void
}) {
  return showInfoToast({
    title: 'Filter applied',
    description:
      count !== undefined
        ? `Showing ${count} results filtered by ${filterType}: ${filterValue}`
        : `Filtered by ${filterType}: ${filterValue}`,
    duration: 3000,
    action: onClear ? { label: 'Clear', onClick: onClear } : undefined,
  })
}

/**
 * Date Range Selected Toast - Shows when date range is selected
 * Auto-dismisses in 2s
 *
 * @example
 * showDateRangeToast({
 *   startDate: '2025-01-01',
 *   endDate: '2025-01-31',
 *   onReset: () => resetDates()
 * })
 */
export function showDateRangeToast({
  startDate,
  endDate,
  onReset,
}: {
  startDate: string
  endDate: string
  onReset?: () => void
}) {
  return showInfoToast({
    title: 'Date range selected',
    description: `${startDate} to ${endDate}`,
    duration: 2000,
    action: onReset ? { label: 'Reset', onClick: onReset } : undefined,
  })
}

/**
 * Undo Toast - For reversible actions
 * Auto-dismisses in 5s with undo button
 *
 * @example
 * showUndoToast({
 *   title: 'Customer deleted',
 *   description: 'Foglamp Media has been removed',
 *   onUndo: () => restoreCustomer()
 * })
 */
export function showUndoToast({
  title,
  description,
  onUndo,
}: {
  title: string
  description?: string
  onUndo: () => void
}) {
  return showSuccessToast({
    title,
    description,
    duration: 5000,
    action: { label: 'Undo', onClick: onUndo },
  })
}
