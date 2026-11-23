/**
 * StepIndicator Component
 * Animated phase progress indicator (three phases by default)
 */
'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'

/**
 * StepIndicator Component
 * Animated phase progress indicator (three phases by default)
 */

export interface StepIndicatorProps {
  /** Current phase index, 0-based */
  currentPhase: number
  /** Phase labels */
  phases?: string[]
  /** Show labels on mobile */
  showLabelsOnMobile?: boolean
  /** Additional class name */
  className?: string
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
}

const DEFAULT_PHASES = ['Connect', 'Configure', 'Integrate']

const StepIndicator = ({
  currentPhase,
  phases = DEFAULT_PHASES,
  showLabelsOnMobile = true,
  className,
  size = 'md',
}: StepIndicatorProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  // Size configurations
  const sizeConfig = {
    sm: {
      circle: 'w-7 h-7',
      icon: 'w-3.5 h-3.5',
      text: 'text-[11px]',
      number: 'text-xs',
      gap: 'gap-2',
      lineWidth: 'w-8 sm:w-12',
      lineMargin: 'mx-2',
    },
    md: {
      circle: 'w-9 h-9',
      icon: 'w-4 h-4',
      text: 'text-xs',
      number: 'text-sm',
      gap: 'gap-2.5',
      lineWidth: 'w-12 sm:w-20 lg:w-24',
      lineMargin: 'mx-3',
    },
    lg: {
      circle: 'w-11 h-11',
      icon: 'w-5 h-5',
      text: 'text-sm',
      number: 'text-base',
      gap: 'gap-3',
      lineWidth: 'w-16 sm:w-24 lg:w-32',
      lineMargin: 'mx-4',
    },
  }

  const config = sizeConfig[size]

  return (
    <div className={cn('w-full', className)}>
      <div className='flex items-center justify-center'>
        {phases.map((phase, index) => {
          const isCompleted = index < currentPhase
          const isCurrent = index === currentPhase
          const isPending = index > currentPhase
          const isLast = index === phases.length - 1

          return (
            <div key={phase} className='flex items-center'>
              {/* Step item */}
              <div className={cn('flex flex-col items-center', config.gap)}>
                {/* Circle indicator with number/check */}
                <div className='relative'>
                  {/* Outer glow for current step */}
                  <AnimatePresence>
                    {isCurrent && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 0.3, ease: 'easeOut' }}
                        className={cn(
                          'absolute -inset-[3px] rounded-full',
                          isDark
                            ? 'bg-gradient-to-br from-emerald-500/25 to-emerald-600/15'
                            : 'bg-gradient-to-br from-emerald-500/20 to-emerald-600/10'
                        )}
                      />
                    )}
                  </AnimatePresence>

                  {/* Subtle pulse animation for current */}
                  {isCurrent && (
                    <motion.div
                      className={cn(
                        'absolute -inset-1 rounded-full',
                        isDark ? 'bg-emerald-500/20' : 'bg-emerald-500/15'
                      )}
                      animate={{
                        scale: [1, 1.15, 1],
                        opacity: [0.6, 0, 0.6],
                      }}
                      transition={{
                        duration: 2.5,
                        repeat: Infinity,
                        ease: 'easeInOut',
                      }}
                    />
                  )}

                  {/* Main circle */}
                  <motion.div
                    className={cn(
                      'relative flex items-center justify-center rounded-full',
                      'transition-all duration-300 ease-out',
                      config.circle,
                      // Completed state - solid emerald with elegant shadow
                      isCompleted && [
                        'bg-gradient-to-br from-emerald-500 to-emerald-600',
                        'text-white',
                        isDark
                          ? 'shadow-lg shadow-emerald-500/30'
                          : 'shadow-md shadow-emerald-500/25',
                      ],
                      // Current state - prominent ring with inner glow
                      isCurrent && [
                        isDark
                          ? 'bg-slate-900/90 text-emerald-400 ring-[2.5px] ring-emerald-500 backdrop-blur-sm'
                          : 'bg-white text-emerald-600 shadow-lg shadow-emerald-500/10 ring-[2.5px] ring-emerald-500',
                      ],
                      // Pending state - subtle and muted
                      isPending && [
                        isDark
                          ? 'bg-slate-800/80 text-slate-500 ring-1 ring-slate-700/80'
                          : 'bg-neutral-100 text-neutral-400 ring-1 ring-neutral-200/80',
                      ]
                    )}
                    initial={false}
                    animate={{
                      scale: isCurrent ? 1 : 0.95,
                    }}
                    transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                  >
                    <AnimatePresence mode='wait'>
                      {isCompleted ? (
                        <motion.div
                          key='check'
                          initial={{ scale: 0, rotate: -90 }}
                          animate={{ scale: 1, rotate: 0 }}
                          exit={{ scale: 0, rotate: 90 }}
                          transition={{
                            type: 'spring',
                            stiffness: 500,
                            damping: 25,
                          }}
                        >
                          <Check className={config.icon} strokeWidth={3} />
                        </motion.div>
                      ) : (
                        <motion.span
                          key='number'
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                          transition={{
                            type: 'spring',
                            stiffness: 500,
                            damping: 25,
                          }}
                          className={cn('font-semibold', config.number)}
                        >
                          {index + 1}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.div>
                </div>

                {/* Label */}
                <motion.span
                  className={cn(
                    'font-medium transition-all duration-300',
                    config.text,
                    !showLabelsOnMobile && 'hidden sm:block',
                    isCompleted &&
                      (isDark ? 'text-emerald-400' : 'text-emerald-600'),
                    isCurrent &&
                      (isDark
                        ? 'font-semibold text-white'
                        : 'font-semibold text-neutral-900'),
                    isPending &&
                      (isDark ? 'text-slate-500' : 'text-neutral-400')
                  )}
                  initial={false}
                  animate={{
                    y: isCurrent ? 0 : 0,
                    scale: isCurrent ? 1.02 : 1,
                  }}
                  transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                >
                  {phase}
                </motion.span>
              </div>

              {/* Connector line */}
              {!isLast && (
                <div className={cn('relative', config.lineMargin, '-mt-5')}>
                  {/* Background track */}
                  <div
                    className={cn(
                      'h-[2px] rounded-full',
                      config.lineWidth,
                      isDark ? 'bg-slate-700/60' : 'bg-neutral-200'
                    )}
                  />
                  {/* Animated progress fill */}
                  <motion.div
                    className={cn(
                      'absolute left-0 top-0 h-[2px] rounded-full',
                      'bg-gradient-to-r from-emerald-500 to-emerald-400'
                    )}
                    initial={false}
                    animate={{
                      width: isCompleted ? '100%' : isCurrent ? '40%' : '0%',
                    }}
                    transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================
// MINIMAL VARIANT
// ============================================

export interface StepIndicatorMinimalProps {
  /** Current phase index, 0-based */
  currentPhase: number
  /** Phase labels */
  phases?: string[]
  /** Additional class name */
  className?: string
}

export const StepIndicatorMinimal = ({
  currentPhase,
  phases = DEFAULT_PHASES,
  className,
}: StepIndicatorMinimalProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  return (
    <div className={cn('flex items-center justify-center', className)}>
      <div
        className={cn(
          'inline-flex items-center rounded-full px-1 py-1',
          isDark
            ? 'border border-slate-700/50 bg-slate-800/60 backdrop-blur-sm'
            : 'border border-neutral-200/50 bg-neutral-100/80 backdrop-blur-sm'
        )}
      >
        {phases.map((phase, index) => {
          const isCompleted = index < currentPhase
          const isCurrent = index === currentPhase
          const isLast = index === phases.length - 1

          return (
            <div key={phase} className='flex items-center'>
              <motion.div
                className={cn(
                  'relative flex items-center gap-1.5 rounded-full px-3 py-1.5',
                  'text-xs font-medium transition-colors duration-200',
                  isCurrent && (isDark ? 'text-white' : 'text-neutral-900'),
                  isCompleted &&
                    (isDark ? 'text-emerald-400' : 'text-emerald-600'),
                  !isCurrent &&
                    !isCompleted &&
                    (isDark ? 'text-slate-500' : 'text-neutral-400')
                )}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                {/* Active background */}
                {isCurrent && (
                  <motion.div
                    layoutId='activeMinimalStep'
                    className={cn(
                      'absolute inset-0 rounded-full',
                      isDark
                        ? 'bg-slate-700/80 shadow-sm'
                        : 'bg-white shadow-sm'
                    )}
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                  />
                )}

                {/* Content */}
                <span className='relative flex items-center gap-1.5'>
                  {isCompleted && (
                    <Check className='h-3 w-3' strokeWidth={2.5} />
                  )}
                  {phase}
                </span>
              </motion.div>

              {/* Separator dot */}
              {!isLast && (
                <div
                  className={cn(
                    'mx-1 h-1 w-1 rounded-full',
                    isDark ? 'bg-slate-600' : 'bg-neutral-300'
                  )}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================
// COMPACT VARIANT - Dots with expanding current
// ============================================

export interface StepIndicatorCompactProps {
  /** Current phase index, 0-based */
  currentPhase: number
  /** Total phases */
  totalPhases?: number
  /** Current phase label */
  currentLabel?: string
  /** Additional class name */
  className?: string
}

export const StepIndicatorCompact = ({
  currentPhase,
  totalPhases = 3,
  currentLabel,
  className,
}: StepIndicatorCompactProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const phases = DEFAULT_PHASES

  return (
    <div className={cn('flex items-center gap-3', className)}>
      {/* Progress dots */}
      <div className='flex items-center gap-1.5'>
        {Array.from({ length: totalPhases }).map((_, index) => (
          <motion.div
            key={index}
            className={cn(
              'h-2 rounded-full transition-colors duration-300',
              index < currentPhase && 'bg-emerald-500',
              index === currentPhase &&
                (isDark ? 'bg-emerald-400' : 'bg-emerald-500'),
              index > currentPhase &&
                (isDark ? 'bg-slate-600' : 'bg-neutral-300')
            )}
            animate={{
              width: index === currentPhase ? 20 : 8,
            }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          />
        ))}
      </div>

      {/* Label */}
      <span
        className={cn(
          'text-sm font-medium',
          isDark ? 'text-slate-300' : 'text-neutral-600'
        )}
      >
        {currentLabel || phases[currentPhase]}
      </span>
    </div>
  )
}

// ============================================
// LINEAR PROGRESS VARIANT
// ============================================

export interface StepIndicatorLinearProps {
  /** Progress percentage (0-100) */
  progress: number
  /** Show percentage text */
  showPercentage?: boolean
  /** Additional class name */
  className?: string
}

export const StepIndicatorLinear = ({
  progress,
  showPercentage = false,
  className,
}: StepIndicatorLinearProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  return (
    <div className={cn('w-full', className)}>
      <div className='flex items-center gap-3'>
        {/* Progress bar container */}
        <div
          className={cn(
            'h-1.5 flex-1 overflow-hidden rounded-full',
            isDark ? 'bg-slate-700/60' : 'bg-neutral-200'
          )}
        >
          <motion.div
            className='h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400'
            initial={false}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
          />
        </div>

        {/* Percentage */}
        {showPercentage && (
          <span
            className={cn(
              'min-w-[2.5rem] text-right text-xs font-medium tabular-nums',
              isDark ? 'text-slate-400' : 'text-neutral-500'
            )}
          >
            {progress}%
          </span>
        )}
      </div>
    </div>
  )
}

// ============================================
// PILL VARIANT - Segmented control style
// ============================================

export interface StepIndicatorPillProps {
  /** Current phase index, 0-based */
  currentPhase: number
  /** Phase labels */
  phases?: string[]
  /** Additional class name */
  className?: string
}

export const StepIndicatorPill = ({
  currentPhase,
  phases = DEFAULT_PHASES,
  className,
}: StepIndicatorPillProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  return (
    <div className={cn('flex items-center justify-center', className)}>
      <div
        className={cn(
          'inline-flex items-center gap-0.5 rounded-full p-1',
          isDark
            ? 'bg-slate-800/70 backdrop-blur-sm'
            : 'bg-neutral-100/90 backdrop-blur-sm'
        )}
      >
        {phases.map((phase, index) => {
          const isCompleted = index < currentPhase
          const isCurrent = index === currentPhase

          return (
            <motion.button
              key={phase}
              className={cn(
                'relative rounded-full px-4 py-2 text-xs font-medium',
                'transition-colors duration-200',
                isCompleted &&
                  (isDark ? 'text-emerald-400' : 'text-emerald-600'),
                isCurrent && (isDark ? 'text-white' : 'text-neutral-900'),
                !isCompleted &&
                  !isCurrent &&
                  (isDark ? 'text-slate-500' : 'text-neutral-400')
              )}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {/* Active background */}
              {isCurrent && (
                <motion.div
                  layoutId='activePillStep'
                  className={cn(
                    'absolute inset-0 rounded-full',
                    isDark ? 'bg-slate-700 shadow-sm' : 'bg-white shadow-md'
                  )}
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}

              {/* Content */}
              <span className='relative flex items-center gap-1.5'>
                {isCompleted && (
                  <Check className='h-3.5 w-3.5' strokeWidth={2.5} />
                )}
                {phase}
              </span>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

export default StepIndicator
