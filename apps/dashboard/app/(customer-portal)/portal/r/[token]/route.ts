import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { Prisma } from '@prisma/client'
import { db as prisma } from '@/app/lib/db'
import {
  PORTAL_SESSION_COOKIE,
  MAGIC_LINK_TOKEN_PREFIX,
  PORTAL_SESSION_TOKEN_PREFIX,
  createPortalSession,
} from '@/app/lib/portal-auth'
import { hashApiKeyForLookup } from '@marginfront/db'

/**
 * One-time portal redeemer at /r/<token>.
 *
 * Two token families redeem here — both produce a `mf_portal_session`
 * cookie on the portal host and a redirect to the per-org portal home
 * (`/<slug>/`):
 *
 *   mgl_<32>  — magic link (customer login OR admin "Send Portal Link").
 *               Looks up portal_magic_links, validates not used/not expired,
 *               atomically marks used, mints a new portal_sessions row, sets
 *               the cookie with the new prtl_ token.
 *
 *   prtl_<32>: admin impersonation session ("View as Customer"). The
 *               portal_sessions row already exists; this sets the cookie
 *               with the same token.
 *
 * On any failure, redirects to the org's `/<slug>/link-error?reason=<code>`
 * page if the slug can be resolved, otherwise to the org-less fallback
 * `/r/link-error?reason=<code>`. The redeem URL itself doesn't carry the
 * slug — the token resolves to it — so a leaked URL doesn't disclose
 * which org sent it.
 */

const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX = 10

// Postgres-backed sliding-window counter using the app_throttle table.
//
// The count lives in Postgres, not in process memory, because a serverless
// host runs many instances and an in-memory counter would give each one its
// own 10/60s budget. app_throttle is keyed "portal-redeem:<ip>" and reset
// whenever the window expires. Throttled requests don't consume budget.
async function checkRateLimit(ip: string): Promise<boolean> {
  const key = `portal-redeem:${ip}`
  const now = new Date()
  const existing = await prisma.app_throttle.findUnique({ where: { key } })

  if (
    !existing ||
    now.getTime() - existing.windowStart.getTime() > RATE_LIMIT_WINDOW_MS
  ) {
    await prisma.app_throttle.upsert({
      where: { key },
      create: { key, count: 1, windowStart: now, lastEventAt: now },
      update: { count: 1, windowStart: now, lastEventAt: now },
    })
    return true
  }

  if (existing.count >= RATE_LIMIT_MAX) return false

  await prisma.app_throttle.update({
    where: { key },
    data: { count: existing.count + 1, lastEventAt: now },
  })
  return true
}

interface RouteContext {
  params: Promise<{ token: string }>
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { token } = await context.params
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  const userAgent = request.headers.get('user-agent') || null

  if (!(await checkRateLimit(ip))) {
    return errorRedirect(request, null, 'rate_limited')
  }

  if (!token) {
    return errorRedirect(request, null, 'invalid_link')
  }

  try {
    if (token.startsWith(MAGIC_LINK_TOKEN_PREFIX)) {
      return await redeemMagicLink(request, token, ip, userAgent)
    }
    if (token.startsWith(PORTAL_SESSION_TOKEN_PREFIX)) {
      return await activatePortalSession(request, token)
    }
    // Unknown prefix.
    return errorRedirect(request, null, 'invalid_link')
  } catch (err) {
    console.error('[/r/<token>] redeem error:', err)
    return errorRedirect(request, null, 'server_error')
  }
}

async function redeemMagicLink(
  request: NextRequest,
  token: string,
  ip: string,
  userAgent: string | null
): Promise<NextResponse> {
  // Only the SHA-256 hash is ever matched. A raw-value fallback
  // would let anyone who can read the table present a stored hash as a token.
  const magicLink = await prisma.portal_magic_links.findUnique({
    where: { token: hashApiKeyForLookup(token) },
    include: { organizations: { select: { slug: true } } },
  })

  if (!magicLink) {
    return errorRedirect(request, null, 'invalid_link')
  }

  const slug = magicLink.organizations?.slug ?? null

  if (magicLink.usedAt) {
    return errorRedirect(request, slug, 'link_already_used')
  }
  if (magicLink.expiresAt < new Date()) {
    return errorRedirect(request, slug, 'link_expired')
  }

  // Race closer: this claim takes the same link-row lock the revoke
  // cascade takes, so a redeem racing a revoke serializes — if the revoke
  // wins, the WHERE misses and no session is minted; if the redeem wins, the
  // cascade runs after this commit and expires the session minted below. The
  // mint must stay INSIDE this transaction or that second guarantee breaks.
  const sessionToken = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const claimed = await tx.portal_magic_links.updateMany({
        where: {
          id: magicLink.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      })
      if (claimed.count !== 1) return null
      return createPortalSession(
        magicLink.customerId,
        magicLink.organizationId,
        ip === 'unknown' ? null : ip,
        userAgent,
        { db: tx }
      )
    }
  )

  if (!sessionToken) {
    const lost = await prisma.portal_magic_links.findUnique({
      where: { id: magicLink.id },
      select: { usedAt: true },
    })
    return errorRedirect(
      request,
      slug,
      lost?.usedAt ? 'link_already_used' : 'link_expired'
    )
  }

  await setSessionCookie(sessionToken)

  console.log(
    `[/r/<token>] magic link redeemed for customer ${magicLink.customerId} (org ${magicLink.organizationId}) from ${ip}`
  )

  if (!slug) {
    return errorRedirect(request, null, 'server_error')
  }
  return NextResponse.redirect(buildAbsoluteUrl(request, `/${slug}/`))
}

async function activatePortalSession(
  request: NextRequest,
  token: string
): Promise<NextResponse> {
  // Hash-only lookup, as above. The cookie set below carries the RAW token.
  const session = await prisma.portal_sessions.findUnique({
    where: { token: hashApiKeyForLookup(token) },
    include: { organizations: { select: { slug: true } } },
  })

  if (!session) {
    return errorRedirect(request, null, 'invalid_link')
  }

  const slug = session.organizations?.slug ?? null

  if (session.expiresAt < new Date()) {
    return errorRedirect(request, slug, 'link_expired')
  }

  await setSessionCookie(token, session.expiresAt)

  console.log(
    `[/r/<token>] portal session activated for customer ${session.customerId} (org ${session.organizationId})${session.impersonatedBy ? ` impersonated by ${session.impersonatedBy}` : ''}`
  )

  if (!slug) {
    return errorRedirect(request, null, 'server_error')
  }
  return NextResponse.redirect(buildAbsoluteUrl(request, `/${slug}/`))
}

async function setSessionCookie(
  token: string,
  expiresAt?: Date
): Promise<void> {
  const cookieStore = await cookies()
  const maxAge = expiresAt
    ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
    : 60 * 60 // 1 hour default
  cookieStore.set(PORTAL_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    path: '/',
  })
}

function buildAbsoluteUrl(request: NextRequest, pathname: string): string {
  return new URL(pathname, request.nextUrl.origin).toString()
}

function errorRedirect(
  request: NextRequest,
  slug: string | null,
  reason: string
): NextResponse {
  const path = slug
    ? `/${slug}/link-error?reason=${reason}`
    : `/r/link-error?reason=${reason}`
  return NextResponse.redirect(buildAbsoluteUrl(request, path))
}
