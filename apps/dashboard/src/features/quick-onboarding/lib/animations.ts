/**
 * Onboarding Animation Variants
 * Sleek, minimal Framer Motion animations
 */
import { Variants, Transition } from 'framer-motion'

// Smooth spring transition
export const smoothSpring: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 30,
}

// Quick ease transition
export const quickEase: Transition = {
  duration: 0.2,
  ease: 'easeOut',
}

// Page/Step transitions
export const pageTransition: Variants = {
  initial: { opacity: 0, y: 20 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] },
  },
  exit: {
    opacity: 0,
    y: -10,
    transition: { duration: 0.2 },
  },
}

// Fade in up animation
export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: 'easeOut' as const },
  },
  exit: {
    opacity: 0,
    y: -10,
    transition: { duration: 0.2 },
  },
}

// Fade in animation
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.3 },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.15 },
  },
}

// Scale fade animation
export const scaleFade: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.3, ease: 'easeOut' as const },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: 0.15 },
  },
}

// Stagger container for list animations
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.1,
    },
  },
}

// Stagger item for list children
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: 'easeOut' as const },
  },
}

// Card hover animation
export const cardHover = {
  scale: 1.02,
  transition: { duration: 0.2 },
}

// Card tap animation
export const cardTap = {
  scale: 0.98,
}

// Button animations
export const buttonHover = {
  scale: 1.02,
  transition: { duration: 0.15 },
}

export const buttonTap = {
  scale: 0.98,
}

// Progress dot animation
export const progressDot: Variants = {
  inactive: {
    scale: 1,
    opacity: 0.5,
  },
  active: {
    scale: 1.2,
    opacity: 1,
    transition: { type: 'spring', stiffness: 400, damping: 20 },
  },
  complete: {
    scale: 1,
    opacity: 1,
  },
}

// Pulse animation for active elements
export const pulse: Variants = {
  animate: {
    scale: [1, 1.05, 1],
    opacity: [0.5, 0.8, 0.5],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
}

// Slide transitions for step navigation
export const slideLeft: Variants = {
  initial: { x: 50, opacity: 0 },
  animate: {
    x: 0,
    opacity: 1,
    transition: { duration: 0.3, ease: 'easeOut' },
  },
  exit: {
    x: -50,
    opacity: 0,
    transition: { duration: 0.2 },
  },
}

export const slideRight: Variants = {
  initial: { x: -50, opacity: 0 },
  animate: {
    x: 0,
    opacity: 1,
    transition: { duration: 0.3, ease: 'easeOut' },
  },
  exit: {
    x: 50,
    opacity: 0,
    transition: { duration: 0.2 },
  },
}

// Success checkmark animation
export const checkmark: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: {
      pathLength: { duration: 0.4, ease: 'easeOut' },
      opacity: { duration: 0.1 },
    },
  },
}

// Loader spin animation (for custom loaders)
export const spin = {
  animate: {
    rotate: 360,
    transition: {
      duration: 1,
      repeat: Infinity,
      ease: 'linear',
    },
  },
}

// Shimmer effect for loading states
export const shimmer: Variants = {
  animate: {
    backgroundPosition: ['200% 0', '-200% 0'],
    transition: {
      duration: 1.5,
      repeat: Infinity,
      ease: 'linear',
    },
  },
}

// Floating animation for decorative elements
export const float: Variants = {
  animate: {
    y: [0, -10, 0],
    transition: {
      duration: 3,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
}

// Bounce animation for attention
export const bounce: Variants = {
  animate: {
    y: [0, -8, 0],
    transition: {
      duration: 0.6,
      repeat: 2,
      ease: 'easeOut',
    },
  },
}
