import { useState, useEffect } from 'react'
import {
  ChevronsUpDown,
  XIcon,
  CheckIcon,
  BotIcon,
  UserIcon,
  CalendarIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { FilterDef } from '../types'

interface DataTableFilterProps {
  filter: FilterDef
  value: any
  onChange: (value: any) => void
  isSearchBar?: boolean
}

export function DataTableFilter({
  filter,
  value,
  onChange,
  isSearchBar = false,
}: DataTableFilterProps) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const [debouncedSearchValue, setDebouncedSearchValue] = useState('')
  const [isSearching, setIsSearching] = useState(false)

  // eslint-disable-next-line react-hooks/set-state-in-effect -- valid debounce pattern using setTimeout
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchValue(searchValue)
      setIsSearching(false)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchValue])

  /* eslint-disable react-hooks/set-state-in-effect -- valid sync of external prop to internal state */
  useEffect(() => {
    if (filter.type === 'autocomplete' && value) {
      const option = filter.options?.find((opt) => opt.value === value)
      if (option) {
        setSearchValue(option.label)
      }
    }
  }, [filter, value])
  /* eslint-enable react-hooks/set-state-in-effect */

  const filteredOptions = filter.options?.filter((option) =>
    debouncedSearchValue.trim() === ''
      ? true
      : option.label.toLowerCase().includes(debouncedSearchValue.toLowerCase())
  )

  const getFilterIcon = () => {
    switch (filter.id) {
      case 'agent':
      case 'agentId':
        return (
          <BotIcon className='mr-2 h-4 w-4 shrink-0 text-muted-foreground' />
        )
      case 'customer':
      case 'customerId':
        return (
          <UserIcon className='mr-2 h-4 w-4 shrink-0 text-muted-foreground' />
        )
      case 'date':
      case 'startDate':
      case 'endDate':
      case 'dueDate':
        return (
          <CalendarIcon className='mr-2 h-4 w-4 shrink-0 text-muted-foreground' />
        )
      default:
        return null
    }
  }

  const getPlaceholder = () => {
    return filter.placeholder || `All ${filter.label.toLowerCase()}`
  }

  if (filter.type === 'autocomplete') {
    return (
      <Popover open={searchOpen} onOpenChange={setSearchOpen}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            role='combobox'
            aria-expanded={searchOpen}
            className={`${isSearchBar ? 'h-9 w-[200px]' : 'w-full'} justify-between`}
            size='sm'
          >
            <div className='flex items-center'>
              {getFilterIcon()}
              {value ? (
                <span className='truncate'>
                  {filter.options?.find((opt) => opt.value === value)?.label ||
                    getPlaceholder()}
                </span>
              ) : (
                <span className='text-muted-foreground'>
                  {getPlaceholder()}
                </span>
              )}
            </div>
            <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[200px] p-0'>
          <Command>
            <CommandInput
              placeholder={`Search ${filter.label.toLowerCase()}...`}
              value={searchValue}
              onValueChange={(value) => {
                setSearchValue(value)
                setIsSearching(true)
              }}
            />
            <CommandList>
              <CommandEmpty>
                {isSearching ? (
                  <div className='flex items-center justify-center py-2'>
                    <Spinner className='mr-2 h-3 w-3' />
                    Searching...
                  </div>
                ) : (
                  `No ${filter.label.toLowerCase()} found`
                )}
              </CommandEmpty>
              <CommandGroup>
                {value && (
                  <CommandItem
                    onSelect={() => {
                      onChange(filter.clearValue || '')
                      setSearchValue('')
                      setSearchOpen(false)
                    }}
                    className='text-muted-foreground'
                  >
                    <XIcon className='mr-2 h-4 w-4' />
                    Clear selection
                  </CommandItem>
                )}
                {isSearching ? (
                  <div className='flex items-center justify-center py-2'>
                    <Spinner className='mr-2 h-3 w-3' />
                    Searching...
                  </div>
                ) : (
                  filteredOptions?.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      onSelect={() => {
                        onChange(option.value)
                        setSearchOpen(false)
                      }}
                    >
                      {option.label}
                      {value === option.value && (
                        <CheckIcon className='ml-auto h-4 w-4' />
                      )}
                    </CommandItem>
                  ))
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    )
  }

  if (filter.type === 'select') {
    return (
      <div className={isSearchBar ? 'w-[200px]' : 'w-full'}>
        {!isSearchBar && (
          <div className='mb-2'>
            <label className='text-sm font-medium'>{filter.label}</label>
          </div>
        )}
        <Select
          value={value || 'all'}
          onValueChange={(val) => onChange(val === 'all' ? '' : val)}
        >
          {/*
            The search-bar variant hides the visible <label> above to save
            horizontal space, but the trigger still needs a programmatic
            name so screen readers announce it (and Playwright can locate
            it by role+name). aria-label carries filter.label here.
          */}
          <SelectTrigger
            aria-label={filter.label}
            className={isSearchBar ? 'h-9' : ''}
          >
            <SelectValue placeholder={getPlaceholder()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{getPlaceholder()}</SelectItem>
            {filter.options
              ?.filter((option) => option.value && option.value !== '')
              .map((option, index) => (
                <SelectItem
                  key={option.value || `option-${index}`}
                  value={option.value}
                >
                  {option.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  if (filter.type === 'text') {
    return (
      <div className={isSearchBar ? 'w-[200px]' : 'w-full'}>
        {!isSearchBar && (
          <div className='mb-2'>
            <label className='text-sm font-medium'>{filter.label}</label>
          </div>
        )}
        <div className='relative'>
          <Input
            placeholder={getPlaceholder()}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className={isSearchBar ? 'h-9' : ''}
          />
          {value && (
            <Button
              variant='ghost'
              size='sm'
              className='absolute right-0 top-0 h-full px-3'
              onClick={() => onChange('')}
            >
              <XIcon className='h-4 w-4' />
            </Button>
          )}
        </div>
      </div>
    )
  }

  return null
}
