'use server'

/**
 * WHAT THIS FILE DOES: the dashboard side of managing customer watches
 * — the customer page's Alerts section reads through here and
 * forwards every write to api-nest with the caller's session cookie, so
 * api-nest's OrgRoleGuard (MANAGE_MONEY_ROLES) stays the one write authority.
 * Same forward/guard pattern as spend-controls.ts.
 * CONNECTS TO: api-nest /customer-alerts (the authority),
 * src/features/customers/components/customer-watch-section.tsx (the UI),
 * customer_alerts (direct Prisma for the read, house pattern).
 */

import { headers } from 'next/headers'
import { captureException } from '@sentry/nextjs'
import { MANAGE_MONEY_ROLES, toNumber } from '@marginfront/db'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'
import { API_BASE_URL, API_TIMEOUT } from '@/lib/api/config'

export interface CustomerWatchView {
  id: string
  customerId: string
  metric: string
  thresholdUsd: number
  windowMode: string
  customStartDate: string | null
  customEndDate: string | null
  recipientEmail: string
  createdAt: string
}

export interface CustomerWatchesResult {
  success: boolean
  /** False for a non-money caller: the section hides (cosmetic; the server re-checks every write). */
  canManage?: boolean
  watches?: CustomerWatchView[]
  error?: string
}

export interface CustomerWatchWriteInput {
  metric: string
  thresholdUsd: number
  windowMode: string
  customStartDate?: string
  customEndDate?: string
}

export interface CustomerWatchWriteResult {
  success: boolean
  error?: string
}

/** Session, active org and the caller's role in it. */
async function resolveWatchContext(): Promise<{
  orgId: string
  userId: string | null
  cookieHeader: string
  canManage: boolean
} | null> {
  const headersList = await headers()
  const session = await auth.api.getSession({ headers: headersList })
  const orgId = session?.session?.activeOrganizationId
  if (!orgId) return null
  const userId = session.user?.id ?? null
  const membership = userId
    ? await db.ba_member.findFirst({
        where: { organizationId: orgId, userId },
        select: { role: true },
      })
    : null
  const canManage =
    !!membership &&
    (MANAGE_MONEY_ROLES as readonly string[]).includes(membership.role)
  return {
    orgId,
    userId,
    cookieHeader: headersList.get('cookie') || '',
    canManage,
  }
}

/** This customer's watches, newest first. Fail-closed: a non-money caller gets
 * canManage false and NO rows (thresholds are money data). */
export async function getCustomerWatches(
  customerId: string
): Promise<CustomerWatchesResult> {
  try {
    const ctx = await resolveWatchContext()
    if (!ctx) return { success: false, error: 'Not authenticated' }
    if (!ctx.canManage) return { success: true, canManage: false, watches: [] }
    const orgId = ctx.orgId

    const rows = await db.customer_alerts.findMany({
      where: { orgId, customerId },
      orderBy: { createdAt: 'desc' },
    })
    return {
      success: true,
      canManage: true,
      watches: rows.map((r) => ({
        id: r.id,
        customerId: r.customerId,
        metric: r.metric,
        thresholdUsd: toNumber(r.thresholdUsd),
        windowMode: r.windowMode,
        customStartDate: r.customStartDate
          ? r.customStartDate.toISOString()
          : null,
        customEndDate: r.customEndDate ? r.customEndDate.toISOString() : null,
        recipientEmail: r.recipientEmail,
        createdAt: r.createdAt.toISOString(),
      })),
    }
  } catch (err) {
    captureException(err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to load watches',
    }
  }
}

function apiForwardHeaders(cookieHeader: string): Record<string, string> {
  const forwarded: Record<string, string> = {
    Cookie: cookieHeader,
    'Content-Type': 'application/json',
  }
  return forwarded
}

function watchHttpError(status: number, message?: string): string {
  if (message) return message
  if (status === 401 || status === 403) {
    return "We couldn't sign in to the alerts service. That's a setup problem with this install, not anything you did. Please tell whoever runs it."
  }
  return `The alerts service returned an error (HTTP ${status}). Please try again.`
}

function watchUnreachableError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `The alerts service didn't answer within ${Math.round(API_TIMEOUT / 1000)} seconds. It's slow or down right now. Wait a minute and try again.`
  }
  return "We couldn't reach the alerts service. It's probably down, or the network between us dropped. Wait a minute and try again, and tell whoever runs this install if it keeps happening."
}

/** Cookie-forwarded write to api-nest — its OrgRoleGuard + DTO rules are the
 * authority; their plain-English messages bubble up verbatim. */
async function forwardWatchWrite(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  cookieHeader: string,
  body?: unknown
): Promise<CustomerWatchWriteResult> {
  try {
    const res = await fetch(`${API_BASE_URL}/customer-alerts${path}`, {
      method,
      headers: apiForwardHeaders(cookieHeader),
      signal: AbortSignal.timeout(API_TIMEOUT),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const errorData = await res
        .json()
        .catch(() => ({}) as { message?: string | string[] })
      const message = (errorData as { message?: string | string[] }).message
      return {
        success: false,
        error: watchHttpError(
          res.status,
          Array.isArray(message) ? message.join(' ') : message
        ),
      }
    }
    return { success: true }
  } catch (error) {
    captureException(error)
    console.error('[customer-alerts] watch write forward failed', error)
    return { success: false, error: watchUnreachableError(error) }
  }
}

/** Shared write guard: require auth, fail closed on role (api-nest
 * re-checks authoritatively). */
async function guardWatchWrite(): Promise<
  { ok: true; cookieHeader: string } | { ok: false; error: string }
> {
  const ctx = await resolveWatchContext()
  if (!ctx) return { ok: false, error: 'Not authenticated' }
  if (!ctx.canManage) {
    return {
      ok: false,
      error:
        'Only owners, admins, and finance can manage customer watches. Ask one of them.',
    }
  }
  return { ok: true, cookieHeader: ctx.cookieHeader }
}

export async function createCustomerWatch(
  customerId: string,
  input: CustomerWatchWriteInput
): Promise<CustomerWatchWriteResult> {
  const guard = await guardWatchWrite()
  if (!guard.ok) return { success: false, error: guard.error }
  return forwardWatchWrite('', 'POST', guard.cookieHeader, {
    customerId,
    metric: input.metric,
    thresholdUsd: input.thresholdUsd,
    windowMode: input.windowMode,
    ...(input.customStartDate
      ? { customStartDate: input.customStartDate }
      : {}),
    ...(input.customEndDate ? { customEndDate: input.customEndDate } : {}),
  })
}

export async function updateCustomerWatch(
  watchId: string,
  input: CustomerWatchWriteInput
): Promise<CustomerWatchWriteResult> {
  const guard = await guardWatchWrite()
  if (!guard.ok) return { success: false, error: guard.error }
  return forwardWatchWrite(`/${watchId}`, 'PATCH', guard.cookieHeader, {
    metric: input.metric,
    thresholdUsd: input.thresholdUsd,
    windowMode: input.windowMode,
    ...(input.customStartDate
      ? { customStartDate: input.customStartDate }
      : {}),
    ...(input.customEndDate ? { customEndDate: input.customEndDate } : {}),
  })
}

export async function deleteCustomerWatch(
  watchId: string
): Promise<CustomerWatchWriteResult> {
  const guard = await guardWatchWrite()
  if (!guard.ok) return { success: false, error: guard.error }
  return forwardWatchWrite(`/${watchId}`, 'DELETE', guard.cookieHeader)
}
