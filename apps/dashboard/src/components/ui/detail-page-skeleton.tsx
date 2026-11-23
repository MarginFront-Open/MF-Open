import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader } from './card'
import { Skeleton } from './skeleton'

export interface DetailPageSkeletonProps {
  /**
   * Whether to show header skeleton
   * @default true
   */
  showHeader?: boolean
  /**
   * Number of stat cards to show
   * @default 4
   */
  statCards?: number
  /**
   * Whether to show chart skeleton
   * @default true
   */
  showChart?: boolean
  /**
   * Additional className
   */
  className?: string
}

/**
 * DetailPageSkeleton - A comprehensive skeleton for detail pages
 *
 * @example
 * ```tsx
 * <DetailPageSkeleton statCards={4} showChart />
 * ```
 */
export const DetailPageSkeleton = React.forwardRef<
  HTMLDivElement,
  DetailPageSkeletonProps
>(({ showHeader = true, statCards = 4, showChart = true, className }, ref) => {
  return (
    <div ref={ref} className={cn('space-y-6', className)}>
      {/* Header Skeleton */}
      {showHeader && (
        <div className='space-y-4'>
          <Skeleton className='h-8 w-64' />
          <Skeleton className='h-4 w-96' />
        </div>
      )}

      {/* Stats Cards Grid */}
      <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-4'>
        {Array.from({ length: statCards }).map((_, index) => (
          <Card key={index} className='border-border/50'>
            <CardHeader className='pb-2'>
              <Skeleton className='h-4 w-24' />
            </CardHeader>
            <CardContent>
              <Skeleton className='mb-2 h-8 w-32' />
              <Skeleton className='h-3 w-20' />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Chart Skeleton */}
      {showChart && (
        <Card className='border-border/50'>
          <CardHeader>
            <Skeleton className='h-6 w-48' />
            <Skeleton className='mt-2 h-4 w-32' />
          </CardHeader>
          <CardContent>
            <Skeleton className='h-64 w-full rounded-md' />
          </CardContent>
        </Card>
      )}

      {/* Additional Content Skeleton */}
      <div className='grid gap-4 md:grid-cols-2'>
        <Card className='border-border/50'>
          <CardHeader>
            <Skeleton className='h-6 w-40' />
          </CardHeader>
          <CardContent className='space-y-3'>
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className='flex items-center justify-between'>
                <Skeleton className='h-4 w-32' />
                <Skeleton className='h-4 w-24' />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className='border-border/50'>
          <CardHeader>
            <Skeleton className='h-6 w-40' />
          </CardHeader>
          <CardContent className='space-y-3'>
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className='flex items-center justify-between'>
                <Skeleton className='h-4 w-32' />
                <Skeleton className='h-4 w-24' />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
})

DetailPageSkeleton.displayName = 'DetailPageSkeleton'
