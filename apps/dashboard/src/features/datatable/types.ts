import { ReactNode } from 'react'

export interface ColumnDef<T> {
  id: string
  header: string | ReactNode
  accessorKey?: keyof T
  accessorFn?: (row: T) => any
  cell?: (row: T) => ReactNode
  enableSorting?: boolean
}

export interface FilterDef<T = any> {
  id: string
  label: string
  type: 'select' | 'autocomplete' | 'dateRange' | 'text'
  onSearchBar?: boolean
  options?: Array<{ label: string; value: string }>
  placeholder?: string
  paramKey?: string
  clearValue?: any
  defaultValue?: any
  isMulti?: boolean
  entityKey?: keyof T
}

export interface SearchConfig {
  placeholder?: string
  debounceTime?: number
  paramKey?: string
}

export interface PaginationConfig {
  pageParamKey?: string
  limitParamKey?: string
  defaultPageSize?: number
}

export interface ActionConfig<T> {
  id: string
  label: string
  icon?: ReactNode
  onClick: (row: T) => void
  variant?: 'default' | 'destructive' | 'outline' | 'ghost'
  disabled?: (row: T) => boolean
}

export interface DataTableProps<T> {
  data: T[]
  columns: ColumnDef<T>[]
  filters?: FilterDef<T>[]
  searchConfig?: SearchConfig
  paginationConfig?: PaginationConfig
  actions?: ActionConfig<T>[]
  onRowClick?: (row: T) => void
  isLoading: boolean
  onRefresh?: () => void
  pageTitle?: string
  pageDescription?: string
  totalResults?: number
  queryParams: Record<string, any>
  setQueryParams: (params: Record<string, any>) => void
  actionButton?: ReactNode
}

export interface DataTableToolbarProps<T> {
  filters?: FilterDef<T>[]
  searchConfig?: SearchConfig
  onRefresh?: () => void
  isLoading: boolean
  filterData: Record<string, any>
  queryParams: Record<string, any>
  setQueryParams: (params: Record<string, any>) => void
  pageTitle?: string
  pageDescription?: string
  actionButton?: ReactNode
}

export interface DataTableContentProps<T> {
  data: T[]
  columns: ColumnDef<T>[]
  onRowClick?: (row: T) => void
  actions?: ActionConfig<T>[]
  isLoading: boolean
  queryParams: Record<string, any>
  setQueryParams: (params: Record<string, any>) => void
}

export interface DataTablePaginationProps {
  totalResults: number
  queryParams: Record<string, any>
  setQueryParams: (params: Record<string, any>) => void
  paginationConfig?: PaginationConfig
}
