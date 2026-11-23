'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Building2, Check, Loader2, Mail, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { authClient } from '@/app/lib/auth-client'
import { getPublicInvitationDetails, type PublicInvitationDetails } from '@/app/actions/team'
import { WrongAccountNotice } from '@/features/auth/components/wrong-account-notice'
import { buildSocialSignInRequest } from '@/features/auth/sign-in/lib/social-sign-in'
import { useSocialProviderEnabled } from '@/features/auth/sign-in/lib/social-providers-context'

type FlowState =
  | 'loading'           // Initial loading
  | 'show-invite'       // No session: show the auth-as-invited options (Google + magic link)
  | 'sending-magic'     // Sending magic link email
  | 'check-email'       // Waiting for user to check email
  | 'joining'           // Accepting invitation (session email === invited email)
  | 'success'           // All done, redirecting
  | 'wrong-account'     // Signed in as an email that doesn't match the invite
  | 'error'             // Error state

export default function InviteAcceptPage() {
  const params = useParams()
  const router = useRouter()

  const invitationId = params.invitationId as string

  const [flowState, setFlowState] = useState<FlowState>('loading')
  const [invitation, setInvitation] = useState<PublicInvitationDetails | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [currentEmail, setCurrentEmail] = useState<string>('')
  const [isGoogleLoading, setIsGoogleLoading] = useState(false)
  const googleEnabled = useSocialProviderEnabled('google')

  // Fetch invitation details
  useEffect(() => {
    const fetchInvitation = async () => {
      try {
        const result = await getPublicInvitationDetails(invitationId)
        if (result.success && result.data) {
          setInvitation(result.data)

          // Check if user is already authenticated
          const session = await authClient.getSession()
          if (session.data?.user) {
            // User is authenticated, check if email matches
            if (session.data.user.email?.toLowerCase() === result.data.email.toLowerCase()) {
              // Email matches, proceed to join
              setFlowState('joining')
            } else {
              // Wrong account — show the shared switch-account interstitial.
              // Never joins as this identity, never creates a junk org.
              setCurrentEmail(session.data.user.email ?? '')
              setFlowState('wrong-account')
            }
          } else {
            // Not authenticated: show the auth-as-invited options. The link alone
            // never joins — the visitor must sign in AS the invited email first
            setFlowState('show-invite')
          }
        } else {
          setErrorMessage(result.error || 'Invitation not found or expired')
          setFlowState('error')
        }
      } catch (error) {
        console.error('[InviteAccept] Error fetching invitation:', error)
        setErrorMessage('Failed to load invitation')
        setFlowState('error')
      }
    }

    fetchInvitation()
  }, [invitationId])

  // No-session join options. The invite link never
  // authenticates anyone — the visitor must prove they own the invited email
  // before any membership is added. Both paths pin the invited email; the join
  // itself stays gated on session.email === invitation.email (the 'joining'
  // branch above), which only ever runs after a real sign-in as that email.
  const handleContinueWithGoogle = () => {
    if (!invitation) return
    setIsGoogleLoading(true)

    // Reuse the sign-in page's builder so login_hint (pins Google's account
    // chooser to the invited email) and the invite-carrying callbackURL are
    // decided in one place. It reads `email` and `redirectTo` off a params-like
    // object; we feed it the invited email + an accept-page return target.
    // auth/google/success then routes a matching sign-in back here to finish the
    // join, or renders the wrong-account interstitial on a mismatch.
    const socialParams = {
      get: (key: string) =>
        key === 'email'
          ? invitation.email
          : key === 'redirectTo'
            ? `/invite/accept/${invitationId}`
            : null,
    }

    // Full-page redirect to Google; nothing after this runs on success.
    authClient.signIn
      .social(buildSocialSignInRequest('google', socialParams))
      .catch((error) => {
        console.error('[InviteAccept] Google sign-in failed:', error)
        setErrorMessage('Could not connect to Google. Please try again.')
        setFlowState('error')
      })
  }

  const handleEmailSignInLink = async () => {
    if (!invitation) return

    setFlowState('sending-magic')

    try {
      // Magic link is sent ONLY to the invited email; clicking it authenticates
      // the visitor as that email and lands them back here to finish the join.
      const callbackURL = `${window.location.origin}/invite/accept/${invitationId}`

      const result = await authClient.signIn.magicLink({
        email: invitation.email,
        callbackURL,
      })

      if (result.error) {
        throw new Error(result.error.message || 'Failed to send magic link')
      }

      setFlowState('check-email')
    } catch (error: any) {
      console.error('[InviteAccept] Error sending magic link:', error)
      setErrorMessage(error.message || 'Failed to send login link')
      setFlowState('error')
    }
  }

  // Accept invitation after authentication
  useEffect(() => {
    const acceptInvitation = async () => {
      if (flowState !== 'joining' || !invitation) return

      try {
        console.log('[InviteAccept] Accepting invitation:', invitationId)

        // Accept the invitation using Better Auth
        const result = await authClient.organization.acceptInvitation({
          invitationId,
        })

        if (result.error) {
          throw new Error(result.error.message || 'Failed to accept invitation')
        }

        console.log('[InviteAccept] Invitation accepted!')

        // Set the organization as active
        if (invitation.organizationId) {
          await authClient.organization.setActive({
            organizationId: invitation.organizationId,
          })
          console.log('[InviteAccept] Set active organization:', invitation.organizationId)
        }

        setFlowState('success')

        // Redirect to dashboard after a brief delay
        setTimeout(() => {
          window.location.href = '/'
        }, 1500)

      } catch (error: any) {
        console.error('[InviteAccept] Error accepting invitation:', error)
        setErrorMessage(error.message || 'Failed to join organization')
        setFlowState('error')
      }
    }

    acceptInvitation()
  }, [flowState, invitation, invitationId])

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'owner':
        return <Badge className="bg-purple-100 text-purple-700">Owner</Badge>
      case 'admin':
        return <Badge className="bg-blue-100 text-blue-700">Admin</Badge>
      default:
        return <Badge className="bg-green-100 text-green-700">Member</Badge>
    }
  }

  // Loading state
  if (flowState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="mx-auto w-full max-w-md">
          <CardHeader className="space-y-4">
            <Skeleton className="mx-auto h-16 w-16 rounded-full" />
            <Skeleton className="mx-auto h-8 w-3/4" />
            <Skeleton className="mx-auto h-4 w-full" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  // Wrong-account state — signed in as someone other than the invited email
  if (flowState === 'wrong-account' && invitation) {
    return (
      <WrongAccountNotice
        invitedEmail={invitation.email}
        currentEmail={currentEmail}
      />
    )
  }

  // Error state
  if (flowState === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="mx-auto w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <span className="text-2xl">⚠️</span>
            </div>
            <CardTitle className="text-2xl">Something went wrong</CardTitle>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button variant="outline" onClick={() => router.push('/sign-in')}>
              Go to Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Main invite UI with different states
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="mx-auto w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Building2 className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl">You&apos;re Invited!</CardTitle>
          <CardDescription>
            {invitation?.inviterName
              ? `${invitation.inviterName} invited you to join`
              : 'You have been invited to join'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Organization Info */}
          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            <h3 className="text-xl font-semibold">{invitation?.organizationName}</h3>
            <div className="mt-2 flex items-center justify-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Role:</span>
              {invitation && getRoleBadge(invitation.role)}
            </div>
          </div>

          {/* Flow States */}
          {flowState === 'show-invite' && (
            <div className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                To join, sign in as{' '}
                <span className="font-medium text-foreground">
                  {invitation?.email}
                </span>
                .
              </p>

              {googleEnabled ? (
                <>
                  {/* Continue with Google — pinned to the invited email via login_hint */}
                  <Button
                    type="button"
                    disabled={isGoogleLoading}
                    onClick={handleContinueWithGoogle}
                    className="h-11 w-full bg-foreground font-medium text-background hover:bg-foreground/90"
                  >
                    {isGoogleLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                          <path
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                            fill="#4285F4"
                          />
                          <path
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                            fill="#34A853"
                          />
                          <path
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                            fill="#FBBC05"
                          />
                          <path
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                            fill="#EA4335"
                          />
                        </svg>
                        Continue with Google
                      </>
                    )}
                  </Button>

                  {/* Secondary path below the Google button: a small text
                      link, not a co-equal button. It fires the same magic-link-to-invited-email handler. */}
                  <p className="text-center text-sm text-muted-foreground">
                    No Google account?{' '}
                    <button
                      type="button"
                      disabled={isGoogleLoading}
                      onClick={handleEmailSignInLink}
                      className="font-medium text-foreground underline underline-offset-4 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
                    >
                      Email me a sign-in link instead
                    </button>
                  </p>
                </>
              ) : (
                <Button
                  type="button"
                  onClick={handleEmailSignInLink}
                  className="h-11 w-full bg-foreground font-medium text-background hover:bg-foreground/90"
                >
                  <Mail className="mr-2 h-4 w-4" />
                  Email me a sign-in link
                </Button>
              )}
            </div>
          )}

          {flowState === 'sending-magic' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Sending login link...</p>
            </div>
          )}

          {flowState === 'check-email' && (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Mail className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="font-medium">Check your email</p>
                <p className="text-sm text-muted-foreground">
                  We sent a login link to
                </p>
                <p className="font-medium">{invitation?.email}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                Click the link in the email to accept this invitation
              </p>
            </div>
          )}

          {flowState === 'joining' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Joining {invitation?.organizationName}...
              </p>
            </div>
          )}

          {flowState === 'success' && (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <Check className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="font-medium text-green-600">
                  Welcome to {invitation?.organizationName}!
                </p>
                <p className="text-sm text-muted-foreground">
                  Redirecting to dashboard...
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
