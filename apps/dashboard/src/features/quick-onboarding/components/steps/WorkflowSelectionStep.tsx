/**
 * WorkflowSelectionStep - Clean Welcome Experience
 * Minimal, focused design with clear call to action
 */
'use client'

import { useState, useEffect, useLayoutEffect } from 'react'
import { motion } from 'framer-motion'
import { Zap, BarChart3, CreditCard, Code2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'
import { WorkflowMode } from '../../types/v2'

/**
 * WorkflowSelectionStep - Clean Welcome Experience
 * Minimal, focused design with clear call to action
 */

export interface WorkflowSelectionStepProps {
  companyName?: string
  selectedWorkflow: WorkflowMode
  onSelectWorkflow: (mode: WorkflowMode) => void
  onContinue: () => void
  showSkip?: boolean
  onSkip?: () => void
}

// Brand colors
const BRAND_COLORS = {
  primary: '#0D4A3A', // Deep Teal
  primaryLight: '#1a6b54', // Lighter teal
  secondary: '#D4F060', // Lime Green
  secondaryDark: '#b8d654', // Darker lime
}

// Animated workflow visualization with clean progress line
const AIWorkflowVisual = ({
  isDark,
  onComplete,
  paused = false,
}: {
  isDark: boolean
  onComplete?: () => void
  paused?: boolean
}) => {
  const [activeStep, setActiveStep] = useState(0)
  const [hasCompleted, setHasCompleted] = useState(false)

  // Start animation only when not paused
  useEffect(() => {
    if (paused || hasCompleted) return

    const interval = setInterval(() => {
      setActiveStep((prev) => {
        // When we reach step 3 (Launch), mark as complete
        if (prev === 3) {
          setHasCompleted(true)
          return prev // Stay on last step
        }
        return prev + 1
      })
    }, 1500) // 1.5s per step for smooth animation

    return () => clearInterval(interval)
  }, [paused, hasCompleted])

  // Call onComplete when animation finishes (separate effect to avoid setState during render)
  useEffect(() => {
    if (hasCompleted && onComplete) {
      onComplete()
    }
  }, [hasCompleted, onComplete])

  const steps = [
    { icon: Code2, label: 'Create', color: '#10b981' },
    { icon: BarChart3, label: 'Configure', color: '#0ea5e9' },
    { icon: CreditCard, label: 'Customize', color: '#8b5cf6' },
    { icon: Zap, label: 'Launch', color: '#f59e0b' },
  ]

  return (
    <div className='relative py-4'>
      {/* Step nodes with connecting lines */}
      <div className='relative flex items-center justify-between px-2'>
        {steps.map((step, index) => {
          const Icon = step.icon
          const isActive = index === activeStep
          const isCompleted = index < activeStep

          return (
            <div
              key={index}
              className='flex items-center'
              style={{ flex: index < 3 ? 1 : 'none' }}
            >
              {/* Step node */}
              <motion.div
                className='flex flex-col items-center gap-2'
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
              >
                <motion.div
                  className={cn(
                    'relative flex h-11 w-11 items-center justify-center rounded-xl',
                    'transition-all duration-300'
                  )}
                  animate={{
                    scale: isActive ? 1.08 : 1,
                  }}
                  style={{
                    background:
                      isActive || isCompleted
                        ? `linear-gradient(135deg, ${step.color}20, ${step.color}10)`
                        : isDark
                          ? 'rgba(255,255,255,0.05)'
                          : 'rgba(0,0,0,0.03)',
                    boxShadow: isActive ? `0 0 20px ${step.color}40` : 'none',
                    border: `2px solid ${isActive || isCompleted ? step.color : isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
                  }}
                >
                  {/* Pulse animation for active step */}
                  {isActive && (
                    <motion.div
                      className='absolute inset-0 rounded-xl'
                      animate={{
                        scale: [1, 1.3, 1],
                        opacity: [0.4, 0, 0.4],
                      }}
                      transition={{
                        duration: 1.8,
                        repeat: Infinity,
                        ease: 'easeInOut',
                      }}
                      style={{
                        background: `radial-gradient(circle, ${step.color}30 0%, transparent 70%)`,
                      }}
                    />
                  )}

                  <Icon
                    className='h-5 w-5 transition-colors duration-300'
                    style={{
                      color:
                        isActive || isCompleted
                          ? step.color
                          : isDark
                            ? '#64748b'
                            : '#9ca3af',
                    }}
                  />

                  {/* Completed checkmark */}
                  {isCompleted && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className='absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full'
                      style={{ backgroundColor: step.color }}
                    >
                      <CheckCircle2 className='h-2.5 w-2.5 text-white' />
                    </motion.div>
                  )}
                </motion.div>

                <span
                  className={cn(
                    'text-[11px] font-medium transition-colors duration-300',
                    isActive
                      ? isDark
                        ? 'text-white'
                        : 'text-neutral-900'
                      : isCompleted
                        ? isDark
                          ? 'text-slate-300'
                          : 'text-neutral-700'
                        : isDark
                          ? 'text-slate-500'
                          : 'text-neutral-400'
                  )}
                >
                  {step.label}
                </span>
              </motion.div>

              {/* Connecting line (not after last step) */}
              {index < 3 && (
                <div
                  className='relative mx-2 h-[3px] flex-1 overflow-hidden rounded-full'
                  style={{
                    backgroundColor: isDark
                      ? 'rgba(255,255,255,0.08)'
                      : 'rgba(0,0,0,0.06)',
                    marginBottom: '18px', // Align with icon center
                  }}
                >
                  {/* Progress fill */}
                  <motion.div
                    className='absolute inset-y-0 left-0 rounded-full'
                    initial={{ width: '0%' }}
                    animate={{
                      width: isCompleted ? '100%' : '0%',
                    }}
                    transition={{
                      duration: 0.6,
                      ease: 'easeOut',
                    }}
                    style={{
                      background: `linear-gradient(90deg, ${step.color}, ${steps[index + 1].color})`,
                    }}
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

const WorkflowSelectionStep = ({
  companyName: _companyName = 'your product',
  selectedWorkflow: _selectedWorkflow,
  onSelectWorkflow,
  onContinue,
  showSkip = false,
  onSkip,
}: WorkflowSelectionStepProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const [mounted, setMounted] = useState(false)

  // Track animation completion for showing "Getting started" message
  const [animationComplete, setAnimationComplete] = useState(false)

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional hydration guard
    setMounted(true)
  }, [])

  // Handle auto-continue when animation completes
  const handleAnimationComplete = () => {
    setAnimationComplete(true)

    // Then auto-continue after 1.5 seconds
    setTimeout(() => {
      onSelectWorkflow('quick')
      onContinue()
    }, 1500)
  }

  return (
    <div className='relative w-full overflow-hidden py-8'>
      {/* Animated Background with Brand Colors */}
      <div className='pointer-events-none absolute inset-0 overflow-hidden'>
        {/* Primary orb - Deep Teal */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{
            opacity: mounted ? (isDark ? 0.2 : 0.15) : 0,
            x: [0, 20, 0],
            y: [0, -15, 0],
          }}
          transition={{
            opacity: { duration: 1 },
            x: { duration: 20, repeat: Infinity, ease: 'easeInOut' },
            y: { duration: 15, repeat: Infinity, ease: 'easeInOut' },
          }}
          className='absolute -top-40 right-0 h-[500px] w-[500px] rounded-full'
          style={{
            background: `radial-gradient(circle, ${BRAND_COLORS.primary}${isDark ? '50' : '35'} 0%, transparent 60%)`,
            filter: 'blur(80px)',
          }}
        />

        {/* Secondary orb - Lime Green */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{
            opacity: mounted ? (isDark ? 0.15 : 0.12) : 0,
            x: [0, -15, 0],
            y: [0, 20, 0],
          }}
          transition={{
            opacity: { duration: 1, delay: 0.2 },
            x: { duration: 18, repeat: Infinity, ease: 'easeInOut' },
            y: { duration: 22, repeat: Infinity, ease: 'easeInOut' },
          }}
          className='absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full'
          style={{
            background: `radial-gradient(circle, ${BRAND_COLORS.secondary}${isDark ? '40' : '30'} 0%, transparent 60%)`,
            filter: 'blur(80px)',
          }}
        />
      </div>

      {/* Main Content */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className='relative z-10 mx-auto flex w-full max-w-lg flex-col items-center px-6'
      >
        {/* Header Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className='text-center'
        >
          {/* Title */}
          <h1
            className={cn(
              'text-4xl font-bold tracking-tight',
              isDark ? 'text-white' : 'text-neutral-900'
            )}
          >
            Welcome
          </h1>

          {/* Subtitle */}
          <p
            className={cn(
              'mt-3 text-base leading-relaxed',
              isDark ? 'text-slate-400' : 'text-neutral-500'
            )}
          >
            Let&apos;s get your organization set up
          </p>
        </motion.div>

        {/* AI Workflow Visualization - Auto continues after completion */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.5 }}
          className='mt-10 w-full'
        >
          <AIWorkflowVisual
            isDark={isDark}
            onComplete={handleAnimationComplete}
            paused={false}
          />
        </motion.div>

        {/* Getting started message - only show after animation completes */}
        {animationComplete && (
          <motion.div
            className='mt-8 flex flex-col items-center'
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            <div
              className={cn(
                'rounded-full px-5 py-2.5',
                'flex items-center gap-2',
                isDark
                  ? 'border border-emerald-500/30 bg-emerald-500/20'
                  : 'border border-emerald-200 bg-emerald-50'
              )}
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                className={cn(
                  'h-4 w-4 rounded-full border-2 border-t-transparent',
                  isDark ? 'border-emerald-400' : 'border-emerald-500'
                )}
              />
              <span
                className={cn(
                  'text-sm font-medium',
                  isDark ? 'text-emerald-400' : 'text-emerald-600'
                )}
              >
                Getting started...
              </span>
            </div>
          </motion.div>
        )}

        {/* Skip option */}
        {showSkip && onSkip && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            onClick={onSkip}
            className={cn(
              'mt-4 text-sm font-medium transition-colors',
              isDark
                ? 'text-slate-500 hover:text-slate-400'
                : 'text-neutral-400 hover:text-neutral-600'
            )}
          >
            Skip for now
          </motion.button>
        )}
      </motion.div>
    </div>
  )
}

export default WorkflowSelectionStep
