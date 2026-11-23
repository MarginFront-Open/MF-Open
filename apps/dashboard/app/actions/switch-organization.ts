'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'

/**
 * Server action to switch the active organization
 * Updates the Better Auth session with the new activeOrganizationId
 * and triggers a revalidation of cached data
 */
export async function switchOrganization(organizationId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    // Get the current session
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.user) {
      return {
        success: false,
        error: 'Not authenticated',
      }
    }

    // Use Better Auth's organization plugin to set the active organization
    const result = await auth.api.setActiveOrganization({
      headers: await headers(),
      body: {
        organizationId,
      },
    })

    if (!result) {
      return {
        success: false,
        error: 'Failed to switch organization',
      }
    }

    // Revalidate all paths to refresh data with new organization context
    revalidatePath('/', 'layout')
    revalidatePath('/money')
    revalidatePath('/finops')
    revalidatePath('/build')
    revalidatePath('/roi')
    revalidatePath('/mfiq')

    return {
      success: true,
    }
  } catch (error) {
    console.error('[Switch Organization] Error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'An unexpected error occurred',
    }
  }
}

/**
 * Server action to get the current active organization ID from the session
 */
export async function getActiveOrganizationId(): Promise<string | null> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    return session?.session?.activeOrganizationId || null
  } catch (error) {
    console.error('[Get Active Organization] Error:', error)
    return null
  }
}
