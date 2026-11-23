/**
 * Standard Component Template
 *
 * This template provides a starting point for creating standard React components
 * following MarginFront best practices.
 *
 * Usage:
 * 1. Copy this file to your component location
 * 2. Rename the file and component name
 * 3. Add your specific props to the interface
 * 4. Implement your component logic
 * 5. Update className with appropriate Tailwind classes
 *
 * Example:
 * ```tsx
 * import { ComponentName } from '@/components/custom/component-name'
 *
 * <ComponentName className="custom-class">Content</ComponentName>
 * ```
 */
import * as React from 'react'
import { cn } from '@/lib/utils'

interface ComponentNameProps extends React.HTMLAttributes<HTMLDivElement> {
  // Add specific props here
  // Example: variant?: 'default' | 'secondary'
  children?: React.ReactNode
}

export const ComponentName = React.forwardRef<
  HTMLDivElement,
  ComponentNameProps
>(({ className, children, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        'base-classes-here', // Replace with your Tailwind classes
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
})
ComponentName.displayName = 'ComponentName'
