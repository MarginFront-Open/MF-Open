import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTablePagination } from '../hooks'
import { DataTablePaginationProps } from '../types'

export function DataTablePagination({
  totalResults,
  queryParams,
  setQueryParams,
  paginationConfig,
}: DataTablePaginationProps) {
  const {
    currentPage,
    pageSize: _pageSize,
    paginationMetadata,
    paginationItems,
    handlePageChange,
  } = useTablePagination(
    totalResults,
    queryParams,
    setQueryParams,
    paginationConfig
  )

  if (totalResults === 0) {
    return null
  }

  return (
    <div className='flex items-center justify-between'>
      <div className='text-sm text-muted-foreground'>
        Showing {paginationMetadata.from}-{paginationMetadata.to} of{' '}
        {totalResults} results
      </div>
      <div className='flex items-center gap-1'>
        <Button
          variant='outline'
          size='icon'
          className='h-8 w-8'
          disabled={!paginationMetadata.hasPreviousPage}
          onClick={() => handlePageChange(currentPage - 1)}
        >
          <ChevronLeftIcon className='h-4 w-4' />
        </Button>

        {paginationItems.map((item, _index) =>
          item.type === 'ellipsis' ? (
            <span
              key={`ellipsis-${item.value}`}
              className='mx-1 text-muted-foreground'
            >
              ...
            </span>
          ) : (
            <Button
              key={`page-${item.value}`}
              variant={currentPage === item.value ? 'default' : 'outline'}
              size='icon'
              className='h-8 w-8'
              onClick={() => handlePageChange(item.value)}
            >
              {item.value}
            </Button>
          )
        )}

        <Button
          variant='outline'
          size='icon'
          className='h-8 w-8'
          disabled={!paginationMetadata.hasNextPage}
          onClick={() => handlePageChange(currentPage + 1)}
        >
          <ChevronRightIcon className='h-4 w-4' />
        </Button>
      </div>
    </div>
  )
}
