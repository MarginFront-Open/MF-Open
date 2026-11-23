'use server'

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db as prisma } from '@/app/lib/db'

export type UserPersona =
  | 'founder'
  | 'finance'
  | 'gtm_sales'
  | 'product_engineering'
  | 'ops'
  | 'investor_advisor'
  | 'other'

// The bouncer: only these values get through
const VALID_PERSONAS: UserPersona[] = [
  'founder',
  'finance',
  'gtm_sales',
  'product_engineering',
  'ops',
  'investor_advisor',
  'other',
]

/**
 * Server Action: save the user's persona (role/function) during onboarding.
 *
 * Stored on the users table. Used for analytics and UX personalization.
 * No role check needed — users are updating their own profile.
 */
export async function setUserPersona(
  persona: UserPersona
): Promise<{ success: boolean; error?: string }> {
  try {
    // Input validation — make sure the value is one we actually accept
    if (!VALID_PERSONAS.includes(persona)) {
      return {
        success: false,
        error: `Invalid persona: "${persona}". Must be one of: ${VALID_PERSONAS.join(', ')}`,
      }
    }

    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session?.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    await prisma.users.update({
      where: { id: session.user.id },
      data: { persona },
    })

    console.log(
      '[setUserPersona] Saved persona:',
      persona,
      'for user:',
      session.user.id
    )

    return { success: true }
  } catch (error) {
    console.error('[setUserPersona] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to save persona',
    }
  }
}
