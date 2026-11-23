// @ts-nocheck

/**
 * Variant-Based Component Template (with CVA)
 *
 * This template provides a starting point for creating components with multiple
 * visual variants using class-variance-authority (CVA).
 *
 * Usage:
 * 1. Copy this file to your component location
 * 2. Rename the file and component name
 * 3. Define your variants in the componentVariants object
 * 4. Update the interface to include variant props
 * 5. Implement your component logic
 *
 * Example:
 * ```tsx
 * import { ComponentName } from '@/components/custom/component-name'
 *
 * <ComponentName variant="secondary" size="lg">Content</ComponentName>
 * ```
 */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const componentVariants = cva(
  'base-classes-here', // Base classes applied to all variants
  {
    variants: {
      variant: {
        default: 'variant-default-classes',
        secondary: 'variant-secondary-classes',
        destructive: 'variant-destructive-classes',
        outline: 'variant-outline-classes',
      },
      size: {
        default: 'size-default-classes',
        sm: 'size-sm-classes',
        lg: 'size-lg-classes',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

interface ComponentProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof componentVariants> {
  children?: React.ReactNode
}

export const Component = React.forwardRef<HTMLDivElement, ComponentProps>(
  ({ className, variant, size, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(componentVariants({ variant, size, className }))}
        {...props}
      >
        {children}
      </div>
    )
  }
)
Component.displayName = 'Component'
