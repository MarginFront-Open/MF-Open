'use client';

/**
 * StatusBadge Component
 * Elegant pill-shaped status indicator with dot and label
 * Design: Subtle backgrounds with refined typography
 */

import { cn } from '../../utils/cn';

export type StatusType = 'paid' | 'pending' | 'overdue' | 'draft' | 'active' | 'cancelled' | 'success' | 'warning' | 'error' | 'info';

export interface StatusBadgeProps {
  /** Status type */
  status: StatusType;
  /** Custom label (overrides default) */
  label?: string;
  /** Size variant */
  size?: 'sm' | 'md';
  /** Show dot indicator */
  showDot?: boolean;
  /** Custom class name */
  className?: string;
}

const STATUS_CONFIG: Record<StatusType, {
  bg: string;
  border: string;
  text: string;
  dot: string;
  label: string;
}> = {
  paid: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-100',
    text: 'text-emerald-700',
    dot: 'bg-emerald-500',
    label: 'Paid'
  },
  pending: {
    bg: 'bg-amber-50',
    border: 'border-amber-100',
    text: 'text-amber-700',
    dot: 'bg-amber-500',
    label: 'Pending'
  },
  overdue: {
    bg: 'bg-red-50',
    border: 'border-red-100',
    text: 'text-red-700',
    dot: 'bg-red-500',
    label: 'Overdue'
  },
  draft: {
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    text: 'text-gray-600',
    dot: 'bg-gray-400',
    label: 'Draft'
  },
  active: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-100',
    text: 'text-emerald-700',
    dot: 'bg-emerald-500',
    label: 'Active'
  },
  cancelled: {
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    text: 'text-gray-500',
    dot: 'bg-gray-400',
    label: 'Cancelled'
  },
  success: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-100',
    text: 'text-emerald-700',
    dot: 'bg-emerald-500',
    label: 'Success'
  },
  warning: {
    bg: 'bg-amber-50',
    border: 'border-amber-100',
    text: 'text-amber-700',
    dot: 'bg-amber-500',
    label: 'Warning'
  },
  error: {
    bg: 'bg-red-50',
    border: 'border-red-100',
    text: 'text-red-700',
    dot: 'bg-red-500',
    label: 'Error'
  },
  info: {
    bg: 'bg-blue-50',
    border: 'border-blue-100',
    text: 'text-blue-700',
    dot: 'bg-blue-500',
    label: 'Info'
  },
};

export function StatusBadge({
  status,
  label,
  size = 'sm',
  showDot = true,
  className,
}: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.info;
  const displayLabel = label || config.label;

  return (
    <span
      className={cn(
        'marginfront-status-badge inline-flex items-center gap-1.5 font-medium rounded-full border',
        config.bg,
        config.border,
        config.text,
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        className
      )}
    >
      {showDot && (
        <span
          className={cn(
            'rounded-full flex-shrink-0',
            config.dot,
            size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2'
          )}
        />
      )}
      {displayLabel}
    </span>
  );
}
