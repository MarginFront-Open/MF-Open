import { getAuthBaseURL } from './auth-base-url'

/**
 * The two local-development switches that print a sign-in code or sign-in link
 * to the server log instead of emailing it. Anyone who can read that log can
 * sign in as anyone, so each switch works only when ALL of these hold:
 *   1. the switch is set to exactly "true",
 *   2. NODE_ENV is not "production",
 *   3. the app's configured address is this machine (localhost),
 *   4. the request itself arrived on a localhost address.
 * Otherwise the switch is ignored, the email is sent normally, and the server
 * log says why.
 */
export type LocalDevShortcut = 'SKIP_OTP_EMAIL' | 'SKIP_MAGIC_LINK_EMAIL'

type Env = Record<string, string | undefined>
type HeaderReader = { get(name: string): string | null }

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return LOOPBACK_HOSTNAMES.has(lower) || lower.endsWith('.localhost')
}

function hostnameOfHostHeader(value: string): string | null {
  try {
    return new URL(`http://${value.trim()}`).hostname
  } catch {
    return null
  }
}

/**
 * Why a local-development shortcut may NOT be used right now, in plain words,
 * or null when it is safe.
 */
export function localDevShortcutRefusal(
  env: Env = process.env,
  requestHeaders?: HeaderReader | null
): string | null {
  if (env.NODE_ENV === 'production') {
    return 'NODE_ENV is "production"'
  }

  const baseUrl = getAuthBaseURL(env)
  let baseHostname: string | null = null
  try {
    baseHostname = new URL(baseUrl).hostname
  } catch {
    baseHostname = null
  }
  if (!baseHostname || !isLoopbackHostname(baseHostname)) {
    return `the app is configured to be reached at ${baseUrl}, which is not localhost`
  }

  if (requestHeaders) {
    for (const header of ['x-forwarded-host', 'host']) {
      const value = requestHeaders.get(header)
      if (!value) continue
      for (const part of value.split(',')) {
        const hostname = hostnameOfHostHeader(part)
        if (!hostname || !isLoopbackHostname(hostname)) {
          return `the request arrived for "${part.trim()}", which is not localhost (a tunnel or proxy is exposing this server)`
        }
      }
    }
  }

  return null
}

export function isLocalDevShortcutActive(
  shortcut: LocalDevShortcut,
  requestHeaders?: HeaderReader | null,
  env: Env = process.env
): boolean {
  if (env[shortcut] !== 'true') return false

  const refusal = localDevShortcutRefusal(env, requestHeaders)
  if (refusal) {
    console.error(
      `[Auth] SECURITY: ${shortcut}=true was IGNORED because ${refusal}. ` +
        `This switch prints sign-in secrets to the server log and only works for local development on localhost. ` +
        `The email will be sent normally. Remove ${shortcut} from this environment.`
    )
    return false
  }

  console.warn(
    `[Auth] WARNING: ${shortcut}=true is ACTIVE. Sign-in emails are not being sent; ` +
      `the sign-in secret is printed to this log instead. Local development only.`
  )
  return true
}
