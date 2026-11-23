'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { authClient } from '@/app/lib/auth-client'

/**
 * Shown when someone reaches an invite/post-auth landing with invite context,
 * but the authenticated account's email does NOT match the invited email
 *It never routes into the org and never creates a junk
 * workspace — the only forward action is to sign out and continue as the
 * invited email.
 *
 * Shared by the OAuth landing (auth/google/success) and the invite accept page
 * so the wording and the switch-account action live in one place.
 */
export function WrongAccountNotice({
  invitedEmail,
  currentEmail,
}: {
  invitedEmail: string
  currentEmail: string
}) {
  const [isSwitching, setIsSwitching] = useState(false)

  const handleSwitchAccount = async () => {
    setIsSwitching(true)
    try {
      await authClient.signOut()
    } catch {
      // Even if sign-out fails, still send them to a sign-in pinned to the
      // invited email — the sign-in there will re-establish the correct session.
    }
    // Pin the sign-in to the invited email. After they sign in correctly, the
    // pending-invite router lands them on the accept page.
    const params = new URLSearchParams({ email: invitedEmail })
    window.location.href = `/sign-in?${params.toString()}`
  }

  return (
    <div className='flex min-h-screen items-center justify-center bg-background p-4'>
      <Card className='mx-auto w-full max-w-md'>
        <CardHeader className='text-center'>
          <div className='mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100'>
            <span className='text-2xl'>⚠️</span>
          </div>
          <CardTitle className='text-2xl'>Wrong account</CardTitle>
          <CardDescription>
            This invitation is for{' '}
            <span className='font-medium text-foreground'>{invitedEmail}</span>,
            but you&apos;re signed in as{' '}
            <span className='font-medium text-foreground'>{currentEmail}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          <Button
            onClick={handleSwitchAccount}
            disabled={isSwitching}
            className='w-full'
          >
            {isSwitching ? 'Switching…' : `Continue as ${invitedEmail}`}
          </Button>
          <p className='text-center text-xs text-muted-foreground'>
            Need this invite sent to {currentEmail} instead? Ask whoever invited
            you to send a new invitation to that address.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
