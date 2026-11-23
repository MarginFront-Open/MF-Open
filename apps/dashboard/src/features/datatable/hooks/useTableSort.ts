import { ColumnDef } from '../types'

export function useTableSort<T>(
  columns: ColumnDef<T>[],
  queryParams: Record<string, any>,
  setQueryParams: (params: Record<string, any>) => void,
  sortByParam: string = 'sortBy',
  sortOrderParam: string = 'sortOrder'
) {
  const sortBy = queryParams[sortByParam]
  const sortOrder = queryParams[sortOrderParam] || 'asc'

  const handleSortChange = (columnId: string) => {
    const column = columns.find((col) => col.id === columnId)
    if (column?.enableSorting === false) return

    const newSortOrder =
      sortBy === columnId && sortOrder === 'asc' ? 'desc' : 'asc'

    setQueryParams({
      ...queryParams,
      [sortByParam]: columnId,
      [sortOrderParam]: newSortOrder,
    })
  }

  const getSortDirection = (columnId: string) => {
    if (sortBy !== columnId) return null
    return sortOrder === 'asc' ? 'asc' : 'desc'
  }

  return {
    sortBy,
    sortOrder,
    handleSortChange,
    getSortDirection,
  }
}
