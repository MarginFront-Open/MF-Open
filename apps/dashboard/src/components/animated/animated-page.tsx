/**
 * AnimatedPage Component
 *
 * Wrapper component that adds smooth page transitions
 * when navigating between routes.
 *
 * Usage:
 * <AnimatedPage>
 *   <YourPageContent />
 * </AnimatedPage>
 */
import { motion } from 'framer-motion'
import {
  pageTransition,
  pageTransitionSlide,
  getAnimationVariants,
} from '@/lib/animations'

interface AnimatedPageProps {
  children: React.ReactNode
  className?: string
}

export function AnimatedPage({ children, className }: AnimatedPageProps) {
  const variants = getAnimationVariants(pageTransition)

  return (
    <motion.div
      initial='initial'
      animate='animate'
      exit='exit'
      variants={variants}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/**
 * AnimatedPageSlide Component
 *
 * Alternative page transition with horizontal slide effect
 */

export function AnimatedPageSlide({ children, className }: AnimatedPageProps) {
  const variants = getAnimationVariants(pageTransitionSlide)

  return (
    <motion.div
      initial='initial'
      animate='animate'
      exit='exit'
      variants={variants}
      className={className}
    >
      {children}
    </motion.div>
  )
}
