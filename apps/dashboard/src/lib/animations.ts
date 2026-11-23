/**
 * Animation Utilities - Framer Motion
 *
 * Common animation variants, timing constants, and easing functions
 * for consistent animations throughout the app.
 */
import { Variants, Transition } from 'framer-motion'

// ============================================================================
// TIMING CONSTANTS
// ============================================================================

export const DURATIONS = {
  instant: 0,
  fast: 0.2, // 200ms - micro-interactions (hover, focus)
  base: 0.25, // 250ms - standard transitions (DEFAULT)
  slow: 0.4, // 400ms - layout changes (sidebar, modals)
  slower: 0.6, // 600ms - page transitions
} as const

export const EASING = {
  easeOut: [0.16, 1, 0.3, 1],

  easeInOut: [0.4, 0, 0.2, 1], // Material Design standard

  easeIn: [0.4, 0, 1, 1],

  smooth: [0.25, 0.46, 0.45, 0.94], // ease-out-quad

  // Overshoots past 1 before settling.
  spring: [0.34, 1.56, 0.64, 1],

  smoothOut: [0.22, 1, 0.36, 1],
} as const

// ============================================================================
// COMMON TRANSITIONS
// ============================================================================

export const transitions = {
  fast: {
    duration: DURATIONS.fast,
    ease: EASING.easeOut,
  } as Transition,

  base: {
    duration: DURATIONS.base,
    ease: EASING.easeOut,
  } as Transition,

  slow: {
    duration: DURATIONS.slow,
    ease: EASING.easeInOut,
  } as Transition,

  spring: {
    type: 'spring' as const,
    stiffness: 300,
    damping: 30,
    mass: 0.8,
  } as Transition,

  springSmooth: {
    type: 'spring' as const,
    stiffness: 200,
    damping: 25,
    mass: 1,
  } as Transition,
} as const

// ============================================================================
// FADE ANIMATIONS
// ============================================================================

export const fadeIn: Variants = {
  initial: {
    opacity: 0,
  },
  animate: {
    opacity: 1,
    transition: {
      ...transitions.base,
      ease: EASING.smoothOut,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      ...transitions.fast,
      ease: EASING.easeIn,
    },
  },
}

export const fadeInUp: Variants = {
  initial: {
    opacity: 0,
    y: 12,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      ...transitions.base,
      ease: EASING.smoothOut,
    },
  },
  exit: {
    opacity: 0,
    y: -12,
    transition: {
      ...transitions.fast,
      ease: EASING.easeIn,
    },
  },
}

export const fadeInDown: Variants = {
  initial: {
    opacity: 0,
    y: -12,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      ...transitions.base,
      ease: EASING.smoothOut,
    },
  },
  exit: {
    opacity: 0,
    y: 12,
    transition: {
      ...transitions.fast,
      ease: EASING.easeIn,
    },
  },
}

// ============================================================================
// SLIDE ANIMATIONS
// ============================================================================

export const slideInRight: Variants = {
  initial: {
    x: '100%',
    opacity: 0,
  },
  animate: {
    x: 0,
    opacity: 1,
    transition: transitions.slow,
  },
  exit: {
    x: '100%',
    opacity: 0,
    transition: transitions.fast,
  },
}

export const slideInLeft: Variants = {
  initial: {
    x: '-100%',
    opacity: 0,
  },
  animate: {
    x: 0,
    opacity: 1,
    transition: {
      ...transitions.slow,
      ease: EASING.smoothOut,
    },
  },
  exit: {
    x: '-100%',
    opacity: 0,
    transition: {
      ...transitions.fast,
      ease: EASING.easeIn,
    },
  },
}

export const slideInUp: Variants = {
  initial: {
    y: '100%',
    opacity: 0,
  },
  animate: {
    y: 0,
    opacity: 1,
    transition: transitions.slow,
  },
  exit: {
    y: '100%',
    opacity: 0,
    transition: transitions.fast,
  },
}

export const slideInDown: Variants = {
  initial: {
    y: '-100%',
    opacity: 0,
  },
  animate: {
    y: 0,
    opacity: 1,
    transition: transitions.slow,
  },
  exit: {
    y: '-100%',
    opacity: 0,
    transition: transitions.fast,
  },
}

// ============================================================================
// SCALE ANIMATIONS
// ============================================================================

export const scaleIn: Variants = {
  initial: {
    scale: 0.9,
    opacity: 0,
  },
  animate: {
    scale: 1,
    opacity: 1,
    transition: transitions.base,
  },
  exit: {
    scale: 0.9,
    opacity: 0,
    transition: transitions.fast,
  },
}

export const scaleUp: Variants = {
  initial: {
    scale: 0.95,
    opacity: 0,
  },
  animate: {
    scale: 1,
    opacity: 1,
    transition: transitions.base,
  },
  exit: {
    scale: 1.05,
    opacity: 0,
    transition: transitions.fast,
  },
}

// ============================================================================
// MODAL/DIALOG ANIMATIONS
// ============================================================================

