'use client'

import { useRouter } from 'next/navigation'
import { Suspense } from 'react'
import { OnboardingRouter } from '@/features/quick-onboarding/OnboardingRouter'

export default function QuickOnboardingClient({
  canCancel,
}: {
  canCancel: boolean
}) {
  const router = useRouter()

  const handleComplete = () => {
    console.log('Quick Onboarding completed')
    router.push('/')
  }

  return (
    <Suspense
      fallback={
        <div className='flex min-h-screen items-center justify-center bg-background'>
          <div className='animate-pulse text-muted-foreground'>
            Loading onboarding...
          </div>
        </div>
      }
    >
      <OnboardingRouter onComplete={handleComplete} canCancel={canCancel} />
    </Suspense>
  )
}
