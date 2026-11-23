/**
 * AnimatedCard Component
 *
 * Card component with smooth hover and tap animations.
 * Use this for interactive cards that need premium feel.
 *
 * Usage:
 * <AnimatedCard onClick={handleClick}>
 *   <CardHeader>...</CardHeader>
 *   <CardContent>...</CardContent>
 * </AnimatedCard>
 */
import { motion } from 'framer-motion'
import {
  cardInteractive,
  getAnimationVariants,
  EASING,
  DURATIONS,
} from '@/lib/animations'
import { cn } from '@/lib/utils'
import { Card, type CardProps } from '@/components/ui/card'

interface AnimatedCardProps extends CardProps {
  /**
   * Enable hover and tap animations
   * @default true
   */
  animated?: boolean

  /**
   * Custom hover scale
   * @default 1.02
   */
  hoverScale?: number

  /**
   * Custom tap scale
   * @default 0.98
   */
  tapScale?: number
}

export function AnimatedCard({
  children,
  className,
  animated = true,
  hoverScale = 1.02,
  tapScale = 0.98,
  ...props
}: AnimatedCardProps) {
  const variants = animated ? getAnimationVariants(cardInteractive) : undefined

  if (!animated) {
    return (
      <Card className={className} {...props}>
        {children}
      </Card>
    )
  }

  return (
    <motion.div
      variants={variants}
      whileHover={{
        scale: hoverScale,
        y: -4,
        transition: {
          duration: DURATIONS.fast,
          ease: EASING.smoothOut, // Use smoother easing
        },
      }}
      whileTap={{
        scale: tapScale,
        transition: {
          duration: DURATIONS.fast,
          ease: EASING.easeOut, // Use smoother easing
        },
      }}
      className={cn('cursor-pointer', className)}
    >
      <Card {...props}>{children}</Card>
    </motion.div>
  )
}

/**
 * AnimatedCardLink Component
 *
 * Card that behaves like a link with hover effects
 */

interface AnimatedCardLinkProps extends AnimatedCardProps {
  href?: string
  onClick?: () => void
}

export function AnimatedCardLink({
  children,
  href,
  onClick,
  className,
  ...props
}: AnimatedCardLinkProps) {
  const handleClick = () => {
    if (onClick) {
      onClick()
    } else if (href) {
      window.location.href = href
    }
  }

  return (
    <AnimatedCard
      className={cn('transition-colors hover:border-primary/50', className)}
      onClick={handleClick}
      {...props}
    >
      {children}
    </AnimatedCard>
  )
}
