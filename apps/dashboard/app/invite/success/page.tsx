'use client'

import { Suspense, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

function InviteSuccessContent() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const error = searchParams.get('error')

  // Success never routes here — /api/invite-verify establishes the session
  // and lands the invitee on /home directly. This page is the ERROR
  // surface only; a no-error hit (stale/bookmarked link) forwards to /home,
  // where auth is enforced.
  useEffect(() => {
    if (!error) {
      window.location.href = '/'
    }
  }, [error])

  // Error state
  if (error) {
    const errorMessages: Record<string, string> = {
      missing_token: 'The invitation link is invalid. Please request a new invitation.',
      invalid_token: 'This invitation link has expired or is invalid. Please request a new invitation.',
      invitation_not_found: 'The invitation was not found. It may have been cancelled.',
      invitation_already_used: 'This invitation has already been accepted.',
      invitation_expired: 'This invitation has expired. Please request a new invitation.',
      verification_failed: 'Failed to verify the invitation. Please try again or request a new invitation.',
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="mx-auto w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <span className="text-2xl">⚠️</span>
            </div>
            <CardTitle className="text-2xl">Invitation Error</CardTitle>
            <CardDescription>
              {errorMessages[error] || error || 'Something went wrong with your invitation.'}
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex justify-center">
            <Button variant="outline" onClick={() => router.push('/sign-in')}>
              Go to Sign In
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  // No error: the useEffect above is forwarding to /home. Render a lightweight
  // placeholder while that navigation happens.
  return <LoadingFallback />
}

// Loading fallback for Suspense
function LoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="mx-auto w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
          <CardTitle className="text-2xl">Loading...</CardTitle>
        </CardHeader>
      </Card>
    </div>
  )
}

// Wrap in Suspense for useSearchParams
export default function InviteSuccessPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <InviteSuccessContent />
    </Suspense>
  )
}
