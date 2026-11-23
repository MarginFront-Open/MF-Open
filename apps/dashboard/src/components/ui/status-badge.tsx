import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Loader2,
  Circle,
  Minus,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * Standard status types used across the application
 */
export type StatusType =
  // Invoice statuses
  | 'paid'
  | 'draft'
  | 'overdue'
  | 'pending'
  | 'void'
  | 'unpaid'
  // Subscription statuses
  | 'active'
  | 'canceled'
  | 'expired'
  | 'trialing'
  // Customer statuses
  | 'inactive'
  // Agent statuses
  | 'live'
  | 'offline'
  | 'processing'
  // Generic statuses
  | 'success'
  | 'warning'
  | 'error'
  | 'info'

/**
 * Status badge variant types
 */
export type StatusVariant =
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral'
  | 'info'
  | 'processing'

/**
 * Badge size variants
 */
export type BadgeSize = 'sm' | 'md' | 'lg'

interface StatusBadgeProps {
  /**
   * The status to display
   */
  status: StatusType | string

  /**
   * Optional custom label (defaults to capitalized status)
   */
  label?: string

  /**
   * Optional additional className
   */
  className?: string

  /**
   * Optional variant override (auto-detected from status if not provided)
   */
  variant?: StatusVariant

  /**
   * Show icon (default: true)
   */
  showIcon?: boolean

  /**
   * Size variant
   */
  size?: BadgeSize

  /**
   * Tooltip text (shows on hover)
   */
  tooltip?: string

  /**
   * Pulse animation for "live" states
   */
  pulse?: boolean
}

/**
 * Status configuration mapping status to variant, label, icon, tooltip, and animations
 */
const STATUS_CONFIG: Record<
  string,
  {
    variant: StatusVariant
    label?: string
    icon?: any
    tooltip?: string
    pulse?: boolean
    spin?: boolean
  }
> = {
  // Success states (green)
  paid: {
    variant: 'success',
    label: 'Paid',
    icon: CheckCircle,
    tooltip: 'Payment received',
  },
  active: {
    variant: 'success',
    label: 'Active',
    icon: CheckCircle,
    tooltip: 'Currently active',
  },
  success: { variant: 'success', icon: CheckCircle },
  live: {
    variant: 'success',
    label: 'Live',
    icon: Circle,
    tooltip: 'Active and running',
    pulse: true,
  },
  trialing: {
    variant: 'info',
    label: 'Trial',
    icon: Clock,
    tooltip: 'In trial period',
  },

  // Issued (canon: invoice sent to customer, awaiting payment)
  issued: {
    variant: 'info',
    label: 'Issued',
    icon: Clock,
    tooltip: 'Sent to customer, awaiting payment',
  },
  finalized: {
    variant: 'info',
    label: 'Issued',
    icon: Clock,
    tooltip: 'Sent to customer, awaiting payment',
  },

  // Warning states (amber)
  pending: {
    variant: 'warning',
    label: 'Pending',
    icon: Clock,
    tooltip: 'Awaiting action',
  },
  unpaid: {
    variant: 'warning',
    label: 'Unpaid',
    icon: AlertTriangle,
    tooltip: 'Payment pending',
  },
  warning: { variant: 'warning', icon: AlertTriangle },

  // Processing states (purple with spinner)
  processing: {
    variant: 'processing',
    label: 'Processing',
    icon: Loader2,
    tooltip: 'Processing...',
    spin: true,
  },

  // Error states (red)
  overdue: {
    variant: 'error',
    label: 'Overdue',
    icon: XCircle,
    tooltip: 'Payment overdue',
  },
  expired: {
    variant: 'error',
    label: 'Expired',
    icon: XCircle,
    tooltip: 'Subscription expired',
  },
  error: { variant: 'error', icon: XCircle },
  offline: {
    variant: 'error',
    label: 'Offline',
    icon: Minus,
    tooltip: 'Not running',
  },

  // Neutral states (gray)
  draft: {
    variant: 'neutral',
    label: 'Draft',
    icon: Minus,
    tooltip: 'Draft invoice',
  },
  void: { variant: 'neutral', label: 'Void', icon: Minus, tooltip: 'Voided' },
  canceled: {
    variant: 'neutral',
    label: 'Canceled',
    icon: Minus,
    tooltip: 'Canceled',
  },
  cancelled: {
    variant: 'neutral',
    label: 'Canceled',
    icon: Minus,
    tooltip: 'Canceled',
  },
  inactive: {
    variant: 'neutral',
    label: 'Inactive',
    icon: Minus,
    tooltip: 'Not active',
  },

  // Info states (blue)
  info: { variant: 'info', icon: Info },
}

