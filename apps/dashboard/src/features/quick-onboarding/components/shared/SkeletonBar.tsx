/**
 * SkeletonBar - Reusable skeleton placeholder component
 * Used in portal preview mocks
 */
import { cn } from '@/lib/utils'

interface SkeletonBarProps {
  width?: string
  height?: string
  className?: string
  rounded?: 'sm' | 'md' | 'lg' | 'full'
}

export const SkeletonBar = ({
  width = '100%',
  height = '0.5rem',
  className,
  rounded = 'full',
}: SkeletonBarProps) => (
  <div
    className={cn(
      'animate-pulse bg-neutral-200',
      rounded === 'sm' && 'rounded-sm',
      rounded === 'md' && 'rounded',
      rounded === 'lg' && 'rounded-lg',
      rounded === 'full' && 'rounded-full',
      className
    )}
    style={{ width, height }}
  />
)

export const SkeletonCircle = ({
  size = '1.5rem',
  className,
}: {
  size?: string
  className?: string
}) => (
  <div
    className={cn('animate-pulse rounded-full bg-neutral-200', className)}
    style={{ width: size, height: size }}
  />
)

export default SkeletonBar
