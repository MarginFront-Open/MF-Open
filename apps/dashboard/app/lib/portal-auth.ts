// LOGGING POLICY — read before adding new console.log / logger calls in this file.
//
// Never log VALUES of (presence checks like `!!process.env.X` are fine):
//   - AUTH_SECRET, BETTER_AUTH_SECRET, SESSION_SECRET, JWT_SECRET
//   - RESEND_API_KEY, SENDGRID_API_KEY
//   - DATABASE_URL (contains DB password)
//   - apiKeyPlaintext from `api_keys` table (these are customer keys; logging = leak)
//   - SENTRY_AUTH_TOKEN, VERCEL_TOKEN
//   - STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//   - any field ending in `_secret`, `_key`, `_token`, `_password`
//
// OK to log: magic-link URLs in fallback / error paths. Blast radius is
// 1 hour, customer-side, read-only portal access. We accept this trade-off
// so that link-delivery failures are debuggable from server logs.

import { cookies } from 'next/headers'
import { cache } from 'react'
import { Prisma } from '@prisma/client'
import { db as prisma } from '@/app/lib/db'
import { hashApiKeyForLookup } from '@marginfront/db'
import { consumeThrottle, type ThrottleLimit } from './app-throttle'

// Cookie name for portal sessions (MarginFront branded)
export const PORTAL_SESSION_COOKIE = 'mf_portal_session'

// Token prefixes — every token a customer sees is `<prefix>_<32 chars>`.
// `randomBytes(24).toString('base64url')` yields exactly 32 chars of entropy,
// keeping URLs short while still cryptographically unguessable (192 bits).
export const MAGIC_LINK_TOKEN_PREFIX = 'mgl_'
export const PORTAL_SESSION_TOKEN_PREFIX = 'prtl_'

export interface BrandColors {
  primary: string
  secondary: string
  accent: string
}

export interface PortalSession {
  customerId: string
  customerName: string
  customerEmail: string
  organizationId: string
  organizationName: string
  organizationSlug: string
  organizationLogo: string | null
  /** Brand colors extracted from Firecrawl during onboarding */
  brandColors: BrandColors
  /** Whether this session was created via admin impersonation */
  isImpersonated: boolean
  /** The admin user ID who is impersonating (if applicable) */
  impersonatedByUserId: string | null
  /** The admin user name who is impersonating (if applicable) */
  impersonatedByUserName: string | null
}

/**
 * Get the current portal session from the cookie.
 * This is cached per request to avoid multiple database calls.
 */
export const getPortalSession = cache(
  async (): Promise<PortalSession | null> => {
    try {
      const cookieStore = await cookies()
      const sessionToken = cookieStore.get(PORTAL_SESSION_COOKIE)?.value

      if (!sessionToken) {
        return null
      }

      // The token is stored as a SHA-256 hash and matched ONLY by
      // the hash of the cookie value. Never add a lookup by the raw value: it
      // would let anyone who can read the table present a stored hash as a token.
      const session = await prisma.portal_sessions.findUnique({
        where: { token: hashApiKeyForLookup(sessionToken) },
        include: {
          customers: true,
          organizations: true,
          impersonator: true, // Include admin user if this is an impersonation session
        },
      })

      if (!session) {
        return null
      }

      // Check if session has expired
      if (session.expiresAt < new Date()) {
        // Clean up expired session
        await prisma.portal_sessions
          .delete({
            where: { id: session.id },
          })
          .catch(() => {
            // Ignore deletion errors
          })
        return null
      }

      // Extract brand colors from designjson (set during onboarding via Firecrawl)
      const designJson = session.organizations.designjson as {
        primaryColor?: string
        secondaryColor?: string
        accentColor?: string
      } | null

      return {
        customerId: session.customers.id,
        customerName: session.customers.name,
        customerEmail: session.customers.email || '',
        organizationId: session.organizations.id,
        organizationName: session.organizations.name,
        organizationSlug: session.organizations.slug || '',
        organizationLogo: session.organizations.logo,
        brandColors: {
          primary: designJson?.primaryColor || '#10b981',
          secondary: designJson?.secondaryColor || '#6366f1',
          accent: designJson?.accentColor || '#f59e0b',
        },
        // Impersonation tracking
        isImpersonated: !!session.impersonatedBy,
        impersonatedByUserId: session.impersonatedBy,
        impersonatedByUserName: session.impersonator?.name || null,
      }
    } catch (error) {
      console.error('[Portal Auth] Error getting session:', error)
      return null
    }
  }
)

// Alias of getPortalSession
export const getCustomerSession = getPortalSession

/**
 * Require a valid portal session, or throw an error.
 * Use this in protected pages/routes.
 */
export async function requirePortalSession(): Promise<PortalSession> {
  const session = await getPortalSession()
  if (!session) {
    throw new Error('Unauthorized - No valid portal session')
  }
  return session
}

/**
 * Get organization by slug.
 */
export async function getOrganizationBySlug(slug: string) {
  return prisma.organizations.findFirst({
    where: { slug },
  })
}

/**
 * Counts one request against a portal send/redeem limit. Returns false when
 * the caller is over the limit.
 */
export async function consumePortalThrottle(
  key: string,
  limit: ThrottleLimit
): Promise<boolean> {
  return consumeThrottle(prisma, key, limit)
}

/**
 * Find a customer by email within an organization.
 */
export async function findCustomerByEmail(
  email: string,
  organizationId: string
) {
  return prisma.customers.findFirst({
    where: {
      email: email.toLowerCase(),
      organizationId,
      status: 'active',
    },
  })
}

