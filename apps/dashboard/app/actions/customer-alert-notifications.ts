'use server'

/**
 * WHAT THIS FILE DOES: the read side of Customer Watch Alerts' in-app surface
 * — the MFiQ "Customer alerts" card rows, the sidebar unread
 * count, and mark-read. Direct Prisma reads (the house pattern for dashboard
 * reads, same as spend-controls.ts); api-nest stays the authority for watch
 * WRITES.
 * CONNECTS TO: customer_alert_notifications (written by the api-nest
 * evaluator), src/features/mfiq/customer-alert-items.ts (row composition),
 * src/services/customer-alerts-service.ts (the badge poll).
 *
 * Scoping rule: every query filters BOTH userId = session user
 * AND orgId = the session's active organization. A person in two orgs must
 * never see org A's customer names and amounts — or dead-end deep links —
 * while working in org B.
 */

import { headers } from 'next/headers'
import { toNumber } from '@marginfront/db'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'

const FEED_LIMIT = 20

export interface CustomerAlertNotificationView {
  id: string
  customerId: string
  /** Joined at read time; a hard-deleted customer degrades to null, never a crash. */
  customerName: string | null
  metric: string
  thresholdUsd: number
  valueUsd: number
  windowMode: string
  firedAt: string
  readAt: string | null
}

async function resolveViewer(): Promise<{
  userId: string
  orgId: string
} | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  const orgId = session?.session?.activeOrganizationId
  const userId = session?.user?.id
  if (!orgId || !userId) return null
  return { userId, orgId }
}

/** The recent feed for the MFiQ card: newest first, capped at 20. */
export async function getCustomerAlertNotifications(): Promise<{
  success: boolean
  data?: CustomerAlertNotificationView[]
  error?: string
}> {
  try {
    const viewer = await resolveViewer()
    if (!viewer) return { success: false, error: 'No active organization' }
    const rows = await db.customer_alert_notifications.findMany({
      where: { userId: viewer.userId, orgId: viewer.orgId },
      orderBy: { firedAt: 'desc' },
      take: FEED_LIMIT,
    })

    const customerIds = [...new Set(rows.map((r) => r.customerId))]
    // organizationId is defense-in-depth: the ids already come from rows
    // scoped userId+orgId, but the clause makes the safety local instead of
    // transitive.
    const customers = customerIds.length
      ? await db.customers.findMany({
          where: { id: { in: customerIds }, organizationId: viewer.orgId },
          select: { id: true, name: true },
        })
      : []
    const nameById = new Map(customers.map((c) => [c.id, c.name]))

    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        customerId: r.customerId,
        customerName: nameById.get(r.customerId) ?? null,
        metric: r.metric,
        thresholdUsd: toNumber(r.thresholdUsd),
        valueUsd: toNumber(r.valueUsd),
        windowMode: r.windowMode,
        firedAt: r.firedAt.toISOString(),
        readAt: r.readAt ? r.readAt.toISOString() : null,
      })),
    }
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error ? err.message : 'Failed to load customer alerts',
    }
  }
}

/** The sidebar badge number. Any failure reads as 0 — a broken poll must never break the nav. */
export async function getUnreadCustomerAlertCount(): Promise<{
  success: boolean
  count: number
}> {
  try {
    const viewer = await resolveViewer()
    if (!viewer) return { success: true, count: 0 }
    const count = await db.customer_alert_notifications.count({
      where: { userId: viewer.userId, orgId: viewer.orgId, readAt: null },
    })
    return { success: true, count }
  } catch {
    return { success: false, count: 0 }
  }
}

/** Opening MFiQ counts as reading: clear this viewer's unread rows in this org. */
export async function markCustomerAlertNotificationsRead(): Promise<{
  success: boolean
  marked: number
}> {
  try {
    const viewer = await resolveViewer()
    if (!viewer) return { success: true, marked: 0 }
    const result = await db.customer_alert_notifications.updateMany({
      where: { userId: viewer.userId, orgId: viewer.orgId, readAt: null },
      data: { readAt: new Date() },
    })
    return { success: true, marked: result.count }
  } catch {
    return { success: false, marked: 0 }
  }
}
