import { showInfoToast } from '@/lib/toast-helpers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FilterChip } from '@/components/ui/filter-chip'

export interface ActiveFilter {
  id: string
  label: string
  value: string
  displayValue: string // Human-readable value (e.g., "Support Bot" instead of "agent-123")
}

interface FilterChipsBarProps {
  activeFilters: ActiveFilter[]
  onRemoveFilter: (filterId: string) => void
  onClearAll: () => void
  className?: string
}

/**
 * FilterChipsBar - Displays active filters as chips with removal actions (Stripe style)
 *
 * Shows a horizontal bar with:
 * - Count badge showing number of active filters
 * - Individual filter chips with × removal
 * - "Clear all" button to reset all filters
 * - Auto-hides when no filters are active
 * - Toast notifications on filter actions
 *
 * @example
 * <FilterChipsBar
 *   activeFilters={[
 *     { id: 'agentId', label: 'Agent', value: '123', displayValue: 'Support Bot' },
 *     { id: 'status', label: 'Status', value: 'active', displayValue: 'Active' }
 *   ]}
 *   onRemoveFilter={(id) => clearFilter(id)}
 *   onClearAll={() => clearAllFilters()}
 * />
 */
export function FilterChipsBar({
  activeFilters,
  onRemoveFilter,
  onClearAll,
  className,
}: FilterChipsBarProps) {
  // Don't render if no active filters
  if (activeFilters.length === 0) return null

  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/20 px-4 py-3 ${className || ''}`}
    >
      {/* Active Filters Label with Count Badge */}
      <span className='flex items-center gap-2 text-sm font-medium text-muted-foreground'>
        Active Filters
        <Badge
          variant='secondary'
          className='border-primary/20 bg-primary/10 text-primary'
        >
          {activeFilters.length}
        </Badge>
      </span>

      {/* Individual Filter Chips */}
      {activeFilters.map((filter) => (
        <FilterChip
          key={filter.id}
          label={filter.label}
          value={filter.displayValue}
          onRemove={() => {
            onRemoveFilter(filter.id)
            showInfoToast({
              title: 'Filter removed',
              description: `"${filter.label}: ${filter.displayValue}" removed`,
              duration: 2000,
            })
          }}
        />
      ))}

      {/* Clear All Button */}
      <Button
        variant='ghost'
        size='sm'
        onClick={() => {
          onClearAll()
          showInfoToast({
            title: 'Filters cleared',
            description: `${activeFilters.length} filter${activeFilters.length > 1 ? 's' : ''} removed`,
            duration: 2000,
          })
        }}
        className='text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground'
      >
        Clear all
      </Button>
    </div>
  )
}
