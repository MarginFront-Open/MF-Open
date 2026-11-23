import { ChevronDownIcon, ArrowUpIcon, ArrowDownIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TableSkeleton } from '@/components/ui/table-skeleton'
import { useTableSort } from '../hooks'
import { DataTableContentProps } from '../types'

export function DataTableContent<T>({
  data,
  columns,
  onRowClick,
  actions,
  isLoading,
  queryParams,
  setQueryParams,
}: DataTableContentProps<T>) {
  const {
    sortBy: _sortBy,
    sortOrder: _sortOrder,
    handleSortChange,
    getSortDirection,
  } = useTableSort(columns, queryParams, setQueryParams)

  if (isLoading) {
    return (
      <TableSkeleton
        rows={5}
        columns={columns.length}
        showActions={actions && actions.length > 0}
        showHeader={true}
        headerLabels={columns.map((col) => col.header as string)}
      />
    )
  }

  return (
    <div className='rounded-lg border border-border/50 bg-card shadow-sm'>
      <div className='overflow-x-auto'>
        <Table>
          <TableHeader>
            <TableRow className='border-b border-border/50 hover:bg-transparent'>
              {columns.map((column) => (
                <TableHead
                  key={column.id}
                  className='px-4 py-3 font-semibold text-foreground'
                >
                  {column.enableSorting !== false ? (
                    <button
                      className='flex items-center gap-1.5 transition-colors duration-100 will-change-[color] hover:text-primary'
                      onClick={() => handleSortChange(column.id)}
                    >
                      {column.header}
                      {getSortDirection(column.id) &&
                        (getSortDirection(column.id) === 'asc' ? (
                          <ArrowUpIcon className='h-3.5 w-3.5 transition-transform duration-100' />
                        ) : (
                          <ArrowDownIcon className='h-3.5 w-3.5 transition-transform duration-100' />
                        ))}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              ))}

              {actions && actions.length > 0 && (
                <TableHead className='px-4 py-3 text-right font-semibold text-foreground'>
                  Actions
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow className='animate-fade-in'>
                <TableCell
                  colSpan={
                    columns.length + (onRowClick ? 1 : 0) + (actions ? 1 : 0)
                  }
                  className='h-40 text-center'
                >
                  <div className='flex flex-col items-center justify-center space-y-3'>
                    <div className='rounded-full bg-muted/50 p-3'>
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        className='h-8 w-8 text-muted-foreground/50'
                      >
                        <path d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' />
                        <polyline points='3.27 6.96 12 12.01 20.73 6.96' />
                        <line x1='12' y1='22.08' x2='12' y2='12' />
                      </svg>
                    </div>
                    <div className='space-y-1'>
                      <p className='text-sm font-medium text-foreground'>
                        No results found
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        Try adjusting your search or filters
                      </p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              data.map((row, rowIndex) => (
                <TableRow
                  key={rowIndex}
                  className={cn(
                    'transition-colors duration-200 ease-out',
                    onRowClick && 'cursor-pointer hover:bg-muted/50',
                    rowIndex !== data.length - 1 && 'border-b border-border/30'
                  )}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((column) => (
                    <TableCell key={column.id} className='px-4 py-3 text-sm'>
                      {column.cell
                        ? column.cell(row)
                        : column.accessorFn
                          ? column.accessorFn(row)
                          : column.accessorKey
                            ? (row as any)[column.accessorKey]
                            : null}
                    </TableCell>
                  ))}

                  {actions && actions.length > 0 && (
                    <TableCell
                      className='px-4 py-3 text-right'
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant='ghost'
                            size='sm'
                            className='h-8 transition-colors duration-100'
                          >
                            Actions <ChevronDownIcon className='ml-1 h-4 w-4' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='w-[180px]'>
                          {actions.map((action) => (
                            <DropdownMenuItem
                              key={action.id}
                              onClick={(e) => {
                                e.stopPropagation()
                                action.onClick(row)
                              }}
                              disabled={
                                action.disabled ? action.disabled(row) : false
                              }
                              className={cn(
                                'transition-colors duration-100',
                                action.variant === 'destructive' &&
                                  'text-destructive focus:text-destructive'
                              )}
                            >
                              {action.icon && (
                                <span className='mr-2'>{action.icon}</span>
                              )}
                              {action.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
