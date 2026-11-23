/**
 * GlassCard Component
 * Reusable glassmorphism card for onboarding UI
 */
'use client'

import { forwardRef, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * GlassCard Component
 * Reusable glassmorphism card for onboarding UI
 */

export interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Card variant */
  variant?: 'default' | 'outlined' | 'filled' | 'elevated'
  /** Whether the card is interactive (hover effects) */
  interactive?: boolean
  /** Whether the card is currently selected */
  selected?: boolean
  /** Whether the card is disabled */
  disabled?: boolean
  /** Glow color for selected state */
  glowColor?: 'gold' | 'lime' | 'blue' | 'purple'
  /** Card size */
  size?: 'sm' | 'md' | 'lg'
  /** Content */
  children: ReactNode
}

const variantClasses = {
  default: 'bg-card/80 backdrop-blur-xl border border-border/50',
  outlined: 'bg-transparent backdrop-blur-sm border-2 border-border',
  filled: 'bg-muted backdrop-blur-xl border border-border/30',
  elevated: 'bg-card backdrop-blur-2xl border border-border shadow-xl',
}

const sizeClasses = {
  sm: 'p-4 rounded-xl',
  md: 'p-6 rounded-2xl',
  lg: 'p-8 rounded-3xl',
}

const glowClasses = {
  gold: 'ring-amber-500/30 shadow-amber-500/20',
  lime: 'ring-secondary/30 shadow-secondary/20',
  blue: 'ring-blue-500/30 shadow-blue-500/20',
  purple: 'ring-purple-500/30 shadow-purple-500/20',
}

const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  (
    {
      variant = 'default',
      interactive = false,
      selected = false,
      disabled = false,
      glowColor = 'lime',
      size = 'md',
      className,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          // Base styles
          'relative transition-all duration-300',
          variantClasses[variant],
          sizeClasses[size],

          // Interactive styles
          interactive &&
            !disabled && [
              'cursor-pointer',
              'hover:bg-muted',
              'hover:border-border',
              'hover:scale-[1.02]',
              'hover:shadow-lg',
            ],

          // Selected styles
          selected && [
            'ring-2',
            glowClasses[glowColor],
            'shadow-lg',
            'border-primary/50',
          ],

          // Disabled styles
          disabled && [
            'opacity-50',
            'cursor-not-allowed',
            'pointer-events-none',
          ],

          className
        )}
        {...props}
      >
        {/* Gradient overlay for depth */}
        <div
          className='pointer-events-none absolute inset-0 rounded-[inherit] bg-gradient-to-br from-foreground/5 to-transparent'
          aria-hidden='true'
        />

        {/* Content */}
        <div className='relative z-10'>{children}</div>

        {/* Selected indicator */}
        {selected && (
          <div
            className={cn(
              'absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full',
              'bg-primary text-primary-foreground shadow-lg',
              'duration-200 animate-in zoom-in-50'
            )}
          >
            <svg
              className='h-4 w-4'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M5 13l4 4L19 7'
              />
            </svg>
          </div>
        )}
      </div>
    )
  }
)

GlassCard.displayName = 'GlassCard'

// ============================================
// GLASS CARD HEADER
// ============================================

export interface GlassCardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode
  title: string
  subtitle?: string
  badge?: ReactNode
}

export const GlassCardHeader = ({
  icon,
  title,
  subtitle,
  badge,
  className,
  ...props
}: GlassCardHeaderProps) => (
  <div className={cn('mb-4 flex items-start gap-4', className)} {...props}>
    {icon && (
      <div className='flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-muted text-2xl'>
        {icon}
      </div>
    )}
    <div className='min-w-0 flex-1'>
      <div className='flex items-center gap-2'>
        <h3 className='truncate text-lg font-semibold text-foreground'>
          {title}
        </h3>
        {badge}
      </div>
      {subtitle && (
        <p className='mt-0.5 text-sm text-muted-foreground'>{subtitle}</p>
      )}
    </div>
  </div>
)

// ============================================
// GLASS CARD CONTENT
// ============================================

export interface GlassCardContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export const GlassCardContent = ({
  className,
  children,
  ...props
}: GlassCardContentProps) => (
  <div className={cn('text-foreground/80', className)} {...props}>
    {children}
  </div>
)

// ============================================
// GLASS CARD FOOTER
// ============================================

export interface GlassCardFooterProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export const GlassCardFooter = ({
  className,
  children,
  ...props
}: GlassCardFooterProps) => (
  <div
    className={cn(
      'mt-4 flex items-center justify-between border-t border-border pt-4',
      className
    )}
    {...props}
  >
    {children}
  </div>
)

// ============================================
// BADGE COMPONENT
// ============================================

export interface GlassBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'info'
  children: ReactNode
}

const badgeVariants = {
  default: 'bg-muted text-foreground',
  success: 'bg-secondary/20 text-secondary-foreground dark:text-secondary',
  warning: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
  info: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
}

export const GlassBadge = ({
  variant = 'default',
  className,
  children,
  ...props
}: GlassBadgeProps) => (
  <span
    className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
      badgeVariants[variant],
      className
    )}
    {...props}
  >
    {children}
  </span>
)

export default GlassCard
