'use server'

/**
 * Per-user named filter presets.
 *
 * A saved view is a name plus a `filters` blob — which page it applies to,
 * which dimension/period/entity filters were active. The scope lives inside
 * the JSON rather than a fixed column shape, since which filters apply
 * differs per page.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db, Prisma } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  DASHBOARD_PAGE_IDS,
  DIMENSION_REGISTRY,
  type DashboardPageId,
  type Dimension,
} from '@/lib/component-catalog'

export interface SavedViewFilters {
  page?: DashboardPageId
  dimension?: Dimension
  period?: { startDate?: string; endDate?: string }
  customerId?: string
  agentId?: string
  signalId?: string
  subscriptionId?: string
}

export interface SavedView {
  id: string
  name: string
  filters: SavedViewFilters
  createdAt: string
  updatedAt: string
}

// Generous cap so the saved-views list stays a dropdown, not a scroll
// marathon, in the same spirit as MAX_TILES_PER_LAYOUT.
const MAX_SAVED_VIEWS_PER_USER = 50

// Dates here go through parseWindowFilter downstream (accepts either a bare
// "YYYY-MM-DD" or a full ISO timestamp) — kept permissive on format and
// strict only on shape (unknown keys rejected), matching parse-window-filter.ts.
const PeriodInputSchema = z
  .object({
    startDate: z.string().min(1).optional(),
    endDate: z.string().min(1).optional(),
  })
  .strict()

const FiltersInputSchema = z
  .object({
    page: z.enum(DASHBOARD_PAGE_IDS).optional(),
    dimension: z.enum(DIMENSION_REGISTRY).optional(),
    period: PeriodInputSchema.optional(),
    customerId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    signalId: z.string().uuid().optional(),
    subscriptionId: z.string().uuid().optional(),
  })
  .strict()

function serializeSavedView(row: {
  id: string
  name: string
  filters: Prisma.JsonValue
  createdAt: Date
  updatedAt: Date
}): SavedView {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters as unknown as SavedViewFilters,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * List the active user's saved views for the active org, newest first.
 */
export async function getSavedViews(): Promise<{
  success: boolean
  data?: SavedView[]
  error?: string
}> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    if (!session.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    const rows = await db.user_saved_views.findMany({
      where: { userId, orgId },
      orderBy: { createdAt: 'desc' },
    })

    return { success: true, data: rows.map(serializeSavedView) }
  } catch (error) {
    console.error('[getSavedViews] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to load saved views',
    }
  }
}

/**
 * Create a new saved view for the active user.
 */
export async function createSavedView(
  name: string,
  filters: SavedViewFilters
): Promise<{ success: boolean; data?: SavedView; error?: string }> {
  try {
    const nameTrim = name.trim()
    if (!nameTrim) return { success: false, error: 'Name is required' }
    if (nameTrim.length > 255) {
      return { success: false, error: 'Name must be ≤ 255 characters' }
    }

    const parsedFilters = FiltersInputSchema.safeParse(filters)
    if (!parsedFilters.success) {
      return {
        success: false,
        error: `Invalid filters: ${parsedFilters.error.issues.map((i) => i.message).join('; ')}`,
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

    const existingCount = await db.user_saved_views.count({
      where: { userId, orgId },
    })
    if (existingCount >= MAX_SAVED_VIEWS_PER_USER) {
      return {
        success: false,
        error: `You've hit the ${MAX_SAVED_VIEWS_PER_USER}-view limit. Delete one before saving another.`,
      }
    }

    const created = await db.user_saved_views.create({
      data: {
        userId,
        orgId,
        name: nameTrim,
        filters: parsedFilters.data as unknown as Prisma.InputJsonValue,
      },
    })

    revalidatePath('/', 'layout')
    return { success: true, data: serializeSavedView(created) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.includes('Unique constraint')) {
      return {
        success: false,
        error: `A saved view named "${name.trim()}" already exists.`,
      }
    }
    console.error('[createSavedView] Error:', err)
    return { success: false, error: msg }
  }
}

/**
 * Delete one of the active user's saved views. Idempotent — deleting a view
 * that's already gone (or belongs to someone else) is a no-op success rather
 * than an error, so a double-click can't surface a confusing failure.
 */
export async function deleteSavedView(
  id: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }
    if (!session.user?.id) {
      return { success: false, error: 'Not authenticated' }
    }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    await db.user_saved_views.deleteMany({
      where: { id, userId, orgId },
    })

    revalidatePath('/', 'layout')
    return { success: true }
  } catch (error) {
    console.error('[deleteSavedView] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to delete saved view',
    }
  }
}
