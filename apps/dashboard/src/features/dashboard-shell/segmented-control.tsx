'use client'

/**
 * The ONE segmented control: the pill row the page-scoped date range uses for
 * Month | Last 30 days | Custom, and the ROI table uses for Earned | Total
 * revenue. One module so a second row of choices cannot arrive in a fourth
 * button style.
 */

import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  id: T
  label: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  dataTour,
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  ariaLabel: string
  /** Anchor for the ROI guided tour. A pass-through rather than a wrapper:
   * a wrapping div would change this control's layout on every page. */
  dataTour?: string
}) {
  return (
    <div
      role='group'
      aria-label={ariaLabel}
      data-tour={dataTour}
      className='flex items-center gap-0.5 rounded-mf-seg bg-mf-card2 p-0.5'
    >
      {options.map((option) => (
        <button
          key={option.id}
          type='button'
          onClick={() => onChange(option.id)}
          aria-pressed={option.id === value}
          className={cn(
            'h-6 rounded-mf-seg-item px-2 text-[11.5px] font-medium',
            option.id === value
              ? 'bg-mf-accent2 text-mf-accent'
              : 'text-mf-tx2 hover:text-mf-tx'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
