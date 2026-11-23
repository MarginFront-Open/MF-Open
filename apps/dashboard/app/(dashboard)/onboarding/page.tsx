'use client'

import { useRouter } from 'next/navigation'
import { Suspense } from 'react'

import { OnboardingRouter } from '@/features/quick-onboarding/OnboardingRouter'

function OnboardingContent() {
  const router = useRouter()

  const handleComplete = () => {
    router.push('/')
  }

  return <OnboardingRouter onComplete={handleComplete} />
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className='flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950'>
          <div className='flex flex-col items-center gap-4'>
            <div className='h-10 w-10 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent' />
            <div className='text-sm text-slate-400'>Loading onboarding...</div>
          </div>
        </div>
      }
    >
      <OnboardingContent />
    </Suspense>
  )
}
