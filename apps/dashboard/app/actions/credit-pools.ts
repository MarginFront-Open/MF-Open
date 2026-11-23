'use server'

/**
 * Credit-pool server actions — the dashboard half of credit-pool
 * visibility.
 *
 * TWO postures, honestly separated:
 *   - READS go through the shared `@marginfront/db` credit-balance canon. The
 *     api-nest endpoint reads the SAME canon,
 *     so a number on this page and a number from GET /v1/credit-balances cannot
 *     drift.
 *   - WRITES (top up, pause/resume alerts) NEVER touch Prisma here. They forward
 *     the user's Better Auth session cookie to the role-gated api-nest endpoints
 *     (POST /v1/subscriptions/:id/credit-topup and /credit-alerts-pause). The
 *     idempotency key, the audit trail, and the MANAGE_MONEY_ROLES gate live in
 *     that service; this file must not re-implement any of them. The
 *     dashboard-side role check below is UX (a clean message instead of a
 *     bounce), not security.
 *
 * A 'use server' file may export ONLY async functions; the shared types live in
 * features/money/credit-pool-types.ts.
 */

import { randomUUID } from 'crypto'
import { headers } from 'next/headers'
import { getCreditBalances, MANAGE_MONEY_ROLES } from '@marginfront/db'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'
import { API_BASE_URL } from '@/lib/api/config'
import {
  isPoolExhausted,
  isPoolNearEmpty,
  NEAR_EMPTY_PERCENT,
  type CreditPoolActionResult,
  type CreditPoolBalanceView,
  type CreditPoolsData,
  type ExhaustedCreditPoolsData,
} from '@/features/money/credit-pool-types'

const prisma = db

/** owner/admin/finance in plain English, derived from the shared constant so
 * the copy can never drift from the gate. */
function whoCanChangeLine(): string {
  const roles = [...MANAGE_MONEY_ROLES]
  const list = `${roles.slice(0, -1).join(', ')}, or ${roles[roles.length - 1]}`
  return `Only an ${list} user can add credits or change alerts. You can see them here.`
}

/** Resolve session, org, cookie, and whether the caller may manage money.
 * Returns null when unauthenticated. */
async function resolveContext(): Promise<{
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

/** Dates leave the server as epoch ms so a client component gets them without
 * a Date round-trip. Every number is already an honest number from the canon. */
function toView(row: {
  subscriptionId: string
  subscriptionName: string
  customerId: string
  customerName: string | null
  customerExternalId: string | null
  agentId: string
  planId: string
  planName: string | null
  poolSizeUnits: number
  consumedUnits: number
  remainingUnits: number
  overageInProgressUnits: number
  remainingPercent: number
  overageRatePerUnit: number | null
  periodStart: Date | null
  periodEnd: Date | null
  alertsPaused: boolean
  noActivePeriod: boolean
  implicitFullPool: boolean
}): CreditPoolBalanceView {
  return {
    subscriptionId: row.subscriptionId,
    subscriptionName: row.subscriptionName,
    customerId: row.customerId,
    customerName: row.customerName,
    customerExternalId: row.customerExternalId,
    agentId: row.agentId,
    planId: row.planId,
    planName: row.planName,
    poolSizeUnits: row.poolSizeUnits,
    consumedUnits: row.consumedUnits,
    remainingUnits: row.remainingUnits,
    overageInProgressUnits: row.overageInProgressUnits,
    remainingPercent: row.remainingPercent,
    overageRatePerUnit: row.overageRatePerUnit,
    periodStartMs: row.periodStart ? row.periodStart.getTime() : null,
    periodEndMs: row.periodEnd ? row.periodEnd.getTime() : null,
    alertsPaused: row.alertsPaused,
    noActivePeriod: row.noActivePeriod,
    implicitFullPool: row.implicitFullPool,
  }
}

// ── READ: every credit pool in the org ───────────────────────────────────────

export async function getCreditBalancesAction(
  filters: { customerId?: string; subscriptionId?: string } = {}
): Promise<CreditPoolActionResult<CreditPoolsData>> {
  const ctx = await resolveContext()
  if (!ctx) return { success: false, error: 'Not authenticated' }

  const orgId = ctx.orgId
  const now = new Date()
  const rows = await getCreditBalances(
    prisma,
    orgId,
    {
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.subscriptionId
        ? { subscriptionId: filters.subscriptionId }
        : {}),
    },
    now
  )

  return {
    success: true,
    data: {
      permission: {
        canManage: ctx.canManage,
        whoCanChange: whoCanChangeLine(),
      },
      balances: rows.map(toView),
      asOfMs: now.getTime(),
    },
  }
}

// ── READ: the needs-attention third section ──────────────────────────────────

