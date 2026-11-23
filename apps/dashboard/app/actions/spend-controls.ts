'use server'

/**
 * Spend Controls server actions: the dashboard half of spend caps.
 *
 * TWO enforcement postures, kept separate (one enforcement path, no side
 * doors):
 *   - READS (coverage, caps, spend, prefill) query Prisma directly — reads
 *     don't fork enforcement.
 *   - WRITES (create/update/delete a cap) NEVER touch Prisma here. They forward
 *     the user's Better Auth session cookie to the role-gated api-nest
 *     endpoints (POST/PATCH/DELETE /v1/control/caps).
 *     The ceiling rule and audit trail live in that service; this file must not
 *     re-implement either. api-nest's OrgRoleGuard + CAP_MANAGE_ROLES is the
 *     authoritative gate — the dashboard-side role check below is UX (a clean
 *     error instead of a bounce), not security.
 *
 * A 'use server' file may export ONLY async functions; all shared types live in
 * features/money/spend-controls-types.ts, all shared helpers in
 * _shared/cap-ceiling-precheck.ts.
 */

import { headers } from 'next/headers'
import { captureException } from '@sentry/nextjs'
import {
  cccInternalEventFilter,
  currentPeriodWindow,
  getSpendCoverage,
  toNumber,
  CAP_MANAGE_ROLES,
  type CapPeriod,
} from '@marginfront/db'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'
import { API_BASE_URL, API_TIMEOUT } from '@/lib/api/config'
import { preValidateCapCeiling } from './_shared/cap-ceiling-precheck'
import {
  CAP_PERIODS,
  type CapActionResult,
  type CapView,
  type CreateCapInput,
  type OrgCeilingView,
  type SpendControlsData,
  type UpdateCapInput,
} from '@/features/money/spend-controls-types'
import {
  SPEND_BREAKDOWN_DIMENSIONS,
  type SpendBreakdownData,
  type SpendBreakdownDimension,
  type SpendBreakdownDrillData,
  type SpendBreakdownDrillResult,
  type SpendBreakdownResult,
} from '@/features/money/repo-spend'

// Reads ride the shared client (db) like every action in this dir
// should — no second PrismaClient (serverless connection hygiene). Writes never
// touch Prisma at all; they forward to api-nest below.
const prisma = db

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// ── SETTLEMENT: no path here may leave the caller waiting forever ────────────

/** Wall clock for a whole action, database work included. Longer than the
 * fetch's own API_TIMEOUT on purpose: when the FETCH is what hung, its more
 * specific copy should win, and this backstop covers everything else. */
const ACTION_DEADLINE = API_TIMEOUT + 15000

const DEADLINE_ERROR_NAME = 'SpendControlsDeadline'

const DEADLINE_MESSAGE = `We stopped waiting after ${Math.round(ACTION_DEADLINE / 1000)} seconds. The service behind your spend controls is slow or down right now. Wait a minute and try again.`

/** Bounds the DATABASE work, not only the forward: neither packages/db nor
 * app/lib/db.ts sets a statement or pool timeout, so a wedged pooler or a
 * suspended database pends forever. The losing work keeps
 * running server-side; only the caller stops waiting. */
async function withDeadline<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const expired = new Error(DEADLINE_MESSAGE)
      expired.name = DEADLINE_ERROR_NAME
      reject(expired)
    }, ACTION_DEADLINE)
  })
  try {
    return await Promise.race([work(), deadline])
  } finally {
    // Otherwise the timer holds the invocation awake for the whole deadline.
    clearTimeout(timer)
  }
}

function isDeadline(error: unknown): boolean {
  return error instanceof Error && error.name === DEADLINE_ERROR_NAME
}

/** owner/finance in plain English, derived from the shared constant so the copy
 * never drifts from the gate. */
function whoCanChangeLine(): string {
  const roles = [...CAP_MANAGE_ROLES]
  const list =
    roles.length === 2 ? `an ${roles[0]} or ${roles[1]}` : roles.join(' or ')
  return `Only ${list} can change spend caps. You can see them here.`
}

/** Resolve session, org, cookie, and whether the caller may manage caps.
 * Returns null when unauthenticated. */
