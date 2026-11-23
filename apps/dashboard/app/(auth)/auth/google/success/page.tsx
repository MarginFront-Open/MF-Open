'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { authClient } from '@/app/lib/auth-client'
import { getPostAuthRedirect } from '@/app/lib/auth-redirect'
import { WrongAccountNotice } from '@/features/auth/components/wrong-account-notice'

export default function GoogleAuthSuccessPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const [status, setStatus] = useState('Completing authentication...')
  const [wrongAccount, setWrongAccount] = useState<{
    invitedEmail: string
    currentEmail: string
  } | null>(null)

  useEffect(() => {
    const handleGoogleCallback = async () => {
      try {
        const error = searchParams.get('error')

        // Handle error case
        if (error) {
          console.error('[Google OAuth] Error from callback:', error)
          toast({
            variant: 'destructive',
            title: 'Authentication Failed',
            description:
              'Google authentication was unsuccessful. Please try again.',
          })
          router.push('/sign-in')
          return
        }

        // Wait a moment for session to be established
        setStatus('Verifying session...')
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Retry session check up to 3 times with delay
        let session = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`[Google OAuth] Session check attempt ${attempt}...`)
          const result = await authClient.getSession()
          if (result?.data?.session) {
            session = result.data
            break
          }

          if (attempt < 3) {
            setStatus(`Verifying session (attempt ${attempt + 1})...`)
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }

        if (!session?.session) {
          console.error('[Google OAuth] No session after retries')
          toast({
            variant: 'destructive',
            title: 'Authentication Error',
            description: 'Unable to establish session. Please try again.',
          })
          router.push('/sign-in')
          return
        }

        // Wrong-account guard: invite context was carried on the
        // OAuth callbackURL but we signed in as a different email. Checked
        // BEFORE the org check on purpose — a wrong account may have its own
        // org, and routing it /home would silently drop the invite. Never joins,
        // never creates a junk workspace.
        const invitedEmail = searchParams.get('invitedEmail')
        const currentEmail = session.user?.email ?? ''
        if (
          invitedEmail &&
          currentEmail.toLowerCase() !== invitedEmail.toLowerCase()
        ) {
          console.log(
            '[Google OAuth] Wrong account for invite, showing interstitial'
          )
          setWrongAccount({ invitedEmail, currentEmail })
          return
        }

        // Centralized post-auth routing: active org → /home; else a
        // pending invite for this email → the accept page; else → onboarding.
        // getPostAuthRedirect keys the invite lookup off the session only.
        const carriedRedirectTo = searchParams.get('redirectTo')
        const { url, reason } = await getPostAuthRedirect(carriedRedirectTo)

        if (reason === 'has-organization') {
          console.log('[Google OAuth] Existing user, redirecting to', url)
          setStatus('Logging you in...')
          toast({
            title: 'Login Successful',
            description: 'You have been successfully logged in with Google.',
          })
        } else {
          console.log('[Google OAuth] No active org, redirecting to', url)
          setStatus('Setting up your account...')
          toast({
            title: 'Welcome!',
            description:
              reason === 'pending-invite'
                ? "Let's get you into your team."
                : "Let's set up your account.",
          })
        }

        router.push(url)
      } catch (error) {
        console.error('[Google OAuth] Callback error:', error)
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'An unexpected error occurred. Please try again.',
        })
        router.push('/sign-in')
      }
    }

    handleGoogleCallback()
  }, [router, toast, searchParams])

  if (wrongAccount) {
    return (
      <WrongAccountNotice
        invitedEmail={wrongAccount.invitedEmail}
        currentEmail={wrongAccount.currentEmail}
      />
    )
  }

  return (
    <div className='flex min-h-screen items-center justify-center'>
      <div className='text-center'>
        <div className='mb-4 flex justify-center'>
          <div className='h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent'></div>
        </div>
        <p className='text-lg font-medium'>{status}</p>
        <p className='mt-2 text-sm text-muted-foreground'>
          Please wait while we log you in.
        </p>
      </div>
    </div>
  )
}
