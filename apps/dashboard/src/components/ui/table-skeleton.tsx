import * as React from 'react'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table'

export interface TableSkeletonProps {
  /**
   * Number of skeleton rows to display
   * @default 5
   */
  rows?: number
  /**
   * Number of columns to display
   * @default 4
   */
  columns?: number
  /**
   * Whether to show an actions column
   * @default false
   */
  showActions?: boolean
  /**
   * Custom column widths (array of width classes or numbers)
   * @example ['w-32', 'w-48', 'w-64', 'w-32']
   */
  columnWidths?: string[]
  /**
   * Additional className for the table container
   */
  className?: string
  /**
   * Whether to show the table header
   * @default true
   */
  showHeader?: boolean
  /**
   * Header labels (optional, will use default if not provided)
   */
  headerLabels?: string[]
}

/**
 * TableSkeleton - A reusable skeleton component for table loading states
 *
 * Matches the color theming and provides a consistent loading experience
 *
 * @example
 * ```tsx
 * <TableSkeleton rows={5} columns={4} showActions />
 * <TableSkeleton
 *   rows={10}
 *   columns={5}
 *   columnWidths={['w-32', 'w-48', 'w-64', 'w-32', 'w-24']}
 * />
 * ```
 */
export const TableSkeleton = React.forwardRef<
  HTMLDivElement,
  TableSkeletonProps
>(
  (
    {
      rows = 5,
      columns = 4,
      showActions = false,
      columnWidths,
      className,
      showHeader = true,
      headerLabels,
    },
    ref
  ) => {
    const numColumns = columns + (showActions ? 1 : 0)

    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg border border-border/50 bg-card shadow-sm',
          className
        )}
      >
        <div className='overflow-x-auto'>
          <Table>
            {showHeader && (
              <TableHeader>
                <TableRow className='border-b border-border/50 hover:bg-transparent'>
                  {Array.from({ length: columns }).map((_, index) => (
                    <TableHead
                      key={index}
                      className='px-4 py-3 font-semibold text-foreground'
                    >
                      {headerLabels?.[index] || (
                        <Skeleton variant='text' className='h-4 w-24' />
                      )}
                    </TableHead>
                  ))}
                  {showActions && (
                    <TableHead className='px-4 py-3 text-right font-semibold text-foreground'>
                      {headerLabels?.[columns] || 'Actions'}
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
            )}
            <TableBody>
              {Array.from({ length: rows }).map((_, rowIndex) => (
                <TableRow
                  key={rowIndex}
                  className={cn(
                    'border-b border-border/30',
                    rowIndex === rows - 1 && 'border-b-0'
                  )}
                >
                  {Array.from({ length: columns }).map((_, colIndex) => {
                    const width = columnWidths?.[colIndex] || 'max-w-[200px]'
                    return (
                      <TableCell key={colIndex} className='px-4 py-3'>
                        <Skeleton
                          variant='text'
                          className={cn('h-4 w-full', width)}
                        />
                      </TableCell>
                    )
                  })}
                  {showActions && (
                    <TableCell className='px-4 py-3 text-right'>
                      <Skeleton variant='button' className='ml-auto h-8 w-20' />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    )
  }
)

TableSkeleton.displayName = 'TableSkeleton'
