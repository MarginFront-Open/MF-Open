'use server'

/**
 * Per-user, per-page dashboard layout.
 *
 * A layout is a list of tiles: `{ component, dimension?, metric?, size }`. No-row means
 * "the page hasn't been customized" — the caller renders the page's code
 * default, NOT a row this action writes. "Reset" deletes the row for the
 * same reason: a synthetic default row would drift from the code default the
 * moment it changes.
 *
 * Every write is validated against the shared catalog
 * (@/lib/component-catalog) so a layout row can never reference a component,
 * dimension, or page the resolver/UI doesn't know about.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Tile shape + zod-strict schema live in the shared catalog: a 'use server'
// module may only export async functions, and the shell/tests need the real
// schema.
// No type re-exports here: Next registers EVERY export of a 'use server'
// file as a server action at runtime, and a type re-export erases to an
// undefined identifier — the module throws on load and every action in the
// page's bundle 500s. Import DashboardLayoutTile from the catalog instead.
import {
  DASHBOARD_PAGE_IDS,
  TilesInputSchema,
  type DashboardLayoutTile,
  type DashboardPageId,
} from '@/lib/component-catalog'

function isDashboardPageId(page: string): page is DashboardPageId {
  return (DASHBOARD_PAGE_IDS as readonly string[]).includes(page)
}

/**
 * Load the active user's saved layout for one page.
 *
 * Returns `data: null` when the user has never customized the page — the
 * caller applies the page's code-default layout in that case, not this
 * action.
 */
export async function getDashboardLayout(page: DashboardPageId): Promise<{
  success: boolean
  data?: DashboardLayoutTile[] | null
  error?: string
}> {
  try {
    if (!isDashboardPageId(page)) {
      return { success: false, error: `Unknown page: "${page}"` }
    }

    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    if (!session.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    const row = await db.user_dashboard_layouts.findUnique({
      where: { userId_orgId_page: { userId, orgId, page } },
      select: { tiles: true },
    })

    if (!row) {
      return { success: true, data: null }
    }

    return {
      success: true,
      data: row.tiles as unknown as DashboardLayoutTile[],
    }
  } catch (error) {
    console.error('[getDashboardLayout] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to load dashboard layout',
    }
  }
}

/**
 * Save (create or overwrite) the active user's layout for one page.
 *
 * Personalization, not a money write — no role gate beyond being a member of
 * the org, same as setUserPersona.
 */
export async function saveDashboardLayout(
  page: DashboardPageId,
  tiles: DashboardLayoutTile[]
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isDashboardPageId(page)) {
      return { success: false, error: `Unknown page: "${page}"` }
    }

    const parsed = TilesInputSchema.safeParse(tiles)
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid layout: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      }
    }

    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    if (!session.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    await db.user_dashboard_layouts.upsert({
      where: { userId_orgId_page: { userId, orgId, page } },
      create: {
        userId,
        orgId,
        page,
        tiles: parsed.data as unknown as Prisma.InputJsonValue,
      },
      update: {
        tiles: parsed.data as unknown as Prisma.InputJsonValue,
      },
    })

    // There is no per-layout route, so revalidate the whole tree
    // rather than guess a path.
    revalidatePath('/', 'layout')
    return { success: true }
  } catch (error) {
    console.error('[saveDashboardLayout] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to save dashboard layout',
    }
  }
}

/**
 * Reset the active user's layout for one page back to the code default.
 *
 * Deletes the row — it never writes a synthetic "default" row back.
 * Idempotent: resetting an already-default page is a no-op success.
 */
export async function resetDashboardLayout(
  page: DashboardPageId
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isDashboardPageId(page)) {
      return { success: false, error: `Unknown page: "${page}"` }
    }

    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    if (!session.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    await db.user_dashboard_layouts.deleteMany({
      where: { userId, orgId, page },
    })

    revalidatePath('/', 'layout')
    return { success: true }
  } catch (error) {
    console.error('[resetDashboardLayout] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to reset dashboard layout',
    }
  }
}
