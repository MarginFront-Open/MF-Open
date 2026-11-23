import React from 'react'
import { cn } from '@/lib/utils'

interface StatusBadgeProps {
  status:
    | 'active'
    | 'paused'
    | 'cancelled'
    | 'expired'
    | 'paid'
    | 'pending'
    | 'overdue'
    | 'draft'
    | 'void'
  className?: string
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const statusConfig = {
    active: {
      color:
        'bg-secondary/10 text-secondary-dark border-secondary/20 dark:bg-secondary/30 dark:text-secondary',
      dot: 'bg-secondary',
    },
    paused: {
      color: 'bg-amber-100 text-amber-800 border-amber-200',
      dot: 'bg-amber-500',
    },
    cancelled: {
      color: 'bg-red-100 text-red-800 border-red-200',
      dot: 'bg-red-500',
    },
    expired: {
      color: 'bg-gray-100 text-gray-800 border-gray-200',
      dot: 'bg-gray-500',
    },
    paid: {
      color:
        'bg-secondary/10 text-secondary-dark border-secondary/20 dark:bg-secondary/30 dark:text-secondary',
      dot: 'bg-secondary',
    },
    pending: {
      color: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      dot: 'bg-yellow-500',
    },
    overdue: {
      color: 'bg-red-100 text-red-800 border-red-200',
      dot: 'bg-red-500',
    },
    draft: {
      color: 'bg-gray-100 text-gray-800 border-gray-200',
      dot: 'bg-gray-500',
    },
    void: {
      color: 'bg-slate-100 text-slate-800 border-slate-200',
      dot: 'bg-slate-500',
    },
  }

  const config = statusConfig[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
        config.color,
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', config.dot)}></span>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}
