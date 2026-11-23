'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'

export interface OrganizationDetails {
  id: string
  name: string
  logo: string | null
  website: string | null
  onboardingComplete: boolean
  onboardingStep: string | null
  currency: string
  timezone: string
}

/**
 * Server Action to get full organization details including custom fields
 * Better Auth doesn't include custom fields like onboardingComplete
 */
export async function getOrganizationDetails(): Promise<{
  success: boolean
  data?: OrganizationDetails
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    const org = await prisma.organizations.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        logo: true,
        website: true,
        onboarding_complete: true,
        onboarding_step: true,
        default_currency: true,
        timezone: true,
      },
    })

    if (!org) {
      return { success: false, error: 'Organization not found' }
    }

    console.log('[getOrganizationDetails] Org:', org.id, 'onboarding_complete:', org.onboarding_complete)

    return {
      success: true,
      data: {
        id: org.id,
        name: org.name,
        logo: org.logo,
        website: org.website,
        onboardingComplete: org.onboarding_complete ?? true,
        onboardingStep: org.onboarding_step,
        currency: org.default_currency ?? 'USD',
        timezone: org.timezone ?? 'UTC',
      },
    }
  } catch (error) {
    console.error('[getOrganizationDetails] Error:', error)
    return { success: false, error: 'Failed to fetch organization details' }
  }
}
