// Verifies a Cloudflare Turnstile token against Cloudflare's siteverify endpoint.
// Called from the Better-Auth `hooks.before` middleware before any auth flow
// (sign-in, sign-up, OTP send, magic-link send, forgot-password) is allowed to
// proceed. Blocks bots at the edge — the token can only be obtained by passing
// Cloudflare's challenge, so a bot that hasn't solved it cannot reach the auth
// endpoints behind this hook.
//
// Behavior:
// - Returns true if Cloudflare confirms the token is valid AND fresh (<=300s)
//   AND the hostname Cloudflare reports matches an allowed value (defense
//   against an attacker harvesting a token from their own site and replaying
//   it against ours).
// - Returns false on any failure (invalid token, expired, wrong host, network
//   error, missing secret key, no allowed hostnames configured).
// - Logs the failure reason to console for debugging; never throws — the
//   caller decides how to react (typically: reject the request with 401).

// Hostnames the token is allowed to have been generated on. There is no
// built-in default: the operator lists the hostname(s) their own dashboard is
// served from in TURNSTILE_ALLOWED_HOSTNAMES (comma-separated).
/**
 * Better Auth paths that sign someone in or send them an email, so a script
 * could use them to guess passwords or flood an inbox. The two password-reset
 * paths send a code email on their own, separately from send-verification-otp.
 */
export const TURNSTILE_PROTECTED_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/sign-up/email',
  '/email-otp/send-verification-otp',
  '/sign-in/magic-link',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
])

export function getTurnstileAllowedHostnames(
  env: Record<string, string | undefined> = process.env
): string[] {
  return (env.TURNSTILE_ALLOWED_HOSTNAMES ?? '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

// The bot check is on exactly when the operator has set a Turnstile secret.
export function isTurnstileEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY)
}

export const TURNSTILE_NO_HOSTNAMES_MESSAGE =
  '[Turnstile] The bot check is ON (TURNSTILE_SECRET_KEY is set) but TURNSTILE_ALLOWED_HOSTNAMES is empty, ' +
  'so every sign-in, sign-up and password-reset request is being REJECTED. ' +
  'Why: without a hostname list the server cannot tell a challenge solved on your site from one solved on somebody else\'s. ' +
  'Fix: set TURNSTILE_ALLOWED_HOSTNAMES to the hostname(s) your dashboard is served from, comma-separated ' +
  '(for example "app.example.com"), then restart. To turn the bot check off instead, unset TURNSTILE_SECRET_KEY.'

interface SiteverifyResponse {
  success: boolean
  challenge_ts?: string
  hostname?: string
  action?: string
  cdata?: string
  'error-codes'?: string[]
}

export async function verifyTurnstileToken(
  token: string | null | undefined,
  remoteIp?: string | null
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    console.error('[Turnstile] TURNSTILE_SECRET_KEY not configured')
    return false
  }
  const allowed = getTurnstileAllowedHostnames()
  if (allowed.length === 0) {
    console.error(TURNSTILE_NO_HOSTNAMES_MESSAGE)
    return false
  }
  if (!token) {
    console.warn('[Turnstile] No token provided')
    return false
  }

  const body = new URLSearchParams()
  body.append('secret', secret)
  body.append('response', token)
  if (remoteIp) body.append('remoteip', remoteIp)

  try {
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    )
    const data = (await res.json()) as SiteverifyResponse

    if (!data.success) {
      console.warn('[Turnstile] Verification failed:', data['error-codes'])
      return false
    }

    // Cloudflare returns the hostname the widget was rendered on; a token
    // harvested from a challenge hosted elsewhere fails here. A reply with no
    // hostname is rejected too.
    const hostname = data.hostname?.toLowerCase()
    if (!hostname || !allowed.includes(hostname)) {
      console.warn(
        '[Turnstile] Token from unexpected hostname:',
        data.hostname,
        '— allowed:',
        allowed
      )
      return false
    }

    return true
  } catch (err) {
    console.error('[Turnstile] siteverify request failed:', err)
    return false
  }
}
