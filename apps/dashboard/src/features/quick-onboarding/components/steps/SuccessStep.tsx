/**
 * SuccessStep Component - Minimal & Aesthetic
 * Clean celebration screen
 * Auto-redirects to dashboard after celebration completes
 */
'use client'

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'

/**
 * SuccessStep Component - Minimal & Aesthetic
 * Clean celebration screen
 * Auto-redirects to dashboard after celebration completes
 */

export interface SuccessStepProps {
  /** User's name */
  userName?: string
  /** Company name */
  companyName?: string
  /** Callback to go to dashboard */
  onGoToDashboard: () => void
  /** Completed items to show */
  completedItems?: string[]
}

const DEFAULT_COMPLETED_ITEMS = ['Organization Created']

const SuccessStep = ({
  userName = 'there',
  companyName,
  onGoToDashboard,
  completedItems = DEFAULT_COMPLETED_ITEMS,
}: SuccessStepProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const [animationPhase, setAnimationPhase] = useState(0)
  const [countdown, setCountdown] = useState(3) // 3 seconds for quick redirect
  const [hasRedirected, setHasRedirected] = useState(false)

  // Animation phases
  useEffect(() => {
    const t1 = setTimeout(() => setAnimationPhase(1), 200)
    const t2 = setTimeout(() => setAnimationPhase(2), 600)
    const t3 = setTimeout(() => setAnimationPhase(3), 1000)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      clearTimeout(t3)
    }
  }, [])

  // Confetti effect - fire once on mount
  useEffect(() => {
    let mounted = true

    const fireConfetti = async () => {
      try {
        const confetti = (await import('canvas-confetti')).default
        if (!mounted) return

        const shoot = () => {
          confetti({
            particleCount: 40,
            angle: 60,
            spread: 55,
            origin: { x: 0, y: 0.6 },
            colors: isDark
              ? ['#10b981', '#22c55e', '#34d399', '#6ee7b7']
              : ['#171717', '#404040', '#737373', '#a3a3a3'],
          })
          confetti({
            particleCount: 40,
            angle: 120,
            spread: 55,
            origin: { x: 1, y: 0.6 },
            colors: isDark
              ? ['#10b981', '#22c55e', '#34d399', '#6ee7b7']
              : ['#171717', '#404040', '#737373', '#a3a3a3'],
          })
        }

        shoot()
        setTimeout(shoot, 200)
        setTimeout(shoot, 400)
      } catch (e) {
        console.error('[SuccessStep] Confetti error:', e)
      }
    }

    fireConfetti()
    return () => {
      mounted = false
    }
  }, [isDark])

  // Countdown timer - simple interval
  useEffect(() => {
    console.log('[SuccessStep] Starting countdown from 3')

    const interval = setInterval(() => {
      setCountdown((prev) => {
        const next = prev - 1
        console.log('[SuccessStep] Countdown:', next)
        if (next <= 0) {
          clearInterval(interval)
          return 0
        }
        return next
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  // REDIRECT - fires when countdown hits 0
  useEffect(() => {
    if (countdown === 0 && !hasRedirected) {
      console.log('[SuccessStep] REDIRECTING NOW - calling onGoToDashboard')
      setHasRedirected(true)
      onGoToDashboard()
    }
  }, [countdown, hasRedirected, onGoToDashboard])

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-sm flex-col items-center',
        'animate-slide-up-fade [--offset:10px] [animation-duration:0.6s] [animation-fill-mode:both]',
        'pt-[58vh]'
      )}
    >
      {/* Title */}
      <h1
        className={cn(
          'text-center text-2xl font-semibold tracking-tight',
          isDark ? 'text-white' : 'text-neutral-900'
        )}
      >
        You&apos;re all set, {userName}!
      </h1>

      {/* Description */}
      <p
        className={cn(
          'mt-3 text-balance text-center text-base',
          isDark ? 'text-slate-400' : 'text-neutral-500'
        )}
      >
        {companyName ? (
          <>
            <span
              className={
                isDark
                  ? 'font-medium text-emerald-400'
                  : 'font-medium text-neutral-900'
              }
            >
              {companyName}
            </span>{' '}
            is ready to go
          </>
        ) : (
          'Your workspace is ready'
        )}
      </p>

      {/* Completed Items */}
      <div
        className={cn(
          'mt-8 flex flex-wrap justify-center gap-2',
          'transition-all duration-500',
          animationPhase >= 1
            ? 'translate-y-0 opacity-100'
            : 'translate-y-2 opacity-0'
        )}
      >
        {completedItems.map((item, index) => (
          <div
            key={index}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5',
              'transition-all duration-300',
              isDark
                ? 'border border-emerald-500/20 bg-emerald-500/10'
                : 'border border-neutral-200 bg-neutral-100'
            )}
            style={{ transitionDelay: `${index * 100}ms` }}
          >
            <Check
              className={cn(
                'h-3 w-3',
                isDark ? 'text-emerald-400' : 'text-emerald-600'
              )}
            />
            <span
              className={cn(
                'text-xs font-medium',
                isDark ? 'text-emerald-300' : 'text-neutral-700'
              )}
            >
              {item}
            </span>
          </div>
        ))}
      </div>

      {/* Redirect notice */}
      <p
        className={cn(
          'mt-12 text-center text-sm',
          'transition-all duration-500',
          animationPhase >= 2 ? 'opacity-100' : 'opacity-0',
          isDark ? 'text-slate-500' : 'text-neutral-400'
        )}
      >
        Redirecting to dashboard in {countdown}s
        <span className='ml-1 inline-flex items-center'>
          <span className='animate-pulse'>...</span>
        </span>
      </p>

      {/* Countdown dots */}
      <div
        className={cn(
          'mt-3 flex items-center gap-1',
          'transition-all duration-500',
          animationPhase >= 2 ? 'opacity-100' : 'opacity-0'
        )}
      >
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-1.5 w-1.5 rounded-full transition-all duration-300',
              i < 3 - countdown
                ? isDark
                  ? 'bg-emerald-400'
                  : 'bg-neutral-900'
                : isDark
                  ? 'bg-slate-700'
                  : 'bg-neutral-200'
            )}
          />
        ))}
      </div>
    </div>
  )
}

export default SuccessStep
