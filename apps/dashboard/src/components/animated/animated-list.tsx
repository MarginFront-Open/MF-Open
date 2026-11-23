/**
 * AnimatedList Component
 *
 * Container component that adds stagger animations to child elements.
 * Perfect for lists, tables, and any collection of items.
 *
 * Usage:
 * <AnimatedList>
 *   <AnimatedListItem>Item 1</AnimatedListItem>
 *   <AnimatedListItem>Item 2</AnimatedListItem>
 *   <AnimatedListItem>Item 3</AnimatedListItem>
 * </AnimatedList>
 */
import { motion } from 'framer-motion'
import {
  staggerContainer,
  staggerItem,
  staggerItemFast,
  createStaggerContainer,
  getAnimationVariants,
} from '@/lib/animations'

interface AnimatedListProps {
  children: React.ReactNode
  className?: string

  /**
   * Delay between each item animation (in seconds)
   * @default 0.05
   */
  staggerDelay?: number

  /**
   * Delay before starting the stagger animation (in seconds)
   * @default 0
   */
  delayChildren?: number

  /**
   * Use faster animation timing
   * @default false
   */
  fast?: boolean
}

export function AnimatedList({
  children,
  className,
  staggerDelay = 0.05,
  delayChildren = 0,
  fast: _fast = false,
}: AnimatedListProps) {
  const containerVariants =
    staggerDelay === 0.05 && delayChildren === 0
      ? getAnimationVariants(staggerContainer)
      : getAnimationVariants(
          createStaggerContainer(staggerDelay, delayChildren)
        )

  return (
    <motion.div
      initial='initial'
      animate='animate'
      exit='exit'
      variants={containerVariants}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/**
 * AnimatedListItem Component
 *
 * Individual item within AnimatedList
 * Automatically animates when parent AnimatedList mounts
 */

interface AnimatedListItemProps {
  children: React.ReactNode
  className?: string

  /**
   * Use faster animation timing
   * @default false
   */
  fast?: boolean
}

export function AnimatedListItem({
  children,
  className,
  fast = false,
}: AnimatedListItemProps) {
  const itemVariants = getAnimationVariants(
    fast ? staggerItemFast : staggerItem
  )

  return (
    <motion.div variants={itemVariants} className={className}>
      {children}
    </motion.div>
  )
}

/**
 * AnimatedTableRow Component
 *
 * Specialized list item for table rows
 * Optimized for tabular data with minimal y-offset
 */

export function AnimatedTableRow({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <motion.tr
      variants={{
        initial: { opacity: 0, y: 10 },
        animate: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.2, ease: [0, 0, 0.2, 1] },
        },
        exit: {
          opacity: 0,
          y: -5,
          transition: { duration: 0.15 },
        },
      }}
      className={className}
    >
      {children}
    </motion.tr>
  )
}
