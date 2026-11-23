import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader } from './card'
import { Skeleton } from './skeleton'

export interface CardSkeletonProps {
  /**
   * Number of skeleton lines to display
   * @default 3
   */
  lines?: number
  /**
   * Whether to show a header skeleton
   * @default true
   */
  showHeader?: boolean
  /**
   * Additional className for the card container
   */
  className?: string
  /**
   * Height of the card
   * @default 'auto'
   */
  height?: 'sm' | 'md' | 'lg' | 'auto'
}

/**
 * CardSkeleton - A reusable skeleton component for card loading states
 *
 * @example
 * ```tsx
 * <CardSkeleton lines={4} showHeader />
 * <CardSkeleton height="lg" />
 * ```
 */
export const CardSkeleton = React.forwardRef<HTMLDivElement, CardSkeletonProps>(
  ({ lines = 3, showHeader = true, className, height = 'auto' }, ref) => {
    const heightClasses = {
      sm: 'h-32',
      md: 'h-48',
      lg: 'h-64',
      auto: '',
    }

    return (
      <Card
        ref={ref}
        className={cn('border-border/50', heightClasses[height], className)}
      >
        {showHeader && (
          <CardHeader>
            <Skeleton className='h-6 w-48' />
            <Skeleton className='mt-2 h-4 w-32' />
          </CardHeader>
        )}
        <CardContent className='space-y-3'>
          {Array.from({ length: lines }).map((_, index) => (
            <Skeleton
              key={index}
              variant='text'
              className={cn('h-4', index === lines - 1 ? 'w-3/4' : 'w-full')}
            />
          ))}
        </CardContent>
      </Card>
    )
  }
)

CardSkeleton.displayName = 'CardSkeleton'
