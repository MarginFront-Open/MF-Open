/**
 * Customer portal URL builders.
 *
 * In the path-based portal architecture, every customer portal
 * lives at a single dedicated subdomain per environment, for example:
 *   production = https://portal.example.com
 *   local      = http://portal.localhost:3000  (requires /etc/hosts alias)
 *
 * The per-org slug lives in the URL PATH, not the hostname, so one
 * ordinary TLS certificate covers every portal. No wildcard certificate
 * or DNS challenge is needed.
 *
 * Mirrors `buildPortalUrl` in apps/api-nest/src/modules/portal-sessions/
 * portal-sessions.service.ts so dashboard-minted and api-nest-minted
 * URLs land on the same host.
 */

function readPortalBaseUrl(): string {
  const configured = process.env.PORTAL_BASE_URL?.trim()
  if (configured) {
    try {
      // Sanity-check it parses, then strip any trailing slash for clean
      // concatenation downstream.
      const u = new URL(configured)
      return u.toString().replace(/\/$/, '')
    } catch {
      // Fall through to the dev default.
    }
  }
  // Local-dev default: requires `portal.localhost` in /etc/hosts pointing
  // at 127.0.0.1 (macOS does NOT auto-resolve nested .localhost names).
  return 'http://portal.localhost:3000'
}

/**
 * Build the base URL for an org's portal home (post-auth).
 *
 *   buildOrgPortalBaseUrl('acme') === 'https://portal.example.com/acme'
 *
 * Use this for links the customer sees AFTER they've redeemed a token —
 * the post-auth portal home, deep links, etc.
 */
export function buildOrgPortalBaseUrl(orgSlug: string): string {
  return `${readPortalBaseUrl()}/${orgSlug}`
}

/**
 * Build the one-time redeem URL for a portal token.
 *
 *   buildRedeemUrl('mgl_xxx...') === 'https://portal.example.com/r/mgl_xxx...'
 *   buildRedeemUrl('prtl_yyy...') === 'https://portal.example.com/r/prtl_yyy...'
 *
 * The slug is intentionally absent from the URL — the token resolves to
 * a customer (and therefore an org) server-side at /r/[token]. This keeps
 * emails short and means a leaked URL doesn't disclose the org slug.
 */
export function buildRedeemUrl(token: string): string {
  return `${readPortalBaseUrl()}/r/${token}`
}
