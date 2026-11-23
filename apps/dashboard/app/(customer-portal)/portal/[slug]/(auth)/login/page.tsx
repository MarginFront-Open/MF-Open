'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Mail, Loader2, ArrowRight, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form'
import { useOrg } from '@/app/(customer-portal)/context/OrgContext'
import { LegalConsentLine } from '@/components/legal-consent-line'

// ============================================================================
// Color Utilities - For dynamic org branding
// ============================================================================

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const sanitized = hex.replace('#', '')
  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(sanitized)
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((x) =>
        Math.max(0, Math.min(255, Math.round(x)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}

// Check if color is light (for text contrast)
function isLightColor(hex: string): boolean {
  const rgb = hexToRgb(hex)
  if (!rgb) return false
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
  return luminance > 0.55
}

// Lighten a color by percentage
function _lightenColor(hex: string, percent: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const amount = 255 * (percent / 100)
  return rgbToHex(rgb.r + amount, rgb.g + amount, rgb.b + amount)
}

// Darken a color by percentage
function darkenColor(hex: string, percent: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const factor = 1 - percent / 100
  return rgbToHex(rgb.r * factor, rgb.g * factor, rgb.b * factor)
}

// Generate accent color from primary if not provided
function generateAccentColor(primaryHex: string): string {
  const rgb = hexToRgb(primaryHex)
  if (!rgb) return '#a3e635' // fallback lime

  // Create a lighter, more vibrant version
  // Shift towards yellow/lime for most colors (works well as accent)
  const isLight = isLightColor(primaryHex)

  if (isLight) {
    // For light primaries, darken and saturate
    return darkenColor(primaryHex, 40)
  } else {
    // For dark primaries, create a bright contrasting accent
    // Boost the highest channel and add warmth
    const max = Math.max(rgb.r, rgb.g, rgb.b)
    if (max === rgb.g || rgb.g > rgb.r * 0.8) {
      // Greenish primary -> lime accent
      return '#a3e635'
    } else if (max === rgb.b) {
      // Bluish primary -> cyan/teal accent
      return '#22d3ee'
    } else {
      // Reddish/orange primary -> yellow accent
      return '#facc15'
    }
  }
}

// ============================================================================
// Constants
// ============================================================================

const errorMessages: Record<string, string> = {
  invalid_token: 'This link is invalid. Please request a new one.',
  expired_token: 'This link has expired. Please request a new one.',
  used_token: 'This link has already been used. Please request a new one.',
  server_error: 'Something went wrong. Please try again.',
}

const emailSchema = z.object({
  email: z
    .string()
    .min(1, { message: 'Please enter your email' })
    .email({ message: 'Invalid email address' }),
})

// ============================================================================
// SVG Icons - Accept dynamic colors
// ============================================================================

const InvoiceIcon = ({ color }: { color: string }) => (
  <svg
    className='h-4 w-4'
    fill='none'
    viewBox='0 0 24 24'
    stroke={color}
    strokeWidth={2}
  >
    <path
      strokeLinecap='round'
      strokeLinejoin='round'
      d='M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
    />
  </svg>
)

const ChartIcon = ({ color }: { color: string }) => (
  <svg
    className='h-4 w-4'
    fill='none'
    viewBox='0 0 24 24'
    stroke={color}
    strokeWidth={2}
  >
    <path
      strokeLinecap='round'
      strokeLinejoin='round'
      d='M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'
    />
  </svg>
)

const CardIcon = ({ color }: { color: string }) => (
  <svg
    className='h-4 w-4'
    fill='none'
    viewBox='0 0 24 24'
    stroke={color}
    strokeWidth={2}
  >
    <path
      strokeLinecap='round'
      strokeLinejoin='round'
      d='M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z'
    />
  </svg>
)

const SettingsIcon = ({ color }: { color: string }) => (
  <svg
    className='h-4 w-4'
    fill='none'
    viewBox='0 0 24 24'
    stroke={color}
    strokeWidth={2}
  >
    <path
      strokeLinecap='round'
      strokeLinejoin='round'
      d='M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z'
    />
    <path
      strokeLinecap='round'
      strokeLinejoin='round'
      d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
    />
  </svg>
)

const CheckIcon = ({ color }: { color: string }) => (
  <svg
    className='h-2.5 w-2.5'
    fill='none'
    viewBox='0 0 24 24'
    stroke={color}
    strokeWidth={3}
  >
    <path strokeLinecap='round' strokeLinejoin='round' d='M5 13l4 4L19 7' />
  </svg>
)

export default function CustomerPortalLogin() {
  const [isLoading, setIsLoading] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [sentToEmail, setSentToEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [logoError, setLogoError] = useState(false)
  const searchParams = useSearchParams()
  const { organizationName, organizationLogo, brandColors, organizationSlug } =
    useOrg()

  // Show fallback letter if no logo or logo failed to load
  const showLogoFallback = !organizationLogo || logoError

  const form = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '' },
  })

  // Compute dynamic colors based on org branding
  const colors = useMemo(() => {
    const primary = brandColors.primary || '#0d3320'
    const primaryIsLight = isLightColor(primary)

    // Accent color - ALWAYS use a contrasting color, never same as primary
    // Use org accent if provided and different from primary, otherwise generate
    let accent = brandColors.accent
    if (
      !accent ||
      accent === primary ||
      accent.toLowerCase() === primary.toLowerCase()
    ) {
      accent = generateAccentColor(primary)
    }

    // Ensure accent is visible against primary (not too similar)
    const accentIsLight = isLightColor(accent)

    return {
      primary,
      accent,
      primaryIsLight,
      // Text colors - always white for dark bg, dark for light bg
      textOnPrimary: primaryIsLight ? '#111827' : '#ffffff',
      textMutedOnPrimary: primaryIsLight
        ? 'rgba(17,24,39,0.7)'
        : 'rgba(255,255,255,0.7)',
      textSubtleOnPrimary: primaryIsLight
        ? 'rgba(17,24,39,0.5)'
        : 'rgba(255,255,255,0.4)',
      // Card backgrounds
      cardBg: primaryIsLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)',
      cardBorder: primaryIsLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)',
      // Icon background (lighter version of accent)
      iconBg: `${accent}33`, // 20% opacity
      // Checkmark needs to contrast with accent
      checkIconColor: accentIsLight ? '#111827' : '#ffffff',
    }
  }, [brandColors.primary, brandColors.accent])

  useEffect(() => {
    const errorParam = searchParams.get('error')
    if (errorParam && errorMessages[errorParam]) {
      setError(errorMessages[errorParam])
    }
  }, [searchParams])

  const handleSubmit = async (data: z.infer<typeof emailSchema>) => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/portal-auth/send-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, slug: organizationSlug }),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Failed to send magic link')
      }

      setSentToEmail(data.email)
      setEmailSent(true)
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to send magic link'
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  const handleResendEmail = async () => {
    if (!sentToEmail) return
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/portal-auth/send-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: sentToEmail, slug: organizationSlug }),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Failed to resend magic link')
      }
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to resend'
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  // Feature cards data
  const features = [
    {
      Icon: InvoiceIcon,
      title: 'View Invoices',
      description: 'Access your billing history.',
    },
    {
      Icon: ChartIcon,
      title: 'Track Usage',
      description: 'Monitor consumption live.',
    },
    {
      Icon: CardIcon,
      title: 'Manage Billing',
      description: 'Update payment methods.',
    },
    {
      Icon: SettingsIcon,
      title: 'Account Settings',
      description: 'Manage your profile.',
    },
  ]

  const bulletPoints = ['View invoices', 'Track usage', 'Secure access']

  return (
    <div className='min-h-screen w-full lg:grid lg:grid-cols-[40%_60%]'>
      {/* Left Panel - Adapts to org brand colors */}
      <div className='relative hidden h-screen bg-background p-3 lg:flex'>
        <div
          className='relative flex h-full w-full flex-col overflow-hidden rounded-2xl'
          style={{ backgroundColor: colors.primary }}
        >
          <div className='relative z-10 flex h-full flex-col justify-between p-8 xl:p-10'>
            {/* Logo */}
            <div className='flex items-center gap-2.5'>
              {!showLogoFallback ? (
                <img
                  src={organizationLogo}
                  alt={organizationName}
                  className='h-8 w-8 rounded object-contain'
                  onError={() => setLogoError(true)}
                />
              ) : (
                <div
                  className='flex h-8 w-8 items-center justify-center rounded-lg'
                  style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
                >
                  <span className='text-sm font-semibold text-white'>
                    {organizationName.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <span className='text-base font-semibold text-white'>
                {organizationName}
              </span>
            </div>

            {/* Main Content */}
            <div className='space-y-6'>
              {/* Heading */}
              <div className='space-y-3'>
                <h1 className='text-4xl font-bold leading-[1.15] text-white'>
                  Access Your
                </h1>
                <h1
                  className='text-4xl font-bold leading-[1.15]'
                  style={{ color: colors.accent }}
                >
                  Account
                </h1>
                <p className='max-w-[280px] text-sm leading-relaxed text-white/60'>
                  View invoices, track usage, and manage your billing all in one
                  place.
                </p>
              </div>

              {/* Feature Cards - 2x2 Grid */}
              <div className='grid grid-cols-2 gap-2.5'>
                {features.map((feature) => (
                  <div
                    key={feature.title}
                    className='rounded-xl border border-white/[0.08] bg-white/[0.08] p-3'
                  >
                    <div className='flex items-start gap-2.5'>
                      <div
                        className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg'
                        style={{ backgroundColor: colors.iconBg }}
                      >
                        <feature.Icon color={colors.accent} />
                      </div>
                      <div>
                        <h3 className='text-sm font-semibold text-white'>
                          {feature.title}
                        </h3>
                        <p className='mt-0.5 text-[11px] text-white/60'>
                          {feature.description}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Bullet Points */}
              <div className='flex items-center gap-4 pt-1'>
                {bulletPoints.map((point) => (
                  <div key={point} className='flex items-center gap-1.5'>
                    <div
                      className='flex h-4 w-4 items-center justify-center rounded-full'
                      style={{ backgroundColor: colors.accent }}
                    >
                      <CheckIcon color={colors.checkIconColor} />
                    </div>
                    <span className='text-[11px] text-white/70'>{point}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer */}
            <p className='text-xs text-white/40'>
              © {new Date().getFullYear()} {organizationName}. Powered by
              MarginFront.
            </p>
          </div>
        </div>
      </div>

      {/* Right Panel - Clean centered form */}
      <div className='relative flex h-screen flex-col overflow-y-auto bg-background'>
        {/* Mobile Header */}
        <div className='flex items-center gap-2.5 p-6 lg:hidden'>
          {!showLogoFallback ? (
            <img
              src={organizationLogo}
              alt={organizationName}
              className='h-7 w-7 rounded object-contain'
              onError={() => setLogoError(true)}
            />
          ) : (
            <div
              className='flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold text-white'
              style={{ backgroundColor: colors.primary }}
            >
              {organizationName.charAt(0).toUpperCase()}
            </div>
          )}
          <span className='text-sm font-semibold text-foreground'>
            {organizationName}
          </span>
        </div>

        {/* Form Content - Vertically & Horizontally Centered */}
        <div className='flex flex-1 items-center justify-center px-6 py-8 lg:px-8'>
          <div className='w-full max-w-[400px]'>
            {emailSent ? (
              <div className='space-y-6'>
                <div className='flex flex-col items-center space-y-4 text-center'>
                  <div className='flex h-14 w-14 items-center justify-center rounded-full bg-primary/10'>
                    <Mail
                      className='h-7 w-7'
                      style={{ color: colors.primary }}
                    />
                  </div>
                  <div className='space-y-2'>
                    <h1 className='text-xl font-semibold text-foreground'>
                      Check your email
                    </h1>
                    <p className='text-sm text-muted-foreground'>
                      We sent a login link to
                      <br />
                      <span className='font-medium text-foreground'>
                        {sentToEmail}
                      </span>
                    </p>
                  </div>
                </div>

                {error && (
                  <div className='flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-destructive'>
                    <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' />
                    <p className='text-sm'>{error}</p>
                  </div>
                )}

                <div className='flex flex-col gap-2'>
                  <Button
                    variant='outline'
                    onClick={handleResendEmail}
                    disabled={isLoading}
                    className='h-11 w-full'
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
                      setError(null)
                      form.reset()
                    }}
                    className='w-full text-muted-foreground'
                  >
                    Use a different email
                  </Button>
                </div>
              </div>
            ) : (
              <div className='space-y-6'>
                {/* Header */}
                <div className='space-y-1 text-left'>
                  <h1 className='text-xl font-semibold text-foreground'>
                    Welcome to {organizationName}
                  </h1>
                  <p className='text-sm text-muted-foreground'>
                    Sign in to access your customer portal
                  </p>
                </div>

                {/* Error */}
                {error && (
                  <div className='flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-destructive'>
                    <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' />
                    <p className='text-sm'>{error}</p>
                  </div>
                )}

                {/* Email Form */}
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(handleSubmit)}>
                    <FormField
                      control={form.control}
                      name='email'
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <div className='flex gap-2'>
                              <Input
                                type='email'
                                placeholder='Email Address'
                                className='h-11 flex-1'
                                disabled={isLoading}
                                autoFocus
                                {...field}
                              />
                              <Button
                                type='submit'
                                className='h-11 w-11 shrink-0 p-0'
                                disabled={isLoading}
                                style={{ backgroundColor: colors.primary }}
                              >
                                {isLoading ? (
                                  <Loader2 className='h-4 w-4 animate-spin text-white' />
                                ) : (
                                  <ArrowRight className='h-4 w-4 text-white' />
                                )}
                              </Button>
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </form>
                </Form>

                {/* Helper text */}
                <p className='text-center text-xs text-muted-foreground'>
                  We&apos;ll send you a magic link to sign in
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer - Fixed at bottom */}
        <div className='p-6 pt-0'>
          <LegalConsentLine className='text-center text-xs text-muted-foreground' />
        </div>
      </div>
    </div>
  )
}