/**
 * Create a magic link token for portal authentication.
 *
 * Default prefix is `mgl_`. Tokens are `mgl_<32 base64url chars>` — short
 * enough to fit cleanly in an email body, long enough (192 bits of entropy)
 * that a brute-force attacker can't guess one before it expires.
 */
export async function createPortalMagicLink(
  customerId: string,
  organizationId: string,
  options?: { tokenPrefix?: string; expiresInMs?: number }
): Promise<string> {
  const { randomBytes } = await import('crypto')
  const random = randomBytes(24).toString('base64url')
  const prefix = options?.tokenPrefix ?? MAGIC_LINK_TOKEN_PREFIX
  const token = `${prefix}${random}`
  const expiresInMs = options?.expiresInMs ?? 60 * 60 * 1000 // default: 1 hour
  const expiresAt = new Date(Date.now() + expiresInMs)

  // Store the SHA-256 hash at rest; the raw token travels in
  // the email/URL (returned below). Redeem hashes the incoming token to match.
  await prisma.portal_magic_links.create({
    data: {
      customerId,
      organizationId,
      token: hashApiKeyForLookup(token),
      expiresAt,
    },
  })

  return token
}

/**
 * Verify a magic link token and return the associated data.
 */
export async function verifyPortalMagicLink(token: string) {
  // Matched by hash only (see getPortalSession).
  const magicLink = await prisma.portal_magic_links.findUnique({
    where: { token: hashApiKeyForLookup(token) },
    include: {
      customers: true,
      organizations: true,
    },
  })

  if (!magicLink) {
    return { valid: false, error: 'invalid_token' as const }
  }

  if (magicLink.expiresAt < new Date()) {
    return { valid: false, error: 'expired_token' as const }
  }

  if (magicLink.usedAt) {
    return { valid: false, error: 'used_token' as const }
  }

  return {
    valid: true,
    magicLink,
  }
}

/**
 * Mark a magic link as used.
 */
export async function markPortalMagicLinkUsed(magicLinkId: string) {
  await prisma.portal_magic_links.update({
    where: { id: magicLinkId },
    data: { usedAt: new Date() },
  })
}

/**
 * Create a portal session for a customer.
 */
// Equal-time security model: cookie session lifetime matches the magic link's lifetime (1 hour).
// Override only via PORTAL_SESSION_DURATION_MS for special operational reasons.
const DEFAULT_PORTAL_SESSION_MS = 60 * 60 * 1000

export async function createPortalSession(
  customerId: string,
  organizationId: string,
  ipAddress?: string | null,
  userAgent?: string | null,
  options?: {
    impersonatedBy?: string | null
    // Transaction client so the redeem route can mint atomically with its
    // link claim, leaving no gap for a revoke to land between the two.
    db?: Prisma.TransactionClient
  }
): Promise<string> {
  const { randomBytes } = await import('crypto')
  // 32 chars + `prtl_` prefix — same shape as magic links.
  const random = randomBytes(24).toString('base64url')
  const token = `${PORTAL_SESSION_TOKEN_PREFIX}${random}`
  const overrideMs = process.env.PORTAL_SESSION_DURATION_MS
    ? parseInt(process.env.PORTAL_SESSION_DURATION_MS, 10)
    : NaN
  const durationMs = Number.isFinite(overrideMs)
    ? overrideMs
    : DEFAULT_PORTAL_SESSION_MS
  const expiresAt = new Date(Date.now() + durationMs)

  // Hash at rest. The raw token is returned and set as the cookie
  // as-is; getPortalSession / validatePortalSessionForSlug hash the
  // incoming cookie value to match this stored hash.
  await (options?.db ?? prisma).portal_sessions.create({
    data: {
      customerId,
      organizationId,
      token: hashApiKeyForLookup(token),
      expiresAt,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      impersonatedBy: options?.impersonatedBy ?? null,
    },
  })

  return token
}

/**
 * Verify a portal session token resolves to the given org slug.
 *
 * Inter-customer isolation gate: prevents cookie-replay across orgs. If a
 * customer somehow ends up with a session cookie for org A but their URL
 * path says org B, this returns false and the caller redirects them away.
 *
 * Returns the session row (with joined customer + organization) on success,
 * or null on any failure (no session, expired session, slug mismatch).
 */
export async function validatePortalSessionForSlug(
  sessionToken: string | null | undefined,
  requestedSlug: string
): Promise<{
  customerId: string
  organizationId: string
  organizationSlug: string
} | null> {
  if (!sessionToken) return null

  // Matched by hash only (see getPortalSession).
  const session = await prisma.portal_sessions.findUnique({
    where: { token: hashApiKeyForLookup(sessionToken) },
    include: {
      organizations: { select: { slug: true } },
    },
  })

  if (!session) return null
  if (session.expiresAt < new Date()) return null
  if (session.organizations?.slug !== requestedSlug) return null

  return {
    customerId: session.customerId,
    organizationId: session.organizationId,
    organizationSlug: session.organizations.slug,
  }
}

/**
 * Delete a portal session by token.
 */
export async function deletePortalSession(token: string) {
  // deleteMany won't throw when nothing matches.
  await prisma.portal_sessions
    .deleteMany({
      where: { token: hashApiKeyForLookup(token) },
    })
    .catch(() => {
      // Ignore if session doesn't exist
    })
}

/**
 * Clean up expired sessions and magic links.
 * Call this periodically (e.g., via cron job).
 */
export async function cleanupExpiredPortalTokens() {
  const now = new Date()

  // Delete expired sessions
  await prisma.portal_sessions.deleteMany({
    where: { expiresAt: { lt: now } },
  })

  // Delete expired magic links
  await prisma.portal_magic_links.deleteMany({
    where: { expiresAt: { lt: now } },
  })
}
