'use client'

import { useState, useMemo } from 'react'
import { Check, ChevronsUpDown, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { LiteLLMModel } from '../data/litellm-models'
import { formatCost as canonFormatCost } from '@/lib/canon-format'

interface ModelComboboxProps {
  models: LiteLLMModel[]
  value: string
  onSelect: (model: LiteLLMModel | null) => void
  onAddNew?: (searchQuery: string) => void
  placeholder?: string
  disabled?: boolean
  isLoading?: boolean
}

/**
 * Searchable combobox for selecting LLM models
 * Uses Popover + Command pattern from shadcn/ui
 * Features efficient search with limited results for large datasets
 */
export function ModelCombobox({
  models,
  value,
  onSelect,
  onAddNew,
  placeholder = 'Select model...',
  disabled = false,
  isLoading = false,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Filter models based on search query - O(n) with early termination via slice
  const filteredModels = useMemo(() => {
    if (!search) return models.slice(0, 50)
    const lower = search.toLowerCase()
    return models
      .filter(
        (m) =>
          m.displayName.toLowerCase().includes(lower) ||
          m.id.toLowerCase().includes(lower)
      )
      .slice(0, 50)
  }, [models, search])

  // Check if search has no exact matches (for showing "Add New" option)
  const showAddNew = useMemo(() => {
    if (!search || !onAddNew) return false
    // Show "Add New" if there are no results or search doesn't match any model exactly
    return (
      filteredModels.length === 0 ||
      !filteredModels.some(
        (m) =>
          m.displayName.toLowerCase() === search.toLowerCase() ||
          m.id.toLowerCase() === search.toLowerCase()
      )
    )
  }, [search, filteredModels, onAddNew])

  // Find selected model
  const selectedModel = models.find((m) => m.id === value)

  const formatPrice = (cost: number | null): string =>
    cost === null ? 'N/A' : canonFormatCost(cost)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled || isLoading}
          className='w-full justify-between font-normal'
        >
          {isLoading ? (
            <span className='flex items-center text-muted-foreground'>
              <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              Loading models...
            </span>
          ) : selectedModel ? (
            <span className='truncate'>{selectedModel.displayName}</span>
          ) : (
            <span className='text-muted-foreground'>{placeholder}</span>
          )}
          <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[400px] p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder='Search models...'
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className='max-h-[300px] touch-pan-y overflow-y-auto overscroll-contain'>
            <CommandEmpty>No models found.</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  onSelect={() => {
                    onSelect(null)
                    setOpen(false)
                    setSearch('')
                  }}
                  className='text-muted-foreground'
                >
                  Clear selection
                </CommandItem>
              )}
              {filteredModels.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  onSelect={() => {
                    onSelect(model)
                    setOpen(false)
                    setSearch('')
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4 shrink-0',
                      value === model.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className='flex min-w-0 flex-1 flex-col'>
                    <span className='truncate'>{model.displayName}</span>
                    <span className='text-xs text-muted-foreground'>
                      {model.inputCost !== null || model.outputCost !== null
                        ? `${formatPrice(model.inputCost)} / ${formatPrice(model.outputCost)} per ${model.costUnit}`
                        : `Mode: ${model.mode}`}
                    </span>
                  </div>
                </CommandItem>
              ))}
              {filteredModels.length === 50 && (
                <div className='px-3 py-2 text-center text-xs text-muted-foreground'>
                  Type to search more models...
                </div>
              )}
            </CommandGroup>
            {showAddNew && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      onAddNew?.(search)
                      setOpen(false)
                      setSearch('')
                    }}
                    className='text-primary'
                  >
                    <Plus className='mr-2 h-4 w-4' />
                    <span>Add custom model: &quot;{search}&quot;</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
