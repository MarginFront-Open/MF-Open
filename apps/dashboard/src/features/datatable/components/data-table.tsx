import { useMemo } from 'react'
import { FilterChipsBar, ActiveFilter } from '@/components/ui/filter-chips-bar'
import { DataTableProps } from '../types'
import { DataTableContent } from './data-table-content'
import { DataTablePagination } from './data-table-pagination'
import { DataTableToolbar } from './data-table-toolbar'

export function DataTable<T>({
  data,
  columns,
  filters,
  searchConfig,
  paginationConfig,
  actions,
  onRowClick,
  isLoading,
  onRefresh,
  pageTitle,
  pageDescription,
  totalResults = 0,
  queryParams,
  setQueryParams,
  actionButton,
}: DataTableProps<T>) {
  const activeFilters = useMemo<ActiveFilter[]>(() => {
    if (!filters || filters.length === 0) return []

    const active: ActiveFilter[] = []

    filters.forEach((filter) => {
      const paramKey = filter.paramKey || filter.id
      const value = queryParams[paramKey]

      if (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        value !== filter.clearValue
      ) {
        let displayValue = value

        if (filter.options && Array.isArray(filter.options)) {
          const option = filter.options.find((opt) => opt.value === value)
          displayValue = option?.label || value
        }

        active.push({
          id: paramKey,
          label: filter.label,
          value: String(value),
          displayValue: String(displayValue),
        })
      }
    })

    return active
  }, [queryParams, filters])

  const handleRemoveFilter = (filterId: string) => {
    const filter = filters?.find((f) => (f.paramKey || f.id) === filterId)
    if (filter) {
      const clearValue =
        filter.clearValue !== undefined ? filter.clearValue : ''
      setQueryParams({
        ...queryParams,
        [filterId]: clearValue,
        page: 1,
      })
    }
  }

  const handleClearAllFilters = () => {
    if (!filters || filters.length === 0) return

    const clearedParams = { ...queryParams }

    filters.forEach((filter) => {
      const paramKey = filter.paramKey || filter.id
      const clearValue =
        filter.clearValue !== undefined ? filter.clearValue : ''
      clearedParams[paramKey] = clearValue
    })

    clearedParams.page = 1

    setQueryParams(clearedParams)
  }

  return (
    <div className='flex flex-col space-y-6'>
      <DataTableToolbar
        filters={filters}
        searchConfig={searchConfig}
        onRefresh={onRefresh}
        isLoading={isLoading}
        filterData={{}} // Unused: filters come from queryParams
        queryParams={queryParams}
        setQueryParams={setQueryParams}
        pageTitle={pageTitle}
        pageDescription={pageDescription}
        actionButton={actionButton}
      />

      <FilterChipsBar
        activeFilters={activeFilters}
        onRemoveFilter={handleRemoveFilter}
        onClearAll={handleClearAllFilters}
      />

      <DataTableContent
        data={data}
        columns={columns}
        onRowClick={onRowClick}
        actions={actions}
        isLoading={isLoading}
        queryParams={queryParams}
        setQueryParams={setQueryParams}
      />

      {totalResults > 0 && (
        <DataTablePagination
          totalResults={totalResults}
          queryParams={queryParams}
          setQueryParams={setQueryParams}
          paginationConfig={paginationConfig}
        />
      )}
    </div>
  )
}
