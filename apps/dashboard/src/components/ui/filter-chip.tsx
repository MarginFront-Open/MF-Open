import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface FilterChipProps {
  label: string
  value: string
  onRemove: () => void
  className?: string
}

/**
 * FilterChip - A dismissible filter badge component (Stripe style)
 *
 * Displays an active filter as a badge with label and value,
 * with an integrated × button for quick removal.
 *
 * @example
 * <FilterChip
 *   label="Agent"
 *   value="Support Bot"
 *   onRemove={() => clearAgentFilter()}
 * />
 */
export function FilterChip({
  label,
  value,
  onRemove,
  className,
}: FilterChipProps) {
  return (
    <Badge
      variant='secondary'
      className={cn(
        'inline-flex items-center gap-1.5 py-1 pr-1',
        'border-primary/20 bg-primary/10 text-primary',
        'transition-colors duration-200 hover:bg-primary/20',
        className
      )}
    >
      <span className='text-xs font-medium'>
        {label}: <span className='font-normal'>{value}</span>
      </span>
      <Button
        variant='ghost'
        size='icon'
        className='h-4 w-4 rounded-full p-0 transition-colors duration-200 hover:bg-primary/30'
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove ${label} filter`}
      >
        <X className='h-3 w-3' />
      </Button>
    </Badge>
  )
}
