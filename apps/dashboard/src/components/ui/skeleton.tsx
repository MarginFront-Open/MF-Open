import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const skeletonVariants = cva(
  'relative overflow-hidden rounded-md bg-muted/50',
  {
    variants: {
      variant: {
        default: 'bg-muted/50',
        card: 'bg-card border border-border/50',
        text: 'bg-muted/50 h-4',
        circle: 'bg-muted/50 rounded-full',
        avatar: 'bg-muted/50 rounded-full h-10 w-10',
        button: 'bg-muted/50 h-9 rounded-md',
        badge: 'bg-muted/50 h-6 rounded-full w-16',
      },
      size: {
        sm: 'h-3',
        md: 'h-4',
        lg: 'h-6',
        xl: 'h-8',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface SkeletonProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof skeletonVariants> {
  /**
   * Whether to show the shimmer animation
   * @default true
   */
  animate?: boolean
}

/**
 * Skeleton - A loading placeholder component with shimmer animation
 *
 * @example
 * ```tsx
 * <Skeleton className="h-4 w-full" />
 * <Skeleton variant="avatar" />
 * <Skeleton variant="text" size="lg" />
 * ```
 */
const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, variant, size, animate = true, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(skeletonVariants({ variant, size }), className)}
        {...props}
      >
        {animate && (
          <div className='absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent dark:via-white/5' />
        )}
      </div>
    )
  }
)
Skeleton.displayName = 'Skeleton'

export { Skeleton, skeletonVariants }
