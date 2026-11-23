'use server'

/**
 * Org-level Stripe Tax preference.
 *
 * When `stripeAutomaticTax` is true, Stripe Checkout sessions for this org's invoices
 * include `automatic_tax: { enabled: true }`. Stripe then computes sales tax against the
 * merchant's own tax registrations (configured in their Stripe Dashboard).
 *
 * MarginFront never calculates tax itself. We toggle the flag; Stripe does the math.
 * Off by default — the merchant must opt in, and they need Stripe Tax + registrations on
 * their Stripe side or the checkout call will return an error.
 */

import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'
// Toggling automatic tax changes what customers are charged on every
// invoice — a money write. Only owner/admin/finance may flip it. The read
// (getOrgTaxSettings) stays open per scope.
import { assertMoneyManager } from './_shared/assert-money-manager'

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

export async function getOrgTaxSettings(): Promise<
  ActionResult<{ stripeAutomaticTax: boolean }>
> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const org = await db.organizations.findUnique({
      where: { id: session.session.activeOrganizationId },
      select: { stripeAutomaticTax: true },
    })

    if (!org) {
      return { success: false, error: 'Organization not found' }
    }

    return {
      success: true,
      data: { stripeAutomaticTax: org.stripeAutomaticTax ?? false },
    }
  } catch (error) {
    console.error('[getOrgTaxSettings] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to load tax settings',
    }
  }
}

export async function updateOrgTaxSettings(
  stripeAutomaticTax: boolean
): Promise<ActionResult<{ stripeAutomaticTax: boolean }>> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const updated = await db.organizations.update({
      where: { id: gate.orgId },
      data: { stripeAutomaticTax, updatedAt: new Date() },
      select: { stripeAutomaticTax: true },
    })

    return {
      success: true,
      data: { stripeAutomaticTax: updated.stripeAutomaticTax },
    }
  } catch (error) {
    console.error('[updateOrgTaxSettings] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to update tax settings',
    }
  }
}
