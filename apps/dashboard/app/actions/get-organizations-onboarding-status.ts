'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'

export interface OrganizationOnboardingStatus {
  id: string
  onboardingComplete: boolean
  onboardingStep: string | null
  logo: string | null
}

/**
 * Server Action to get onboarding status for all user's organizations
 * Better Auth doesn't include custom fields like onboarding_complete in org list
 */
export async function getOrganizationsOnboardingStatus(): Promise<{
  success: boolean
  data?: Record<string, OrganizationOnboardingStatus>
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    // Get all organizations the user belongs to
    const userOrgs = await prisma.user_organizations.findMany({
      where: { userId: session.user.id },
      select: { organizationId: true },
    })

    if (userOrgs.length === 0) {
      return { success: true, data: {} }
    }

    const orgIds = userOrgs.map((uo) => uo.organizationId)

    // Get onboarding status and logo for all organizations
    const orgs = await prisma.organizations.findMany({
      where: { id: { in: orgIds } },
      select: {
        id: true,
        onboarding_complete: true,
        onboarding_step: true,
        logo: true,
      },
    })

    // Convert to a map for easy lookup
    const statusMap: Record<string, OrganizationOnboardingStatus> = {}
    for (const org of orgs) {
      statusMap[org.id] = {
        id: org.id,
        onboardingComplete: org.onboarding_complete ?? true,
        onboardingStep: org.onboarding_step,
        logo: org.logo,
      }
    }

    return { success: true, data: statusMap }
  } catch (error) {
    console.error('[getOrganizationsOnboardingStatus] Error:', error)
    return { success: false, error: 'Failed to fetch onboarding status' }
  }
}