async function resolveContext(): Promise<{
  orgId: string
  userId: string | null
  viewerName: string
  cookieHeader: string
  canManage: boolean
} | null> {
  const headersList = await headers()
  const session = await auth.api.getSession({ headers: headersList })
  const orgId = session?.session?.activeOrganizationId
  if (!orgId) return null
  const userId = session.user?.id ?? null
  // The "who set the cap" byline: name, then email, then a neutral label,
  // never a blank byline.
  const viewerName = session.user?.name || session.user?.email || 'Your admin'

  const membership = userId
    ? await db.ba_member.findFirst({
        where: { organizationId: orgId, userId },
        select: { role: true },
      })
    : null
  const canManage =
    !!membership &&
    (CAP_MANAGE_ROLES as readonly string[]).includes(membership.role)

  return {
    orgId,
    userId,
    viewerName,
    cookieHeader: headersList.get('cookie') || '',
    canManage,
  }
}

const BILLING_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The org's billing contact (billing_email, then billingIdentity.email) —
 * a minimal mirror of api-nest's resolveOrgBillingContactEmail, which this
 * app can't import. Drift here only mis-states the alerts line; api-nest
 * resolves the real recipients at send time. */
function resolveBillingEmail(
  org: { billing_email: string | null; billingIdentity: unknown } | null
): string | null {
  if (org?.billing_email && org.billing_email.trim() !== '') {
    return org.billing_email.trim()
  }
  const identity = org?.billingIdentity
  if (identity && typeof identity === 'object' && !Array.isArray(identity)) {
    const email = (identity as Record<string, unknown>).email
    if (typeof email === 'string' && BILLING_EMAIL_SHAPE.test(email.trim())) {
      return email.trim()
    }
  }
  return null
}

/** Sum priced spend for a scope in a window. Honest null: a null _sum means no
 * priced usage to report, never $0 (mirrors the api-nest cap read-back contract).
 * cccInternalEventFilter keeps this the INTERNAL coding-agent number — same
 * shared filter as the api-nest read-back, so both surfaces show one figure. */
async function sumSpend(
  orgId: string,
  window: { start: Date; end: Date },
  customerExternalId?: string
): Promise<number | null> {
  const agg = await prisma.signal_events.aggregate({
    where: {
      organizationId: orgId,
      usageDate: { gte: window.start, lte: window.end },
      ...(customerExternalId ? { customerExternalId } : {}),
      ...cccInternalEventFilter(),
    },
    _sum: { usageCost: true },
  })
  const sum = agg._sum.usageCost
  return sum === null || sum === undefined ? null : toNumber(sum)
}

// ── READ: everything the tab needs on load ───────────────────────────────────

/**
 * A throw reaches the client as a bare rejection the tab cannot tell from a pending
 * load, so it converts to the failure arm the caller already handles.
 * Re-report first: swallowing the throw would also swallow the Sentry signal.
 */
export async function getSpendControlsData(): Promise<
  CapActionResult<SpendControlsData>
> {
  try {
    return await withDeadline(loadSpendControlsData)
  } catch (err) {
    captureException(err)
    console.error('[spend-controls] read failed', err)
    if (isDeadline(err)) return { success: false, error: DEADLINE_MESSAGE }
    return {
      success: false,
      error: "We couldn't load your spend controls. Refresh to try again.",
    }
  }
}

async function loadSpendControlsData(): Promise<
  CapActionResult<SpendControlsData>
