'use client'

import Link from 'next/link'
import { Logo } from '@/components/layout/logo'
import { ForgotForm } from './components/forgot-password-form'

export default function ForgotPassword() {
  return (
    <div className='via-secondary/3 flex h-svh items-center justify-center bg-gradient-to-br from-secondary/5 to-background p-6 dark:from-background dark:via-background dark:to-background'>
      <div className='w-full max-w-[400px] space-y-6'>
        {/* Logo */}
        <div className='flex items-center justify-center'>
          <Logo linkToHome={false} size='lg' />
        </div>

        {/* Header */}
        <div className='space-y-1.5 text-center'>
          <h2 className='font-heading text-h2 text-foreground'>
            Forgot Password
          </h2>
          <p className='text-sm text-muted-foreground'>
            Enter your registered email and we&apos;ll send you a link to reset
            your password.
          </p>
        </div>

        {/* Form Card */}
        <div className='rounded-xl border border-border bg-card p-6 shadow-lg'>
          <ForgotForm />
        </div>

        {/* Footer Links */}
        <div className='text-center'>
          <p className='text-sm text-muted-foreground'>
            Remember your password?{' '}
            <Link
              href='/sign-in'
              className='font-semibold text-primary hover:text-primary/80'
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
