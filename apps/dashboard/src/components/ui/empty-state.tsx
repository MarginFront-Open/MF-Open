import { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export interface EmptyStateProps {
  /**
   * Icon to display (optional)
   */
  icon?: ReactNode

  /**
   * Title/heading text
   */
  title: string

  /**
   * Description text (optional)
   */
  description?: string

  /**
   * Action button configuration (optional)
   */
  action?: {
    label: string
    onClick: () => void
    variant?: 'default' | 'outline' | 'ghost'
  }

  /**
   * Variant of empty state
   */
  variant?: 'default' | 'dashed' | 'minimal'

  /**
   * Size variant
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Additional className
   */
  className?: string
}

/**
 * EmptyState Component
 *
 * A reusable component for displaying empty states across the application.
 * Supports different variants, sizes, and optional actions.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <EmptyState
 *   title="No data found"
 *   description="Try adjusting your filters"
 * />
 *
 * // With icon and action
 * <EmptyState
 *   icon={<IconUsers className="h-12 w-12" />}
 *   title="No customers yet"
 *   description="Create your first customer to get started"
 *   action={{
 *     label: "Create Customer",
 *     onClick: () => navigate('/customers/new')
 *   }}
 * />
 *
 * // Dashed variant (for placeholders)
 * <EmptyState
 *   variant="dashed"
 *   title="Coming Soon"
 *   description="This feature is under development"
 * />
 * ```
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'default',
  size = 'md',
  className,
}: EmptyStateProps) {
  // Size configurations
  const sizeConfig = {
    sm: {
      container: 'py-6',
      icon: 'h-8 w-8 mb-3',
      title: 'text-sm',
      description: 'text-xs',
    },
    md: {
      container: 'py-8',
      icon: 'h-10 w-10 mb-4',
      title: 'text-base',
      description: 'text-sm',
    },
    lg: {
      container: 'py-12',
      icon: 'h-12 w-12 mb-4',
      title: 'text-lg',
      description: 'text-base',
    },
  }

  const config = sizeConfig[size]

  // Variant styles
  const variantClasses = {
    default: 'border-border/50 shadow-sm',
    dashed: 'border-dashed border-border/50 bg-muted/20',
    minimal: 'border-none shadow-none',
  }

  return (
    <Card
      className={cn(
        variantClasses[variant],
        'animate-in fade-in slide-in-from-bottom-4',
        className
      )}
      style={{ animationDuration: '500ms' }}
    >
      <CardContent className={cn('text-center', config.container)}>
        {icon && (
          <div
            className={cn(
              'mx-auto flex items-center justify-center rounded-full bg-gradient-to-br from-muted to-muted/50 text-muted-foreground animate-in zoom-in',
              config.icon
            )}
            style={{ animationDelay: '100ms', animationDuration: '400ms' }}
          >
            {icon}
          </div>
        )}

        <div
          className='animate-in fade-in slide-in-from-bottom-2'
          style={{ animationDelay: '200ms' }}
        >
          <h3 className={cn('mb-1 font-semibold', config.title)}>{title}</h3>

          {description && (
            <p
              className={cn(
                'mt-1 leading-relaxed text-muted-foreground',
                config.description
              )}
            >
              {description}
            </p>
          )}
        </div>

        {action && (
          <Button
            variant={action.variant || 'outline'}
            size='sm'
            onClick={action.onClick}
            className='mt-4 animate-in fade-in slide-in-from-bottom-2'
            style={{ animationDelay: '300ms' }}
          >
            {action.label}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Specialized empty state variants for common use cases
 */
export const EmptyStates = {
  /**
   * For when data exists but was filtered out
   */
  NoResults: ({
    entity = 'results',
    onClear,
  }: {
    entity?: string
    onClear?: () => void
  }) => (
    <EmptyState
      title={`No ${entity} found`}
      description='Try adjusting your filters or search'
      action={
        onClear
          ? {
              label: 'Clear filters',
              onClick: onClear,
              variant: 'outline',
            }
          : undefined
      }
      variant='minimal'
      size='md'
    />
  ),

  /**
   * For when user hasn't created any items yet
   */
  NeverCreated: ({
    entity,
    onCreate,
    icon,
  }: {
    entity: string
    onCreate: () => void
    icon?: ReactNode
  }) => (
    <EmptyState
      icon={icon}
      title={`No ${entity} yet`}
      description={`Create your first ${entity} to get started`}
      action={{
        label: `Create ${entity}`,
        onClick: onCreate,
      }}
      variant='dashed'
      size='lg'
    />
  ),

  /**
   * For features coming soon
   */
  ComingSoon: ({ feature }: { feature?: string }) => (
    <EmptyState
      title={feature ? `${feature} Coming Soon` : 'Coming Soon'}
      description='This feature is currently under development'
      variant='dashed'
      size='md'
    />
  ),

  /**
   * For error/not found states
   */
  NotFound: ({ entity = 'item' }: { entity?: string }) => (
    <EmptyState
      title={`${entity} not found`}
      description="The item you're looking for doesn't exist or has been removed"
      variant='minimal'
      size='md'
    />
  ),
}
