/**
 * Onboarding Router - Entry Point
 *
 * Routes to the quick onboarding flow.
 */
'use client'

import { Suspense, lazy } from 'react'
import { ONBOARDING_CONFIG } from './config'

/**
 * Onboarding Router - Entry Point
 *
 * Routes to the quick onboarding flow.
 */

// Lazy load for code splitting
const QuickOnboarding = lazy(() => import('./index'))

export interface OnboardingRouterProps {
  /**
   * Callback when onboarding is completed
   */
  onComplete?: () => void
  /**
   * Whether the user can cancel onboarding (has an existing org)
   */
  canCancel?: boolean
}

/**
 * Loading fallback for lazy-loaded component
 */
function OnboardingLoadingFallback() {
  return (
    <div className='flex min-h-screen items-center justify-center bg-white'>
      <div className='flex flex-col items-center gap-4'>
        <div className='h-10 w-10 animate-spin rounded-full border-2 border-neutral-900 border-t-transparent' />
        <div className='text-sm text-neutral-500'>
          Loading {ONBOARDING_CONFIG.name}...
        </div>
      </div>
    </div>
  )
}

/**
 * Main Onboarding Router
 */
export function OnboardingRouter({
  onComplete,
  canCancel,
}: OnboardingRouterProps) {
  return (
    <Suspense fallback={<OnboardingLoadingFallback />}>
      <QuickOnboarding onComplete={onComplete} canCancel={canCancel} />
    </Suspense>
  )
}

export default OnboardingRouter
