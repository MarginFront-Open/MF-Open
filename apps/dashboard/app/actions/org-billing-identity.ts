'use server'

/**
 * Org billing identity for printed invoices. The read needs a session; the write is
 * org administration = assertOrgManager (role checked in the caller's active
 * org, written to exactly the org the gate validated).
 */

import { headers } from 'next/headers'
import { z } from 'zod'
import { auth } from '@/app/lib/auth'
import { db, Prisma } from '@/app/lib/db'
import type { OrgBillingIdentity } from '@/features/invoices/billing-identity-display'
import { assertOrgManager } from './_shared/assert-org-manager'

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

function blankToUndefined(value: unknown): unknown {
  if (value === null) return undefined
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalLine(label: string, max: number) {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .max(max, `${label} is too long. Keep it under ${max} characters.`)
      .optional()
  )
}

const billingIdentitySchema = z.object({
  legalName: optionalLine('The legal name', 255),
  addressLine1: optionalLine('Address line 1', 255),
  addressLine2: optionalLine('Address line 2', 255),
  city: optionalLine('The city', 120),
  state: optionalLine('The state or region', 120),
  postalCode: optionalLine('The postal code', 32),
  country: optionalLine('The country', 120),
  email: z.preprocess(
    blankToUndefined,
    z
      .string()
      .email("That email address doesn't look right. Check it and try again.")
      .max(255, 'The email is too long. Keep it under 255 characters.')
      .optional()
  ),
})

function definedFieldsOnly(identity: OrgBillingIdentity): OrgBillingIdentity {
  return Object.fromEntries(
    Object.entries(identity).filter(([, value]) => value !== undefined)
  ) as OrgBillingIdentity
}

export async function getOrgBillingIdentity(): Promise<
  ActionResult<{ orgName: string; identity: OrgBillingIdentity | null }>
> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId
    const org = await db.organizations.findUnique({
      where: { id: orgId },
      select: { name: true, billingIdentity: true },
    })
    if (!org) {
      return { success: false, error: 'Organization not found' }
    }

    // Stored JSON is re-validated on the way out; anything malformed is
    // treated as "nothing stored" so the print falls back to the org name
    // instead of rendering junk.
    const parsed = billingIdentitySchema.safeParse(org.billingIdentity ?? {})
    const identity = parsed.success ? definedFieldsOnly(parsed.data) : {}

    return {
      success: true,
      data: {
        orgName: org.name,
        identity: Object.keys(identity).length > 0 ? identity : null,
      },
    }
  } catch (error) {
    console.error('[getOrgBillingIdentity] Error:', error)
    return { success: false, error: 'Failed to load the invoice identity' }
  }
}

export async function saveOrgBillingIdentity(
  input: OrgBillingIdentity
): Promise<ActionResult<null>> {
  try {
    const gate = await assertOrgManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    const parsed = billingIdentitySchema.safeParse(input ?? {})
    if (!parsed.success) {
      return {
        success: false,
        error:
          parsed.error.issues[0]?.message ??
          "Couldn't read those invoice identity fields.",
      }
    }

    const identity = definedFieldsOnly(parsed.data)
    await db.organizations.update({
      where: { id: gate.orgId },
      data: {
        billingIdentity:
          Object.keys(identity).length > 0
            ? (identity as Prisma.InputJsonValue)
            : Prisma.DbNull,
      },
    })

    return { success: true, data: null }
  } catch (error) {
    console.error('[saveOrgBillingIdentity] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to save the invoice identity',
    }
  }
}
