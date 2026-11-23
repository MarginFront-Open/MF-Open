'use client'

/**
 * Stripe Connect OAuth Callback Page
 * Handles the OAuth redirect from Stripe and completes the connection
 */

import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { connectStripeAccount } from '@/app/actions/stripe-connect'

type CallbackStatus = 'processing' | 'success' | 'error'

function StripeCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [status, setStatus] = useState<CallbackStatus>('processing')
  const [message, setMessage] = useState<string>(
    'Connecting your Stripe account...'
  )
  const [errorDetails, setErrorDetails] = useState<string | null>(null)

  const handleOAuthCallback = useCallback(async () => {
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')
    const errorDescription = searchParams.get('error_description')

    // Check for OAuth error from Stripe
    if (error) {
      console.error('[StripeCallback] OAuth error:', error, errorDescription)
      setStatus('error')
      setMessage('Connection was cancelled or denied')
      setErrorDetails(errorDescription || error)
      return
    }

    // Validate required parameters
    if (!code || !state) {
      console.error('[StripeCallback] Missing code or state')
      setStatus('error')
      setMessage('Invalid callback parameters')
      setErrorDetails(
        'The callback URL is missing required parameters. Please try connecting again.'
      )
      return
    }

    try {
      // Call server action to complete OAuth
      const result = await connectStripeAccount(code, state)

      if (result.success) {
        setStatus('success')
        setMessage('Stripe account connected successfully!')

        // Default to /settings/integrations because that's where most Connect-with-Stripe
        // clicks originate. A flow that should land back elsewhere (e.g. /quick-onboarding)
        // must pass returnUrl explicitly in state.
        const stateData = JSON.parse(atob(decodeURIComponent(state)))
        const returnUrl = stateData.returnUrl || '/settings/integrations'

        // Redirect after short delay
        setTimeout(() => {
          router.push(returnUrl + '?stripe_connected=true')
        }, 2000)
      } else {
        setStatus('error')
        setMessage('Failed to connect Stripe account')
        setErrorDetails(result.error)
      }
    } catch (err) {
      console.error('[StripeCallback] Connection error:', err)
      setStatus('error')
      setMessage('An unexpected error occurred')
      setErrorDetails(
        err instanceof Error ? err.message : 'Please try again later'
      )
    }
  }, [searchParams, router])

  // OAuth code exchange must run exactly once. React StrictMode (dev) double-invokes
  // effects to surface side-effect bugs — without this guard, the second invocation
  // hits api-nest's "Stripe Connect account already connected" check (because the first
  // invocation just wrote the account_id) and swaps the success UI to an error UI.
  // Browser back-button and HMR re-renders would do the same in production.
  const hasRun = useRef(false)
  /* eslint-disable react-hooks/set-state-in-effect -- async data fetch on mount, setState in callback is intentional */
  useEffect(() => {
    if (hasRun.current) return
    hasRun.current = true
    handleOAuthCallback()
  }, [handleOAuthCallback])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleRetry = () => {
    // Go back to onboarding to try again
    router.push('/quick-onboarding')
  }

  const handleContinue = () => {
    router.push('/quick-onboarding')
  }

  return (
    <div className='flex min-h-screen items-center justify-center bg-background'>
      <div className='mx-4 w-full max-w-md'>
        <div className='rounded-2xl border border-border bg-card p-8 text-center shadow-lg'>
          {/* Status Icon */}
          <div className='mb-6'>
            {status === 'processing' && (
              <div className='mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10'>
                <Loader2 className='h-8 w-8 animate-spin text-primary' />
              </div>
            )}
            {status === 'success' && (
              <div className='mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10'>
                <CheckCircle className='h-8 w-8 text-emerald-500' />
              </div>
            )}
            {status === 'error' && (
              <div className='mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10'>
                <XCircle className='h-8 w-8 text-destructive' />
              </div>
            )}
          </div>

          {/* Message */}
          <h2 className='mb-2 text-xl font-semibold text-foreground'>
            {message}
          </h2>

          {/* Status-specific content */}
          {status === 'processing' && (
            <p className='text-sm text-muted-foreground'>
              Please wait while we verify your Stripe account...
            </p>
          )}

          {status === 'success' && (
            <p className='text-sm text-muted-foreground'>
              Redirecting you back to onboarding...
            </p>
          )}

          {status === 'error' && (
            <>
              {errorDetails && (
                <div className='mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3'>
                  <div className='flex items-start gap-2'>
                    <AlertCircle className='mt-0.5 h-4 w-4 flex-shrink-0 text-destructive' />
                    <p className='text-left text-sm text-destructive/80'>
                      {errorDetails}
                    </p>
                  </div>
                </div>
              )}

              <div className='mt-6 flex flex-col gap-3'>
                <button
                  onClick={handleRetry}
                  className='w-full rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90'
                >
                  Try Again
                </button>
                <button
                  onClick={handleContinue}
                  className='w-full rounded-lg bg-muted px-4 py-2.5 font-medium text-muted-foreground transition-colors hover:bg-muted/80'
                >
                  Continue Without Stripe
                </button>
              </div>
            </>
          )}
        </div>

        {/* Stripe Branding */}
        <p className='mt-4 text-center text-xs text-muted-foreground/60'>
          Secure connection powered by Stripe Connect
        </p>
      </div>
    </div>
  )
}

export default function StripeCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className='flex min-h-screen items-center justify-center bg-background'>
          <div className='mx-4 w-full max-w-md'>
            <div className='rounded-2xl border border-border bg-card p-8 text-center shadow-lg'>
              <div className='mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10'>
                <Loader2 className='h-8 w-8 animate-spin text-primary' />
              </div>
              <h2 className='mb-2 text-xl font-semibold text-foreground'>
                Connecting your Stripe account...
              </h2>
              <p className='text-sm text-muted-foreground'>
                Please wait while we verify your Stripe account...
              </p>
            </div>
          </div>
        </div>
      }
    >
      <StripeCallbackContent />
    </Suspense>
  )
}
