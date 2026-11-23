'use client'

import { PremiumAuthLayout } from '@/components/layouts/premium-auth-layout'
import { getOperatorSettings } from '@/config/operator'
import { SignInForm } from './components/sign-in-form'

const LEGAL_LINK_CLASS =
  'underline underline-offset-4 transition-colors hover:text-foreground'

// Shows only the legal pages the operator of this install has published
// (NEXT_PUBLIC_TERMS_URL, NEXT_PUBLIC_PRIVACY_URL). With neither set there is
// nothing to agree to, so nothing is shown.
function LegalLinks() {
  const { termsUrl, privacyUrl } = getOperatorSettings()
  if (!termsUrl && !privacyUrl) return null

  const terms = termsUrl && (
    <a
      href={termsUrl}
      target='_blank'
      rel='noopener noreferrer'
      className={LEGAL_LINK_CLASS}
    >
      Terms
    </a>
  )
  const privacy = privacyUrl && (
    <a
      href={privacyUrl}
      target='_blank'
      rel='noopener noreferrer'
      className={LEGAL_LINK_CLASS}
    >
      Privacy Policy
    </a>
  )

  return (
    <div className='mt-6'>
      <p className='text-center text-xs text-muted-foreground'>
        By continuing, you agree to our {terms}
        {terms && privacy && ' and '}
        {privacy}
      </p>
    </div>
  )
}

export default function SignIn() {
  return (
    <PremiumAuthLayout>
      <div className='w-full'>
        <div className='mb-6 flex flex-col space-y-1 text-left'>
          <h1 className='text-xl font-semibold tracking-tight text-foreground'>
            Welcome to MarginFront
          </h1>
          <p className='text-sm text-muted-foreground'>
            Sign in or create an account to continue
          </p>
        </div>

        <SignInForm />

        <LegalLinks />
      </div>
    </PremiumAuthLayout>
  )
}
