import { useState } from 'react'
import { FilterIcon, SearchIcon, XIcon, RefreshCw } from 'lucide-react'
import { showFilterAppliedToast } from '@/lib/toast-helpers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { DataTableFilter } from '../components/data-table-filter'
import { useTableSearch } from '../hooks'
import { DataTableToolbarProps } from '../types'

export function DataTableToolbar<T>({
  filters = [],
  searchConfig = {},
  onRefresh,
  isLoading,
  queryParams,
  setQueryParams,
  pageTitle,
  pageDescription,
  actionButton,
}: DataTableToolbarProps<T>) {
  const [showFilters, setShowFilters] = useState(false)

  const {
    searchValue,
    handleSearchChange,
    resetSearch: _resetSearch,
    isSearching,
  } = useTableSearch(searchConfig, queryParams, setQueryParams)

  const searchBarFilters = filters.filter((filter) => filter.onSearchBar)
  const popoverFilters = filters.filter((filter) => !filter.onSearchBar)

  const activePopoverFilterCount = popoverFilters.reduce((count, filter) => {
    const paramKey = filter.paramKey || filter.id
    const hasValue =
      queryParams[paramKey] !== undefined &&
      queryParams[paramKey] !== '' &&
      queryParams[paramKey] !== filter.clearValue
    return hasValue ? count + 1 : count
  }, 0)

  const clearPopoverFilters = () => {
    const newParams = { ...queryParams }

    popoverFilters.forEach((filter) => {
      const paramKey = filter.paramKey || filter.id
      delete newParams[paramKey]
    })

    newParams.page = 1

    setQueryParams(newParams)
  }

  const handleFilterChange = (filterId: string, value: any) => {
    const filter = filters.find((f) => f.id === filterId)
    if (!filter) return

    const paramKey = filter.paramKey || filter.id

    const isClearingFilter =
      value === filter.clearValue || value === '' || value === undefined

    setQueryParams({
      ...queryParams,
      [paramKey]: isClearingFilter ? undefined : value,
      page: 1,
    })

    if (!isClearingFilter) {
      let displayValue = value
      if (filter.options && Array.isArray(filter.options)) {
        const option = filter.options.find((opt) => opt.value === value)
        displayValue = option?.label || value
      }

      showFilterAppliedToast({
        filterType: filter.label,
        filterValue: displayValue,
        onClear: () => clearFilter(filterId),
      })
    }
  }

  const clearFilter = (filterId: string) => {
    const filter = filters.find((f) => f.id === filterId)
    if (!filter) return

    const paramKey = filter.paramKey || filter.id

    setQueryParams({
      ...queryParams,
      [paramKey]: undefined,
      page: 1,
    })
  }

  return (
    <div className='flex flex-col gap-4'>
      {(pageTitle || pageDescription) && (
        <div className='flex flex-wrap items-center justify-between gap-x-4 space-y-2'>
          <div>
            {pageTitle && (
              <h2 className='text-2xl font-bold tracking-tight'>{pageTitle}</h2>
            )}
            {pageDescription && (
              <p className='text-muted-foreground'>{pageDescription}</p>
            )}
          </div>
          {actionButton ? (
            actionButton
          ) : onRefresh ? (
            <Button
              variant='outline'
              size='sm'
              onClick={onRefresh}
              disabled={isLoading}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`}
              />
              Refresh
            </Button>
          ) : null}
        </div>
      )}

      <div className='flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center'>
        <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-3'>
          {searchConfig && (
            <div className='relative flex-1 sm:min-w-[200px] sm:max-w-[300px] sm:flex-initial'>
              <SearchIcon className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
              <Input
                placeholder={searchConfig.placeholder || 'Search...'}
                className='w-full pl-9 pr-9'
                value={searchValue}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              {isSearching && (
                <div className='pointer-events-none absolute right-3 top-1/2 -translate-y-1/2'>
                  <Spinner className='h-4 w-4' />
                </div>
              )}
            </div>
          )}

          {searchBarFilters.map((filter) => (
            <DataTableFilter
              key={filter.id}
              filter={filter}
              value={queryParams[filter.paramKey || filter.id]}
              onChange={(value: any) => handleFilterChange(filter.id, value)}
              isSearchBar
            />
          ))}

          {popoverFilters.length > 0 && (
            <Popover open={showFilters} onOpenChange={setShowFilters}>
              <PopoverTrigger asChild>
                <Button
                  variant={activePopoverFilterCount > 0 ? 'default' : 'outline'}
                  size='sm'
                  className='gap-2 whitespace-nowrap'
                >
                  <FilterIcon className='h-4 w-4' />
                  <span className='hidden sm:inline'>More Filters</span>
                  <span className='sm:hidden'>Filters</span>
                  {activePopoverFilterCount > 0 && (
                    <Badge className='ml-1 rounded-full px-1.5 py-0.5 text-xs'>
                      {activePopoverFilterCount}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-80 p-4' align='start'>
                <div className='flex flex-col gap-4'>
                  <div className='flex items-center justify-between'>
                    <h3 className='text-sm font-semibold'>
                      Additional Filters
                    </h3>
                    {activePopoverFilterCount > 0 && (
                      <Button
                        variant='ghost'
                        size='sm'
                        className='h-8 gap-1 text-xs'
                        onClick={clearPopoverFilters}
                      >
                        <XIcon className='h-3 w-3' />
                        Clear filters
                      </Button>
                    )}
                  </div>

                  {popoverFilters.map((filter) => (
                    <DataTableFilter
                      key={filter.id}
                      filter={filter}
                      value={queryParams[filter.paramKey || filter.id]}
                      onChange={(value: any) =>
                        handleFilterChange(filter.id, value)
                      }
                    />
                  ))}

                  <Button
                    className='mt-2'
                    onClick={() => setShowFilters(false)}
                  >
                    Apply Filters
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {actionButton && (
          <div className='flex flex-shrink-0 flex-wrap items-center gap-2 sm:flex-nowrap'>
            {actionButton}
          </div>
        )}
      </div>
    </div>
  )
}
