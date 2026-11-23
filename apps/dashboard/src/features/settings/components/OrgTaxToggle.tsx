'use client'

/**
 * Org-level Stripe Tax toggle.
 *
 * Renders INLINE inside the Stripe ProviderCard, not as a standalone card. When the
 * merchant turns it on, Stripe Checkout sessions for this org get
 * `automatic_tax: { enabled: true }` — Stripe calculates sales tax against the merchant's
 * own tax registrations, adds it to the session total, and remits according to the
 * merchant's Stripe Tax configuration.
 *
 * MarginFront never sees tax money. We don't calculate tax. We don't store tax registrations.
 * We don't file returns. This is a one-flag delegation to Stripe.
 *
 * Off by default. If the merchant turns it on without Stripe Tax set up on their end,
 * checkout will fail at session-create time with a clear Stripe error pointing them at
 * the right Dashboard page (their setup gap, not ours).
 */

import { useEffect, useState } from 'react'
import { IconExternalLink, IconReceipt2 } from '@tabler/icons-react'
import { Switch } from '@/components/ui/switch'
import {
  getOrgTaxSettings,
  updateOrgTaxSettings,
} from '@/app/actions/org-tax-settings'

interface OrgTaxToggleProps {
  /** False disables the switch: only admins can change it. */
  hasAdminAccess: boolean
}

export function OrgTaxToggle({ hasAdminAccess }: OrgTaxToggleProps) {
  const [enabled, setEnabled] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getOrgTaxSettings().then((result) => {
      if (cancelled) return
      if (result.success) {
        setEnabled(result.data.stripeAutomaticTax)
      } else {
        setError(result.error)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = async (next: boolean) => {
    setSaving(true)
    setError(null)
    const previous = enabled
    setEnabled(next) // optimistic
    const result = await updateOrgTaxSettings(next)
    setSaving(false)
    if (!result.success) {
      setEnabled(previous) // rollback
      setError(result.error)
    }
  }

  return (
    <div className='space-y-2'>
      <div className='flex items-start justify-between gap-4'>
        <div className='flex flex-1 items-start gap-2'>
          <IconReceipt2 className='mt-0.5 h-4 w-4 flex-shrink-0 text-primary' />
          <div>
            <p className='text-sm font-medium'>
              Stripe Tax (Sales Tax Automation)
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>
              Stripe calculates sales tax on every invoice payment, using your
              tax registrations.
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={loading || saving || !hasAdminAccess}
          aria-label='Toggle Stripe automatic tax calculation'
        />
      </div>
      <div className='space-y-1 pl-6 text-xs text-muted-foreground'>
        <p>
          When this is on, Stripe Checkout adds the right sales tax to the
          invoice total based on your customer&apos;s address. MarginFront never
          sees the money. Stripe collects and remits according to your Stripe
          Tax setup.
        </p>
        <p>
          Requires Stripe Tax to be enabled in your Stripe Dashboard with active
          tax registrations. Stripe charges $0.50 per transaction or 0.5% of the
          payment (whichever is lower).{' '}
          <a
            href='https://dashboard.stripe.com/settings/tax'
            target='_blank'
            rel='noopener noreferrer'
            className='text-primary hover:underline'
          >
            Configure in Stripe Dashboard
            <IconExternalLink className='ml-1 inline h-3 w-3' />
          </a>
        </p>
        {error && (
          <p className='text-destructive'>
            Couldn&apos;t save: {error}. Try again. If it keeps failing, check
            the API logs for the tax settings request.
          </p>
        )}
      </div>
    </div>
  )
}
