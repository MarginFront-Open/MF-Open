import { useMemo } from 'react'
import { PaginationConfig } from '../types'

const DEFAULT_PAGE_SIZE = 10

export function useTablePagination(
  totalResults: number,
  queryParams: Record<string, any>,
  setQueryParams: (params: Record<string, any>) => void,
  config: PaginationConfig = {}
) {
  const {
    pageParamKey = 'page',
    limitParamKey = 'limit',
    defaultPageSize = DEFAULT_PAGE_SIZE,
  } = config

  const currentPage = queryParams[pageParamKey] || 1
  const pageSize = queryParams[limitParamKey] || defaultPageSize

  const paginationMetadata = useMemo(() => {
    const totalPages = Math.ceil(totalResults / pageSize)
    const from = (currentPage - 1) * pageSize + 1
    const to = Math.min(currentPage * pageSize, totalResults)

    return {
      totalPages,
      from: totalResults > 0 ? from : 0,
      to,
      hasPreviousPage: currentPage > 1,
      hasNextPage: currentPage < totalPages,
    }
  }, [totalResults, pageSize, currentPage])

  const paginationItems = useMemo(() => {
    const { totalPages } = paginationMetadata

    if (totalPages <= 5) {
      return Array.from({ length: totalPages }, (_, i) => ({
        type: 'page' as const,
        value: i + 1,
      }))
    }

    const items: Array<{ type: 'page' | 'ellipsis'; value: number }> = []

    items.push({ type: 'page', value: 1 })

    if (currentPage > 3) {
      items.push({ type: 'ellipsis', value: -1 })
    }

    if (currentPage > 2) {
      items.push({ type: 'page', value: currentPage - 1 })
    }

    if (currentPage !== 1) {
      items.push({ type: 'page', value: currentPage })
    }

    if (currentPage < totalPages - 1) {
      items.push({ type: 'page', value: currentPage + 1 })
    }

    if (currentPage < totalPages - 2) {
      items.push({ type: 'ellipsis', value: -2 })
    }

    if (
      totalPages > 1 &&
      !items.some((item) => item.type === 'page' && item.value === totalPages)
    ) {
      items.push({ type: 'page', value: totalPages })
    }

    return items
  }, [currentPage, paginationMetadata.totalPages])

  const handlePageChange = (page: number) => {
    setQueryParams({
      ...queryParams,
      [pageParamKey]: page,
    })
  }

  const handlePageSizeChange = (size: number) => {
    setQueryParams({
      ...queryParams,
      [limitParamKey]: size,
      [pageParamKey]: 1,
    })
  }

  return {
    currentPage,
    pageSize,
    paginationMetadata,
    paginationItems,
    handlePageChange,
    handlePageSizeChange,
  }
}
