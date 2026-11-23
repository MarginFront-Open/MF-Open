'use client'

import { useState, useEffect, useRef } from 'react'
import { authClient } from '@/app/lib/auth-client'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import Link from 'next/link'
import { storage } from '@/lib/storage'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/layout/logo'
import { OtpForm } from './components/otp-form'

export default function Otp() {
  const [email, setEmail] = useState('')
  const [isResending, setIsResending] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileInstance | null>(null)
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const turnstileEnabled = Boolean(turnstileSiteKey)
  const { toast } = useToast()

  useEffect(() => {
    const verificationEmail = storage.getItem('verificationEmail')
    if (verificationEmail) {
      setEmail(verificationEmail)
    }
  }, [])

  const handleResendOtp = async () => {
    if (!email) return
    setIsResending(true)
    try {
      // Cast: Better-Auth's client types don't know about custom body fields;
      // the server's hooks.before reads ctx.body.turnstileToken regardless.
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'email-verification',
        turnstileToken: turnstileToken ?? '',
      } as any)

      if (result.error) {
        toast({
          variant: 'destructive',
          title: 'Failed to resend',
          description: result.error.message || 'Could not resend OTP',
        })
        // Reset Turnstile so user gets a fresh token on next try.
        turnstileRef.current?.reset()
        setTurnstileToken(null)
      } else {
        toast({
          title: 'Success',
          description: 'Verification code sent to your email',
        })
        // Refresh widget for the NEXT potential resend.
        turnstileRef.current?.reset()
        setTurnstileToken(null)
      }
    } catch (error) {
      console.error('Error resending OTP:', error)
      toast({
        variant: 'destructive',
        title: 'Failed to resend',
        description: 'An error occurred while resending the code',
      })
      turnstileRef.current?.reset()
      setTurnstileToken(null)
    } finally {
      setIsResending(false)
    }
  }

  const isResendBlocked = isResending || (turnstileEnabled && !turnstileToken)

  return (
    <div className='gradient-brand-subtle flex h-svh items-center justify-center p-6'>
      <div className='w-full max-w-[400px] space-y-6'>
        {/* Logo */}
        <div className='flex items-center justify-center'>
          <Logo linkToHome={false} size='lg' />
        </div>

        {/* Header */}
        <div className='space-y-1.5 text-center'>
          <h2 className='text-2xl font-bold text-theme-primary dark:text-foreground'>
            Email Verification
          </h2>
          <p className='text-sm text-muted-foreground'>
            Please enter the verification code sent to{' '}
            <span className='font-medium text-theme-primary dark:text-foreground'>
              {email}
            </span>
          </p>
        </div>

        {/* Form Card */}
        <div className='rounded-xl border border-theme-primary/5 bg-white p-6 shadow-lg shadow-primary/10 dark:border-border dark:bg-card'>
          <OtpForm />
        </div>

        {/* Footer Links */}
        <div className='space-y-3 text-center'>
          {turnstileEnabled && (
            <div className='flex justify-center'>
              <Turnstile
                ref={turnstileRef}
                siteKey={turnstileSiteKey!}
                onSuccess={setTurnstileToken}
                onError={() => setTurnstileToken(null)}
                onExpire={() => setTurnstileToken(null)}
                options={{ theme: 'auto' }}
              />
            </div>
          )}
          <p className='text-sm text-muted-foreground'>
            Haven&apos;t received it?{' '}
            <Button
              variant='link'
              className='hover:text-theme-primary-dark h-auto p-0 font-semibold text-theme-primary dark:text-primary'
              onClick={handleResendOtp}
              disabled={isResendBlocked}
            >
              {isResending ? 'Sending...' : 'Resend a new code'}
            </Button>
          </p>
          <p className='text-sm text-muted-foreground'>
            <Link
              href='/sign-in'
              className='font-medium text-theme-primary hover:underline dark:text-primary'
            >
              Back to Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
