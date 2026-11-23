'use client'

import { HTMLAttributes, useRef, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { authClient } from '@/app/lib/auth-client'
import { buildSocialSignInRequest } from '../lib/social-sign-in'
import { IfSocialProvider } from '../lib/social-providers-context'
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile'
import { Loader2, ArrowRight, Mail } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'

/**
 * Unified Auth Form - Handles both sign-in and sign-up
 *
 * Flow:
 * 1. User enters email OR uses social auth
 * 2. Magic link sent (works for new and existing users)
 * 3. After auth, getPostAuthRedirect() routes:
 *    - New users (no org) → /quick-onboarding
 *    - Existing users (has org) → /home
 *
 * Bot protection: Cloudflare Turnstile widget gates the magic-link send
 * (and resend). Token is passed to authClient.signIn.magicLink and verified
 * server-side in auth.ts's hooks.before middleware. If
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset (local dev), the widget is hidden
 * and submit isn't gated — matches the server-side dev-mode bypass.
 */

type SignInFormProps = HTMLAttributes<HTMLDivElement>

const emailSchema = z.object({
  email: z
    .string()
    .min(1, { message: 'Please enter your email' })
    .email({ message: 'Invalid email address' }),
})

export function SignInForm({ className, ...props }: SignInFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [isGoogleLoading, setIsGoogleLoading] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [sentToEmail, setSentToEmail] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileInstance | null>(null)
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const turnstileEnabled = Boolean(turnstileSiteKey)
  const { toast } = useToast()
  const searchParams = useSearchParams()

  // Pre-fill email from URL params (e.g., from invitation link)
  const prefillEmail = searchParams.get('email') || ''

  const emailForm = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: prefillEmail },
  })

  const handleEmailSubmit = async (data: z.infer<typeof emailSchema>) => {
    setIsLoading(true)
    try {
      // Cast: Better-Auth's generated client types don't know about custom
      // body fields, but the server's hooks.before reads ctx.body.turnstileToken.
      const { error } = await authClient.signIn.magicLink({
        email: data.email,
        callbackURL: '/auth/google/success',
        turnstileToken: turnstileToken ?? '',
      } as any)

      if (error) {
        toast({
          variant: 'destructive',
          title: 'Failed to send link',
          description: error.message,
        })
        // Reset Turnstile so the user gets a fresh token on retry — the old
        // token may already be consumed or invalidated.
        turnstileRef.current?.reset()
        setTurnstileToken(null)
        return
      }

      setSentToEmail(data.email)
      setEmailSent(true)
      // Reset now so the "Resend email" button starts with a fresh token.
      turnstileRef.current?.reset()
      setTurnstileToken(null)
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Failed to send link',
        description: error.message || 'Something went wrong',
      })
      turnstileRef.current?.reset()
      setTurnstileToken(null)
    } finally {
      setIsLoading(false)
    }
  }

  const handleResendEmail = async () => {
    if (!sentToEmail) return
    setIsLoading(true)
    try {
      const { error } = await authClient.signIn.magicLink({
        email: sentToEmail,
        callbackURL: '/auth/google/success',
        turnstileToken: turnstileToken ?? '',
      } as any)

      if (error) {
        toast({
          variant: 'destructive',
          title: 'Failed to resend',
          description: error.message,
        })
        turnstileRef.current?.reset()
        setTurnstileToken(null)
        return
      }

      toast({
        title: 'Email sent',
        description: 'Check your inbox for the login link',
      })
      // Refresh for the next potential resend.
      turnstileRef.current?.reset()
      setTurnstileToken(null)
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Failed to resend',
        description: error.message,
      })
      turnstileRef.current?.reset()
      setTurnstileToken(null)
    } finally {
      setIsLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setIsGoogleLoading(true)
    try {
      await authClient.signIn.social(
        buildSocialSignInRequest('google', searchParams)
      )
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: 'Google login failed',
        description: 'Could not connect to Google',
      })
      setIsGoogleLoading(false)
    }
  }

  const isAnyLoading = isLoading || isGoogleLoading
  // Magic-link / email-send is gated on a valid Turnstile token when Turnstile
  // is configured. Google OAuth is NOT gated — Cloudflare can't widget the
  // Google OAuth screen, and Google fights bots on their end.
  const isEmailSubmitBlocked =
    isAnyLoading || (turnstileEnabled && !turnstileToken)

  // Email sent confirmation view
  if (emailSent) {
    return (
      <div className={cn('w-full', className)} {...props}>
        <div className='flex flex-col items-center space-y-4 py-4 text-center'>
          <div className='flex h-14 w-14 items-center justify-center rounded-full bg-primary/10'>
            <Mail className='h-7 w-7 text-primary' />
          </div>
          <div className='space-y-2'>
            <h3 className='text-lg font-semibold'>Check your email</h3>
            <p className='text-sm text-muted-foreground'>
              We sent a login link to
              <br />
              <span className='font-medium text-foreground'>{sentToEmail}</span>
            </p>
          </div>
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
          <div className='flex w-full flex-col gap-2 pt-2'>
            <Button
              variant='outline'
              onClick={handleResendEmail}
              disabled={isEmailSubmitBlocked}
              className='w-full'
            >
              {isLoading ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : (
                'Resend email'
              )}
            </Button>
            <Button
              variant='ghost'
              onClick={() => {
                setEmailSent(false)
                setSentToEmail('')
                emailForm.reset()
                turnstileRef.current?.reset()
                setTurnstileToken(null)
              }}
              className='w-full text-muted-foreground'
            >
              Use a different email
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('w-full', className)} {...props}>
      <div className='space-y-4'>
        <IfSocialProvider provider='google'>
          {/* Google */}
          <Button
            type='button'
            disabled={isAnyLoading}
            onClick={handleGoogleLogin}
            className='h-11 w-full bg-foreground font-medium text-background hover:bg-foreground/90'
          >
            {isGoogleLoading ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : (
              <>
                <svg className='mr-2 h-4 w-4' viewBox='0 0 24 24'>
                  <path
                    d='M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z'
                    fill='#4285F4'
                  />
                  <path
                    d='M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z'
                    fill='#34A853'
                  />
                  <path
                    d='M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z'
                    fill='#FBBC05'
                  />
                  <path
                    d='M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z'
                    fill='#EA4335'
                  />
                </svg>
                Continue with Google
              </>
            )}
          </Button>

          {/* Divider */}
          <div className='relative my-6'>
            <div className='absolute inset-0 flex items-center'>
              <div className='w-full border-t border-border' />
            </div>
            <div className='relative flex justify-center text-xs'>
              <span className='bg-background px-2 text-muted-foreground'>
                or
              </span>
            </div>
          </div>
        </IfSocialProvider>

        {/* Email Input - Magic Link */}
        <Form {...emailForm}>
          <form onSubmit={emailForm.handleSubmit(handleEmailSubmit)}>
            <FormField
              control={emailForm.control}
              name='email'
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className='flex gap-2'>
                      <Input
                        type='email'
                        placeholder='Email Address'
                        className='h-11 flex-1'
                        disabled={isAnyLoading}
                        {...field}
                      />
                      <Button
                        type='submit'
                        className='h-11 px-4'
                        disabled={isEmailSubmitBlocked}
                      >
                        {isLoading ? (
                          <Loader2 className='h-4 w-4 animate-spin' />
                        ) : (
                          <ArrowRight className='h-4 w-4' />
                        )}
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {turnstileEnabled && (
              <div className='mt-3 flex justify-center'>
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
          </form>
        </Form>

        <p className='text-center text-xs text-muted-foreground'>
          We&apos;ll send you a magic link to sign in
        </p>
      </div>
    </div>
  )
}
