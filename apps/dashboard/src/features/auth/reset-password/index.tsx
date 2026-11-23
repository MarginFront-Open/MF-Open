'use client'

import Link from 'next/link'
import { Logo } from '@/components/layout/logo'
import { ResetPasswordForm } from './components/reset-password-form'

export default function ResetPassword() {
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
            Reset Password
          </h2>
          <p className='text-sm text-muted-foreground'>
            Enter the verification code sent to your email along with your new
            password.
          </p>
        </div>

        {/* Form Card */}
        <div className='rounded-xl border border-theme-primary/5 bg-white p-6 shadow-lg shadow-primary/10 dark:border-border dark:bg-card'>
          <ResetPasswordForm />
        </div>

        {/* Footer Links */}
        <div className='space-y-3 text-center'>
          <p className='text-sm text-muted-foreground'>
            Remember your password?{' '}
            <Link
              href='/sign-in'
              className='hover:text-theme-primary-dark font-semibold text-theme-primary dark:text-primary'
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
