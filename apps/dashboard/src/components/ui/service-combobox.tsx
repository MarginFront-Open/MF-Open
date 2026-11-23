'use client'

/**
 * Service Combobox — searchable dropdown for models + API services
 *
 * Works with the live ServicePricingEntry data from useServicePricing().
 * Shows pricing info, provider, and service type for each entry.
 * Supports "add custom" when the user's service isn't in the list.
 */

import { useState, useMemo } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { formatCost } from '@/lib/canon-format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ServicePricingEntry } from '@/app/actions/service-pricing'

interface ServiceComboboxProps {
  entries: ServicePricingEntry[]
  value: string
  onSelect: (entry: ServicePricingEntry | null) => void
  onAddCustom?: (searchQuery: string) => void
  placeholder?: string
  disabled?: boolean
  isLoading?: boolean
}

function formatPrice(cost: number | null): string {
  return cost === null ? '—' : formatCost(cost)
}

export function ServiceCombobox({
  entries,
  value,
  onSelect,
  onAddCustom,
  placeholder = 'Search services...',
  disabled = false,
  isLoading = false,
}: ServiceComboboxProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search.trim()) return entries.slice(0, 50)
    const lower = search.toLowerCase()
    return entries
      .filter(
        (e) =>
          e.displayName.toLowerCase().includes(lower) ||
          e.id.toLowerCase().includes(lower) ||
          e.provider.toLowerCase().includes(lower)
      )
      .slice(0, 50)
  }, [entries, search])

  const selected = entries.find((e) => e.id === value)
  const showAddCustom = search.trim().length > 0 && filtered.length === 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='w-full justify-between font-normal'
          disabled={disabled}
        >
          {isLoading ? (
            <span className='text-muted-foreground'>
              Loading pricing data...
            </span>
          ) : selected ? (
            <span className='truncate'>
              {selected.displayName}
              <span className='ml-2 text-xs text-muted-foreground'>
                ({selected.provider})
              </span>
            </span>
          ) : (
            <span className='text-muted-foreground'>{placeholder}</span>
          )}
          <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className='w-[450px] p-0'
        align='start'
        side='bottom'
        sideOffset={4}
        collisionPadding={16}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false} loop>
          <CommandInput
            placeholder={placeholder}
            value={search}
            onValueChange={setSearch}
            autoFocus
          />
          <CommandList className='max-h-[250px]'>
            {filtered.length === 0 && !showAddCustom && (
              <CommandEmpty>
                {isLoading ? 'Loading...' : 'No results found.'}
              </CommandEmpty>
            )}
            {filtered.length > 0 && (
              <CommandGroup>
                {filtered.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => {
                      onSelect(entry.id === value ? null : entry)
                      setOpen(false)
                      setSearch('')
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        value === entry.id ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <div className='flex flex-1 items-center justify-between'>
                      <div>
                        <span className='font-medium'>{entry.displayName}</span>
                        <span className='ml-1.5 text-xs text-muted-foreground'>
                          {entry.provider}
                        </span>
                      </div>
                      <span className='text-xs text-muted-foreground'>
                        {entry.isApi
                          ? `${formatPrice(entry.inputCost)} / ${entry.costUnit}`
                          : `${formatPrice(entry.inputCost)} / ${formatPrice(entry.outputCost)} per ${entry.costUnit}`}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {filtered.length >= 50 && (
              <p className='p-2 text-center text-xs text-muted-foreground'>
                Type to search more...
              </p>
            )}
            {showAddCustom && onAddCustom && (
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    onAddCustom(search)
                    setOpen(false)
                    setSearch('')
                  }}
                >
                  <Plus className='mr-2 h-4 w-4' />
                  <span>Add &quot;{search}&quot; as a custom service</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
