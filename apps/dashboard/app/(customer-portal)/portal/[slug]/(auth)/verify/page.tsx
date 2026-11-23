'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOrg } from '@/app/(customer-portal)/context/OrgContext'

// Helper to convert hex to rgba
function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return `rgba(0, 0, 0, ${alpha})`
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
}

export default function CustomerPortalVerify() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get('token')
  const [status, _setStatus] = useState<'verifying' | 'success' | 'error'>(
    () => (token ? 'verifying' : 'error')
  )
  const [errorMessage, _setErrorMessage] = useState(() =>
    token ? '' : 'No verification token provided.'
  )
  const { organizationName, organizationLogo, brandColors, organizationSlug } =
    useOrg()

  useEffect(() => {
    if (!token) return

    // Send the customer to the /r/<token> redeemer. The redeemer
    // sets the portal session cookie and redirects to /<slug>/.
    const timer = setTimeout(() => {
      window.location.href = `/r/${token}`
    }, 500)

    return () => clearTimeout(timer)
  }, [token])

  const renderLeftPanel = () => (
    <div className='relative hidden h-screen bg-background p-4 lg:flex'>
      <div
        className='relative flex h-full w-full flex-col overflow-hidden rounded-2xl'
        style={{ backgroundColor: brandColors.primary }}
      >
        <div
          className='absolute inset-0 opacity-[0.08]'
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.4) 1px, transparent 0)`,
            backgroundSize: '24px 24px',
          }}
        />
        <div className='relative z-10 flex h-full flex-col justify-between p-10'>
          <div className='flex items-center gap-3'>
            {organizationLogo ? (
              <img
                src={organizationLogo}
                alt={organizationName}
                className='h-8 w-auto object-contain brightness-0 invert'
              />
            ) : (
              <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-white/20'>
                <span className='text-base font-semibold text-white'>
                  {organizationName.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
            <span className='text-lg font-medium text-white'>
              {organizationName}
            </span>
          </div>
          <div className='space-y-3'>
            <h1 className='text-3xl font-semibold leading-tight text-white xl:text-4xl'>
              Customer Portal
            </h1>
            <p className='max-w-xs text-base text-white/70'>
              View invoices, track usage, and manage your billing.
            </p>
          </div>
          <p className='text-xs text-white/50'>Powered by MarginFront</p>
        </div>
      </div>
    </div>
  )

  const renderMobileLogo = () => (
    <div className='mb-12 flex items-center gap-3 lg:hidden'>
      {organizationLogo ? (
        <img
          src={organizationLogo}
          alt={organizationName}
          className='h-7 w-auto object-contain'
        />
      ) : (
        <div
          className='flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold text-white'
          style={{ backgroundColor: brandColors.primary }}
        >
          {organizationName.charAt(0).toUpperCase()}
        </div>
      )}
      <span className='text-base font-medium text-foreground'>
        {organizationName}
      </span>
    </div>
  )

  if (status === 'error') {
    return (
      <div className='min-h-screen w-full lg:grid lg:grid-cols-[45%_55%]'>
        {renderLeftPanel()}
        <div className='relative flex h-screen flex-col bg-background p-6 lg:p-10'>
          {renderMobileLogo()}
          <div className='w-full max-w-sm space-y-6 lg:my-auto'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10'>
              <XCircle className='h-6 w-6 text-destructive' />
            </div>
            <div className='space-y-2'>
              <h1 className='text-xl font-semibold text-foreground'>
                Verification Failed
              </h1>
              <p className='text-sm text-muted-foreground'>{errorMessage}</p>
            </div>
            <Button
              onClick={() => router.push(`/${organizationSlug}/login`)}
              className='h-10'
              style={{ backgroundColor: brandColors.primary }}
            >
              Back to Login
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='min-h-screen w-full lg:grid lg:grid-cols-[45%_55%]'>
      {renderLeftPanel()}
      <div className='relative flex h-screen flex-col bg-background p-6 lg:p-10'>
        {renderMobileLogo()}
        <div className='w-full max-w-sm space-y-6 lg:my-auto'>
          <div
            className='flex h-12 w-12 items-center justify-center rounded-xl'
            style={{ backgroundColor: hexToRgba(brandColors.primary, 0.12) }}
          >
            <Loader2
              className='h-6 w-6 animate-spin'
              style={{ color: brandColors.primary }}
            />
          </div>
          <div className='space-y-2'>
            <h1 className='text-xl font-semibold text-foreground'>
              Verifying...
            </h1>
            <p className='text-sm text-muted-foreground'>
              Please wait while we sign you in.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