export const modalBackdrop: Variants = {
  initial: {
    opacity: 0,
  },
  animate: {
    opacity: 1,
    transition: transitions.slow,
  },
  exit: {
    opacity: 0,
    transition: transitions.fast,
  },
}

export const modalContent: Variants = {
  initial: {
    scale: 0.95,
    opacity: 0,
    y: 10,
  },
  animate: {
    scale: 1,
    opacity: 1,
    y: 0,
    transition: transitions.slow,
  },
  exit: {
    scale: 0.95,
    opacity: 0,
    y: 10,
    transition: transitions.fast,
  },
}

export const sheetContent: Variants = {
  initial: {
    x: '100%',
  },
  animate: {
    x: 0,
    transition: transitions.slow,
  },
  exit: {
    x: '100%',
    transition: transitions.fast,
  },
}

// ============================================================================
// DROPDOWN/POPOVER ANIMATIONS
// ============================================================================

export const dropdownContent: Variants = {
  initial: {
    opacity: 0,
    scale: 0.95,
    y: -10,
  },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: transitions.fast,
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: -10,
    transition: { duration: DURATIONS.fast },
  },
}

export const popoverContent: Variants = {
  initial: {
    opacity: 0,
    scale: 0.96,
  },
  animate: {
    opacity: 1,
    scale: 1,
    transition: transitions.fast,
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: DURATIONS.fast },
  },
}

// ============================================================================
// LIST/STAGGER ANIMATIONS
// ============================================================================

export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
  exit: {
    transition: {
      staggerChildren: 0.02,
      staggerDirection: -1,
    },
  },
}

export const staggerItem: Variants = {
  initial: {
    opacity: 0,
    y: 12,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      ...transitions.base,
      ease: EASING.smoothOut,
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: {
      duration: DURATIONS.fast,
      ease: EASING.easeIn,
    },
  },
}

export const staggerItemFast: Variants = {
  initial: {
    opacity: 0,
    y: 10,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: transitions.fast,
  },
  exit: {
    opacity: 0,
    y: -5,
    transition: { duration: DURATIONS.fast },
  },
}

// ============================================================================
// PAGE TRANSITIONS
// ============================================================================

export const pageTransition: Variants = {
  initial: {
    opacity: 0,
    y: 10,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: DURATIONS.slower,
      ease: EASING.smoothOut,
    },
  },
  exit: {
    opacity: 0,
    y: -10,
    transition: {
      duration: DURATIONS.base,
      ease: EASING.easeIn,
    },
  },
}

export const pageTransitionSlide: Variants = {
  initial: {
    x: 20,
    opacity: 0,
  },
  animate: {
    x: 0,
    opacity: 1,
    transition: {
      duration: DURATIONS.slow,
      ease: EASING.easeOut,
    },
  },
  exit: {
    x: -20,
    opacity: 0,
    transition: {
      duration: DURATIONS.fast,
      ease: EASING.easeIn,
    },
  },
}

// ============================================================================
// CARD ANIMATIONS
// ============================================================================

export const cardHover = {
  scale: 1.02,
  y: -4,
  transition: {
    ...transitions.fast,
    ease: EASING.smoothOut,
  },
}

export const cardTap = {
  scale: 0.98,
  transition: {
    duration: DURATIONS.fast,
    ease: EASING.easeOut,
  },
}

export const cardInteractive: Variants = {
  initial: {},
  hover: cardHover,
  tap: cardTap,
}

// ============================================================================
// BUTTON ANIMATIONS
// ============================================================================

export const buttonTap = {
  scale: 0.98,
  transition: { duration: DURATIONS.fast },
}

export const buttonHover = {
  scale: 1.02,
  transition: transitions.fast,
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Create a custom stagger container with configurable delay
 */
export function createStaggerContainer(
  staggerDelay: number = 0.05,
  delayChildren: number = 0
): Variants {
  return {
    initial: {},
    animate: {
      transition: {
        staggerChildren: staggerDelay,
        delayChildren,
      },
    },
    exit: {
      transition: {
        staggerChildren: staggerDelay * 0.6,
        staggerDirection: -1,
      },
    },
  }
}

/**
 * Create a custom fade in animation with configurable y offset
 */
export function createFadeIn(yOffset: number = 20): Variants {
  return {
    initial: {
      opacity: 0,
      y: yOffset,
    },
    animate: {
      opacity: 1,
      y: 0,
      transition: transitions.base,
    },
    exit: {
      opacity: 0,
      y: -yOffset / 2,
      transition: { duration: DURATIONS.fast },
    },
  }
}

/**
 * Respect user's motion preferences
 * Returns true if user prefers reduced motion
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Get animation variants that respect user preferences
 * If user prefers reduced motion, returns instant variants
 */
export function getAnimationVariants(variants: Variants): Variants {
  if (prefersReducedMotion()) {
    // Return variants with no animation
    return {
      initial: variants.animate,
      animate: variants.animate,
      exit: variants.animate,
    }
  }
  return variants
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { Variants, Transition }