/**
 * Pools worth a human's attention: at or past zero, or under 20% left.
 *
 * Sourced from the balance canon, never from raw_ingest_events. Credit pools
 * never block ingest, so no event ever enters an error state because a pool emptied — an
 * empty pool is the product working as designed, and the section says so.
 *
 * Alerts-paused pools are still LISTED (labeled paused): pausing changes who
 * gets an email, not whether the pool needs topping up.
 */
export async function getExhaustedCreditPools(): Promise<
  CreditPoolActionResult<ExhaustedCreditPoolsData>
> {
  const ctx = await resolveContext()
  if (!ctx) return { success: false, error: 'Not authenticated' }

  const orgId = ctx.orgId
  const rows = await getCreditBalances(
    prisma,
    orgId,
    { belowPercent: NEAR_EMPTY_PERCENT },
    new Date()
  )
  // The canon's band is inclusive (<= 20) while the classifiers below read
  // "under 20". Post-filter through the SAME classifiers the UI labels with,
  // so a pool at exactly 20% can't be listed and then labeled as neither.
  const pools = rows
    .map(toView)
    .filter((p) => isPoolExhausted(p) || isPoolNearEmpty(p))

  return {
    success: true,
    data: {
      permission: {
        canManage: ctx.canManage,
        whoCanChange: whoCanChangeLine(),
      },
      pools,
      exhaustedCount: pools.filter(isPoolExhausted).length,
      nearEmptyCount: pools.filter(isPoolNearEmpty).length,
    },
  }
}

// ── WRITES: forward the session cookie to the role-gated api-nest endpoints ──

/** Shared forward: attach the caller's session cookie so api-nest's
 * CombinedAuthGuard validates the human and OrgRoleGuard enforces
 * MANAGE_MONEY_ROLES. Bubbles api-nest's own message (the 403 for a member,
 * the 400 for a plan with no pool) straight to the UI. */
async function forwardCreditWrite(
  path: string,
  cookieHeader: string,
  body: unknown
): Promise<CreditPoolActionResult<unknown>> {
  try {
    const res = await fetch(`${API_BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errorData = await res
        .json()
        .catch(() => ({}) as { message?: string })
      return {
        success: false,
        error:
          (errorData as { message?: string }).message ||
          `The credit-pool service returned an error (HTTP ${res.status}). Please try again.`,
      }
    }
    const data = await res.json().catch(() => ({}))
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? `Could not reach the credit-pool service: ${error.message}`
          : 'Could not reach the credit-pool service.',
    }
  }
}

/** Dashboard-side guards shared by every write: require auth, and
 * fail closed for a caller without a money seat with a clean message (api-nest
 * re-checks authoritatively). Returns the cookie on success. */
async function guardCreditWrite(): Promise<
  { ok: true; cookieHeader: string } | { ok: false; error: string }
> {
  const ctx = await resolveContext()
  if (!ctx) return { ok: false, error: 'Not authenticated' }
  if (!ctx.canManage) return { ok: false, error: whoCanChangeLine() }
  return { ok: true, cookieHeader: ctx.cookieHeader }
}

/**
 * Add units to one pool.
 *
 * The idempotency key is minted here rather than asked for: a human clicking
 * "Add units" has no key to give, and one key per submitted form is what makes
 * a double-click cost the customer nothing. Pass `idempotencyKey` explicitly
 * when retrying the SAME intent (the caller keeping the key across a retry is
 * the whole point of the mechanism).
 */
export async function topUpCreditPool(input: {
  subscriptionId: string
  units: number
  note?: string
  idempotencyKey?: string
}): Promise<CreditPoolActionResult> {
  if (!input.subscriptionId) {
    return { success: false, error: 'Missing subscription to top up.' }
  }
  if (!Number.isFinite(input.units) || input.units <= 0) {
    return {
      success: false,
      error:
        'Enter how many units to add. A top-up has to be a number above zero.',
    }
  }
  const guard = await guardCreditWrite()
  if (!guard.ok) return { success: false, error: guard.error }

  const result = await forwardCreditWrite(
    `subscriptions/${encodeURIComponent(input.subscriptionId)}/credit-topup`,
    guard.cookieHeader,
    {
      units: input.units,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      ...(input.note ? { note: input.note } : {}),
    }
  )
  return result.success ? { success: true, data: { ok: true } } : result
}

/** Silence or resume one subscription's credit-pool emails. Explicit state,
 * never a toggle, so a double-submit lands in the same place. */
export async function setCreditAlertsPaused(input: {
  subscriptionId: string
  paused: boolean
}): Promise<CreditPoolActionResult> {
  if (!input.subscriptionId) {
    return { success: false, error: 'Missing subscription to update.' }
  }
  const guard = await guardCreditWrite()
  if (!guard.ok) return { success: false, error: guard.error }

  const result = await forwardCreditWrite(
    `subscriptions/${encodeURIComponent(input.subscriptionId)}/credit-alerts-pause`,
    guard.cookieHeader,
    { paused: input.paused }
  )
  return result.success ? { success: true, data: { ok: true } } : result
}