/**
 * Variant to className mapping (Brand-consistent design with dark mode)
 * Uses semantic colors:
 * - success: Uses brand secondary (lime green) for positive states
 * - warning: Uses amber for caution states
 * - error: Uses destructive color for negative states
 * - neutral: Uses muted colors
 * - info: Uses brand primary (deep teal) for informational states
 * - processing: Uses purple for processing states
 */
const VARIANT_CLASSES: Record<StatusVariant, string> = {
  success:
    'bg-secondary/10 text-secondary-dark border-secondary/20 dark:bg-secondary/20 dark:text-secondary dark:border-secondary/30',
  warning:
    'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800',
  error:
    'bg-destructive/10 text-destructive border-destructive/20 dark:bg-destructive/20 dark:text-destructive dark:border-destructive/30',
  neutral:
    'bg-muted text-muted-foreground border-border dark:bg-muted dark:text-muted-foreground dark:border-border',
  info: 'bg-primary/10 text-primary border-primary/20 dark:bg-primary/20 dark:text-primary dark:border-primary/30',
  processing:
    'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-950 dark:text-purple-400 dark:border-purple-800',
}

/**
 * Size to className mapping
 */
const SIZE_CLASSES: Record<
  BadgeSize,
  { container: string; icon: string; text: string }
> = {
  sm: {
    container: 'px-1.5 py-0.5 text-[10px]',
    icon: 'h-2.5 w-2.5',
    text: 'text-[10px]',
  },
  md: {
    container: 'px-2 py-1 text-xs',
    icon: 'h-3 w-3',
    text: 'text-xs',
  },
  lg: {
    container: 'px-3 py-1.5 text-sm',
    icon: 'h-4 w-4',
    text: 'text-sm',
  },
}

/**
 * Capitalize first letter of string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

/**
 * StatusBadge Component
 *
 * Status badge with icons, tooltips, and pulse and spin animations.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <StatusBadge status="paid" />
 * <StatusBadge status="active" />
 *
 * // With animations
 * <StatusBadge status="live" /> // Pulsing green dot
 * <StatusBadge status="processing" /> // Spinning loader
 *
 * // Custom size
 * <StatusBadge status="pending" size="sm" />
 * <StatusBadge status="active" size="lg" />
 *
 * // With tooltip
 * <StatusBadge status="paid" tooltip="Invoice paid on Jan 15, 2025" />
 *
 * // Custom variant
 * <StatusBadge status="custom" variant="success" label="Custom Status" />
 * ```
 */
export function StatusBadge({
  status,
  label,
  className,
  variant,
  showIcon = true,
  size = 'md',
  tooltip,
  pulse,
}: StatusBadgeProps) {
  // Get config for this status, or use neutral as default
  const config = STATUS_CONFIG[status.toLowerCase()] || {
    variant: 'neutral' as StatusVariant,
  }

  // Use provided variant, or auto-detected variant
  const finalVariant = variant || config.variant

  // Use provided label, configured label, or capitalized status
  const finalLabel = label || config.label || capitalize(status)

  // Get className for the variant
  const variantClassName = VARIANT_CLASSES[finalVariant]
  const sizeConfig = SIZE_CLASSES[size]

  // Get icon component
  const IconComponent = config.icon

  // Determine if should pulse or spin
  const shouldPulse = pulse ?? config.pulse
  const shouldSpin = config.spin

  const badgeContent = (
    <Badge
      variant='outline'
      className={cn(
        variantClassName,
        sizeConfig.container,
        'inline-flex items-center gap-1 transition-all duration-200',
        className
      )}
    >
      {showIcon && IconComponent && (
        <IconComponent
          className={cn(
            sizeConfig.icon,
            shouldSpin && 'animate-spin',
            shouldPulse && 'animate-pulse'
          )}
        />
      )}
      <span className={sizeConfig.text}>{finalLabel}</span>
    </Badge>
  )

  // Wrap with tooltip if provided
  if (tooltip || config.tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{badgeContent}</TooltipTrigger>
          <TooltipContent>
            <p className='text-xs'>{tooltip || config.tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return badgeContent
}