> {
  const ctx = await resolveContext()
  if (!ctx) return { success: false, error: 'Not authenticated' }

  const orgId = ctx.orgId
  // Org name for the kit's admin note.
  const org = await prisma.organizations.findUnique({
    where: { id: orgId },
    select: { name: true, billing_email: true, billingIdentity: true },
  })
  const orgName = org?.name || 'your team'
  const now = new Date()
  const nowMs = now.getTime()
  const sevenDaysAgo = new Date(nowMs - SEVEN_DAYS_MS)

  const capRows = await prisma.cap_policies.findMany({
    where: { orgId },
    orderBy: [
      { scope: 'asc' },
      { providerScope: 'asc' },
      { scopeValue: 'asc' },
    ],
  })

  // Per-cap spend, computed only where this read model can honestly total it:
  // an 'all'-provider org cap -> org total; an 'all'-provider dev cap -> that
  // dev's total. Team caps (no team total) and provider-scoped caps (no
  // per-provider total) show without a spend number.
  const caps: CapView[] = await Promise.all(
    capRows.map(async (row) => {
      const period = row.period as CapPeriod
      const window = currentPeriodWindow(period, now)
      const isAllProvider = row.providerScope === 'all'
      let spentUsd: number | null = null
      let spendComputable = false
      if (isAllProvider && row.scope === 'org') {
        spentUsd = await sumSpend(orgId, window)
        spendComputable = true
      } else if (isAllProvider && row.scope === 'dev' && row.scopeValue) {
        spentUsd = await sumSpend(orgId, window, row.scopeValue)
        spendComputable = true
      }
      return {
        id: row.id,
        scope: row.scope as CapView['scope'],
        scopeValue: row.scopeValue,
        providerScope: row.providerScope,
        amountUsd: toNumber(row.amountUsd),
        period,
        mode: row.mode as CapView['mode'],
        coolOffHours: row.coolOffHours,
        spentUsd,
        spendComputable,
        windowStartMs: window.start.getTime(),
        windowEndMs: window.end.getTime(),
      }
    })
  )

  const orgCeilings: OrgCeilingView[] = capRows
    .filter((r) => r.scope === 'org')
    .map((r) => ({
      providerScope: r.providerScope,
      amountUsd: toNumber(r.amountUsd),
    }))

  // Coverage comes from the ONE shared @marginfront/db path so this read and
  // api-nest's GET /control/coverage can't drift.
  const coverage = await getSpendCoverage(prisma, orgId, now)

  const typicalWeekUsd = await sumSpend(orgId, {
    start: sevenDaysAgo,
    end: now,
  })

  // The alerts-destination line — same chain api-nest's evaluator resolves.
  const billingEmail = resolveBillingEmail(org)
  let alertFallbackCount = 0
  if (!billingEmail) {
    const fallbackMembers = await prisma.ba_member.findMany({
      where: {
        organizationId: orgId,
        role: { in: [...CAP_MANAGE_ROLES] },
      },
      select: { users: { select: { email: true } } },
    })
    alertFallbackCount = new Set(
      fallbackMembers
        .map((m) => m.users?.email?.toLowerCase())
        .filter((e): e is string => !!e)
    ).size
  }

  return {
    success: true,
    data: {
      permission: {
        canManage: ctx.canManage,
        whoCanChange: whoCanChangeLine(),
      },
      orgName,
      setterName: ctx.viewerName,
      caps,
      coverage: {
        armed: coverage.armed,
        total: coverage.total,
        asOfMs: coverage.asOfMs,
        claudeCode: coverage.claudeCode,
        codex: coverage.codex,
      },
      alerts: {
        billingEmail,
        fallbackCount: alertFallbackCount,
      },
      orgCeilings,
      prefill: {
        typicalWeekUsd,
        rosterEmails: coverage.rosterEmails,
      },
      asOfMs: nowMs,
    },
  }
}

// ── WRITES: forward the session cookie to the role-gated api-nest API ─────────

/** Headers for every server-side forward to api-nest. */
function apiForwardHeaders(
  cookieHeader: string,
  contentType?: string
): Record<string, string> {
  const headers: Record<string, string> = { Cookie: cookieHeader }
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

/** Failure copy for a forward that timed out or never connected. Every forward
 * carries AbortSignal.timeout(API_TIMEOUT) — a deadline-less fetch can pend
 * forever and strand the awaiting client on busy. */
function unreachableError(serviceLabel: string, error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `The ${serviceLabel} didn't answer within ${Math.round(API_TIMEOUT / 1000)} seconds. It's slow or down right now. Wait a minute and try again.`
  }
  return `We couldn't reach the ${serviceLabel}. It's probably down, or the network between us dropped. Wait a minute and try again, and tell whoever runs this install if it keeps happening.`
}

/** api-nest's own message wins whenever it sent one (the ceiling 400, the
 * role-gate 403). A bare 401/403 with no body is a proxy or host turning us
 * away before api-nest ran, and no amount of retrying fixes a deploy-config gap. */
function httpError(
  serviceLabel: string,
  status: number,
  message?: string
): string {
  if (message) return message
  if (status === 401 || status === 403) {
    return `We couldn't sign in to the ${serviceLabel}. That's a setup problem with this install, not anything you did. Please tell whoever runs it.`
  }
  return `The ${serviceLabel} returned an error (HTTP ${status}). Please try again.`
}

/** Shared forward: attach the caller's session cookie so api-nest's
 * CombinedAuthGuard validates the human and OrgRoleGuard enforces
 * CAP_MANAGE_ROLES. Bubbles api-nest's own error message (e.g. the ceiling 400,
 * the 403 for a non-owner/finance caller) up to the UI. */
