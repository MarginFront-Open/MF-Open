import { useState, useEffect } from 'react'
import { FilterDef } from '../types'

export function useTableFilters<T>(
  filters: FilterDef<T>[] = [],
  queryParams: Record<string, any>,
  setQueryParams: (params: Record<string, any>) => void
) {
  const [filterValues, setFilterValues] = useState<Record<string, any>>({})
  const [activeFilterCount, setActiveFilterCount] = useState(0)

  useEffect(() => {
    const initialValues: Record<string, any> = {}

    filters.forEach((filter) => {
      const paramKey = filter.paramKey || filter.id
      if (queryParams[paramKey] !== undefined) {
        initialValues[filter.id] = queryParams[paramKey]
      }
    })

    setFilterValues(initialValues)
  }, [filters, queryParams])

  useEffect(() => {
    let count = 0

    filters.forEach((filter) => {
      const paramKey = filter.paramKey || filter.id
      if (
        queryParams[paramKey] !== undefined &&
        queryParams[paramKey] !== '' &&
        queryParams[paramKey] !== 'all' &&
        queryParams[paramKey] !== filter.clearValue
      ) {
        count++
      }
    })

    setActiveFilterCount(count)
  }, [filters, queryParams])

  const handleFilterChange = (filterId: string, value: any) => {
    const filter = filters.find((f) => f.id === filterId)
    if (!filter) return

    const paramKey = filter.paramKey || filter.id

    setFilterValues((prev) => ({
      ...prev,
      [filterId]: value,
    }))

    const isClearingFilter =
      value === filter.clearValue ||
      value === '' ||
      value === undefined ||
      value === 'all'

    setQueryParams({
      ...queryParams,
      [paramKey]: isClearingFilter ? undefined : value,
      page: 1,
    })
  }

  const clearFilter = (filterId: string) => {
    const filter = filters.find((f) => f.id === filterId)
    if (!filter) return

    const paramKey = filter.paramKey || filter.id

    setFilterValues((prev) => {
      const newValues = { ...prev }
      delete newValues[filterId]
      return newValues
    })

    setQueryParams({
      ...queryParams,
      [paramKey]: undefined,
      page: 1,
    })
  }

  const clearAllFilters = () => {
    const newParams: Record<string, any> = {}

    Object.keys(queryParams).forEach((key) => {
      const isFilterParam = filters.some(
        (filter) => (filter.paramKey || filter.id) === key
      )
      if (!isFilterParam) {
        newParams[key] = queryParams[key]
      }
    })

    newParams.page = 1

    setQueryParams(newParams)

    setFilterValues({})
  }

  const getSearchBarFilters = () =>
    filters.filter((filter) => filter.onSearchBar)
  const getPopoverFilters = () =>
    filters.filter((filter) => !filter.onSearchBar)

  return {
    filterValues,
    handleFilterChange,
    clearFilter,
    clearAllFilters,
    activeFilterCount,
    getSearchBarFilters,
    getPopoverFilters,
  }
}
