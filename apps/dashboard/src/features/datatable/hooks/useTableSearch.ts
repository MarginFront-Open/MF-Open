import { useState, useEffect } from 'react'
import { SearchConfig } from '../types'

const DEFAULT_DEBOUNCE_TIME = 300

export function useTableSearch(
  config: SearchConfig = {},
  queryParams: Record<string, any>,
  setQueryParams: (params: Record<string, any>) => void
) {
  const { debounceTime = DEFAULT_DEBOUNCE_TIME, paramKey = 'search' } = config

  const [searchValue, setSearchValue] = useState(queryParams[paramKey] || '')
  const [isSearching, setIsSearching] = useState(false)

  useEffect(() => {
    const handler = setTimeout(() => {
      if (queryParams[paramKey] !== searchValue) {
        setQueryParams({
          ...queryParams,
          [paramKey]: searchValue,
          page: 1,
        })
      }
      setIsSearching(false)
    }, debounceTime)

    return () => {
      clearTimeout(handler)
    }
  }, [searchValue, queryParams, setQueryParams, paramKey, debounceTime])

  const handleSearchChange = (value: string) => {
    setSearchValue(value)
    setIsSearching(true)
  }

  const resetSearch = () => {
    setSearchValue('')
    if (queryParams[paramKey]) {
      setQueryParams({
        ...queryParams,
        [paramKey]: '',
        page: 1,
      })
    }
  }

  return {
    searchValue,
    handleSearchChange,
    resetSearch,
    isSearching,
  }
}
