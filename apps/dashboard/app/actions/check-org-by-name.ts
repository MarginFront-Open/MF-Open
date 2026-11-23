'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'

export interface OrgCheckResult {
  exists: boolean
  org?: {
    id: string
    name: string
    onboardingComplete: boolean
    onboardingStep: string | null
  }
}

/**
 * Server Action to check if user has an organization with the given name
 * Returns onboarding status to determine if user should continue setup
 */
export async function checkOrgByName(name: string): Promise<{
  success: boolean
  data?: OrgCheckResult
  error?: string
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    if (!name || name.trim().length < 2) {
      return { success: true, data: { exists: false } }
    }

    const userOrgs = await prisma.user_organizations.findMany({
      where: { userId: session.user.id },
      include: {
        organizations: {
          select: {
            id: true,
            name: true,
            onboarding_complete: true,
            onboarding_step: true,
          },
        },
      },
    })

    // Check for matching name (case-insensitive)
    const normalizedName = name.toLowerCase().trim()
    const matchingOrg = userOrgs.find(
      (uo) => uo.organizations.name.toLowerCase().trim() === normalizedName
    )

    if (matchingOrg) {
      return {
        success: true,
        data: {
          exists: true,
          org: {
            id: matchingOrg.organizations.id,
            name: matchingOrg.organizations.name,
            onboardingComplete: matchingOrg.organizations.onboarding_complete ?? true,
            onboardingStep: matchingOrg.organizations.onboarding_step,
          },
        },
      }
    }

    return { success: true, data: { exists: false } }
  } catch (error) {
    console.error('[checkOrgByName] Error:', error)
    return { success: false, error: 'Failed to check organization' }
  }
}
