/**
 * RecoveryModal Component
 * Shows when user has saved onboarding progress and returns
 */
'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { RefreshCw, ArrowRight, X, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'

/**
 * RecoveryModal Component
 * Shows when user has saved onboarding progress and returns
 */

export interface RecoveryModalProps {
  isOpen: boolean
  lastStep: string
  lastUpdated?: Date
  onContinue: () => void
  onStartFresh: () => void
  onDismiss: () => void
}

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
}

const modalVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 300, damping: 25 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 10,
    transition: { duration: 0.15 },
  },
}

const stepLabels: Record<string, string> = {
  'workflow-selection': 'Getting Started',
  'create-organization': 'Organization Setup',
  scanning: 'Website Analysis',
  'review-config': 'Pricing Review',
  branding: 'Branding',
  'payment-gateway': 'Payment Gateway',
  'data-import': 'Data Import',
  'portal-setup': 'Portal Setup',
  integration: 'SDK Integration',
  'test-event': 'Event Testing',
}

const RecoveryModal = ({
  isOpen,
  lastStep,
  lastUpdated,
  onContinue,
  onStartFresh,
  onDismiss,
}: RecoveryModalProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const stepLabel = stepLabels[lastStep] || lastStep

  const formatTimeAgo = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`
    if (diffHours < 24)
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className='fixed inset-0 z-50 flex items-center justify-center p-4'
          initial='hidden'
          animate='visible'
          exit='exit'
        >
          {/* Backdrop */}
          <motion.div
            variants={overlayVariants}
            className={cn(
              'absolute inset-0',
              isDark ? 'bg-black/60' : 'bg-black/40',
              'backdrop-blur-sm'
            )}
            onClick={onDismiss}
          />

          {/* Modal */}
          <motion.div
            variants={modalVariants}
            className={cn(
              'relative w-full max-w-md rounded-2xl p-6',
              isDark
                ? 'border border-slate-800 bg-slate-900'
                : 'border border-neutral-200 bg-white',
              'shadow-2xl'
            )}
          >
            {/* Close button */}
            <button
              onClick={onDismiss}
              className={cn(
                'absolute right-4 top-4 rounded-lg p-1.5 transition-colors',
                isDark
                  ? 'text-slate-500 hover:bg-slate-800 hover:text-white'
                  : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900'
              )}
            >
              <X className='h-4 w-4' />
            </button>

            {/* Icon */}
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{
                type: 'spring',
                stiffness: 300,
                damping: 20,
                delay: 0.1,
              }}
              className={cn(
                'mb-4 flex h-14 w-14 items-center justify-center rounded-2xl',
                isDark ? 'bg-emerald-500/20' : 'bg-emerald-100'
              )}
            >
              <RefreshCw
                className={cn(
                  'h-7 w-7',
                  isDark ? 'text-emerald-400' : 'text-emerald-600'
                )}
              />
            </motion.div>

            {/* Title */}
            <h2
              className={cn(
                'mb-2 text-xl font-semibold',
                isDark ? 'text-white' : 'text-neutral-900'
              )}
            >
              Welcome Back!
            </h2>

            {/* Description */}
            <p
              className={cn(
                'mb-4 text-base',
                isDark ? 'text-slate-400' : 'text-neutral-500'
              )}
            >
              You have saved progress from your previous session.
            </p>

            {/* Progress info */}
            <div
              className={cn(
                'mb-6 rounded-xl p-4',
                isDark ? 'bg-slate-800/50' : 'bg-neutral-50'
              )}
            >
              <div className='flex items-center gap-3'>
                <div
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg',
                    isDark
                      ? 'bg-slate-700'
                      : 'border border-neutral-200 bg-white'
                  )}
                >
                  <Clock
                    className={cn(
                      'h-5 w-5',
                      isDark ? 'text-slate-400' : 'text-neutral-500'
                    )}
                  />
                </div>
                <div>
                  <p
                    className={cn(
                      'text-sm font-medium',
                      isDark ? 'text-white' : 'text-neutral-900'
                    )}
                  >
                    {stepLabel}
                  </p>
                  {lastUpdated && (
                    <p
                      className={cn(
                        'text-xs',
                        isDark ? 'text-slate-500' : 'text-neutral-400'
                      )}
                    >
                      Last updated {formatTimeAgo(lastUpdated)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className='space-y-3'>
              <motion.button
                onClick={onContinue}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className={cn(
                  'h-11 w-full rounded-xl',
                  'flex items-center justify-center gap-2',
                  'text-sm font-medium',
                  'transition-all duration-200',
                  'group',
                  isDark
                    ? 'bg-emerald-500 text-white hover:bg-emerald-400'
                    : 'bg-neutral-900 text-white hover:bg-neutral-800'
                )}
              >
                Continue Where You Left Off
                <ArrowRight className='h-4 w-4 transition-transform group-hover:translate-x-1' />
              </motion.button>

              <button
                onClick={onStartFresh}
                className={cn(
                  'h-11 w-full rounded-xl',
                  'flex items-center justify-center gap-2',
                  'text-sm font-medium',
                  'transition-all duration-200',
                  'border',
                  isDark
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border-neutral-200 text-neutral-700 hover:bg-neutral-50'
                )}
              >
                Start Fresh
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default RecoveryModal