async function forwardCapWrite(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  cookieHeader: string,
  body?: unknown
): Promise<CapActionResult<unknown>> {
  try {
    const res = await fetch(`${API_BASE_URL}/control/${path}`, {
      method,
      headers: apiForwardHeaders(cookieHeader, 'application/json'),
      signal: AbortSignal.timeout(API_TIMEOUT),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const errorData = await res
        .json()
        .catch(() => ({}) as { message?: string })
      return {
        success: false,
        error: httpError(
          'cap service',
          res.status,
          (errorData as { message?: string }).message
        ),
      }
    }
    const data = await res.json().catch(() => ({}))
    return { success: true, data }
  } catch (error) {
    captureException(error)
    console.error('[spend-controls] cap write forward failed', error)
    return {
      success: false,
      error: unreachableError('cap service', error),
    }
  }
}

/** Dashboard-side guards shared by every write: require auth, and
 * fail closed for a non-owner/finance caller with a clean message (api-nest
 * re-checks authoritatively). Returns the cookie on success. */
async function guardCapWrite(): Promise<
  | { ok: true; cookieHeader: string; orgId: string }
  | { ok: false; error: string }
> {
  const ctx = await resolveContext()
  if (!ctx) return { ok: false, error: 'Not authenticated' }
  if (!ctx.canManage) {
    return { ok: false, error: whoCanChangeLine() }
  }
  return { ok: true, cookieHeader: ctx.cookieHeader, orgId: ctx.orgId }
}

/* Every write is try/caught like getSpendControlsData: a thrown
 * action reaches the client as a bare rejection and strands the button on busy.
 * guardCapWrite and the ceiling precheck touch the database, so they CAN throw.
 * Sentry first — swallowing the throw must not swallow the signal. */

export async function createCap(
  input: CreateCapInput
): Promise<CapActionResult> {
  try {
    return await withDeadline<CapActionResult>(async () => {
      const guard = await guardCapWrite()
      if (!guard.ok) return { success: false, error: guard.error }

      // Surface the shared ceiling rule client-side BEFORE the write bounces
      // off a 400: a child cap above the org ceiling is caught here with the
      // server's own message. api-nest still re-validates (authoritative).
      if (input.scope !== 'org') {
        const orgId = guard.orgId
        if (orgId) {
          const ceilings = await prisma.cap_policies.findMany({
            where: { orgId, scope: 'org' },
            select: { providerScope: true, amountUsd: true },
          })
          const precheck = preValidateCapCeiling({
            scope: input.scope,
            providerScope: input.providerScope,
            amountUsd: input.amountUsd,
            orgCeilings: ceilings.map((c) => ({
              providerScope: c.providerScope,
              amountUsd: toNumber(c.amountUsd),
            })),
          })
          if (!precheck.ok) {
            return {
              success: false,
              error: precheck.message ?? 'Cap exceeds the org ceiling.',
            }
          }
        }
      }

      const result = await forwardCapWrite(
        'caps',
        'POST',
        guard.cookieHeader,
        input
      )
      return result.success ? { success: true, data: { ok: true } } : result
    })
  } catch (err) {
    captureException(err)
    console.error('[spend-controls] createCap failed', err)
    if (isDeadline(err)) return { success: false, error: DEADLINE_MESSAGE }
    return {
      success: false,
      error: "We couldn't set the cap. Please try again.",
    }
  }
}

export async function updateCap(
  id: string,
  patch: UpdateCapInput
): Promise<CapActionResult> {
  try {
    return await withDeadline<CapActionResult>(async () => {
      const guard = await guardCapWrite()
      if (!guard.ok) return { success: false, error: guard.error }
      const result = await forwardCapWrite(
        `caps/${encodeURIComponent(id)}`,
        'PATCH',
        guard.cookieHeader,
        patch
      )
      return result.success ? { success: true, data: { ok: true } } : result
    })
  } catch (err) {
    captureException(err)
    console.error('[spend-controls] updateCap failed', err)
    if (isDeadline(err)) return { success: false, error: DEADLINE_MESSAGE }
    return {
      success: false,
      error: "We couldn't update the cap. Please try again.",
    }
  }
}

export async function deleteCap(id: string): Promise<CapActionResult> {
  try {
    return await withDeadline<CapActionResult>(async () => {
      const guard = await guardCapWrite()
      if (!guard.ok) return { success: false, error: guard.error }
      const result = await forwardCapWrite(
        `caps/${encodeURIComponent(id)}`,
        'DELETE',
        guard.cookieHeader
      )
      return result.success ? { success: true, data: { ok: true } } : result
    })
  } catch (err) {
    captureException(err)
    console.error('[spend-controls] deleteCap failed', err)
    if (isDeadline(err)) return { success: false, error: DEADLINE_MESSAGE }
    return {
      success: false,
      error: "We couldn't remove the cap. Please try again.",
    }
  }
}

// ── READ: repo/branch spend breakdown ─────────────────────────

/** GET forward with the caller's session cookie, mirroring forwardCapWrite's
 * error translation. Exists so the breakdown read rides the API's
 * /control/spend/breakdown endpoint — the
 * ONE place the repo/branch grouping math lives — instead of growing a second
 * Prisma aggregation here that could silently drift from it. */
async function forwardControlRead(
  path: string,
  cookieHeader: string
): Promise<CapActionResult<unknown>> {
  try {
    const res = await fetch(`${API_BASE_URL}/control/${path}`, {
      method: 'GET',
      headers: apiForwardHeaders(cookieHeader),
      signal: AbortSignal.timeout(API_TIMEOUT),
    })
    if (!res.ok) {
      const errorData = await res
        .json()
        .catch(() => ({}) as { message?: string })
      return {
        success: false,
        error: httpError(
          'spend service',
          res.status,
          (errorData as { message?: string }).message
        ),
      }
    }
    const data = await res.json().catch(() => ({}))
    return { success: true, data }
  } catch (error) {
    captureException(error)
    console.error('[spend-controls] spend read forward failed', error)
    return {
      success: false,
      error: unreachableError('spend service', error),
    }
  }
}

export async function getSpendBreakdown(input: {
  period: CapPeriod
  dimension: SpendBreakdownDimension
}): Promise<CapActionResult<SpendBreakdownResult>> {
  try {
    return await withDeadline<CapActionResult<SpendBreakdownResult>>(
      async () => {
        if (
          !(CAP_PERIODS as readonly string[]).includes(input.period) ||
          !(SPEND_BREAKDOWN_DIMENSIONS as readonly string[]).includes(
            input.dimension
          )
        ) {
          return {
            success: false,
            error: 'Unknown breakdown period or grouping.',
          }
        }
        const ctx = await resolveContext()
        if (!ctx) return { success: false, error: 'Not authenticated' }
        const result = await forwardControlRead(
          `spend/breakdown?period=${encodeURIComponent(input.period)}&dimension=${encodeURIComponent(input.dimension)}`,
          ctx.cookieHeader
        )
        if (!result.success) return result
        return {
          success: true,
          data: { breakdown: result.data as SpendBreakdownData },
        }
      }
    )
  } catch (err) {
    captureException(err)
    console.error('[spend-controls] breakdown read failed', err)
    if (isDeadline(err)) return { success: false, error: DEADLINE_MESSAGE }
    return {
      success: false,
      error: "We couldn't load your AI spend. Refresh to try again.",
    }
  }
}

/** Drill one branch of the breakdown into its (commit, teammate) lines
 * Same forward path and cookie forwarding as getSpendBreakdown. The grouping
 * math lives in ONE place (api-nest's GET /control/spend/breakdown/drill),
 * never a second aggregation here. branchKey is the composite 'owner/repo#branch' the
 * breakdown keys its branch rows by. */
export async function getSpendBreakdownDrill(
  branchKey: string,
  period: CapPeriod
): Promise<CapActionResult<SpendBreakdownDrillResult>> {
  try {
    return await withDeadline<CapActionResult<SpendBreakdownDrillResult>>(
      async () => {
        if (!(CAP_PERIODS as readonly string[]).includes(period)) {
          return { success: false, error: 'Unknown breakdown period.' }
        }
        if (!branchKey) {
          return { success: false, error: 'Missing branch to drill into.' }
        }
        const ctx = await resolveContext()
        if (!ctx) return { success: false, error: 'Not authenticated' }
        const result = await forwardControlRead(
          `spend/breakdown/drill?period=${encodeURIComponent(period)}&branchKey=${encodeURIComponent(branchKey)}`,
          ctx.cookieHeader
        )
        if (!result.success) return result
        return {
          success: true,
          data: { drill: result.data as SpendBreakdownDrillData },
        }
      }
    )
  } catch (err) {
    captureException(err)
    console.error('[spend-controls] breakdown drill failed', err)
    if (isDeadline(err)) return { success: false, error: DEADLINE_MESSAGE }
    return {
      success: false,
      error: "We couldn't load that branch's spend. Refresh to try again.",
    }
  }
}
