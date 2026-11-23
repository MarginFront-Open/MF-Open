import {
  localDevShortcutRefusal,
  type LocalDevShortcut,
} from './local-dev-shortcuts'
import {
  TURNSTILE_NO_HOSTNAMES_MESSAGE,
  getTurnstileAllowedHostnames,
  isTurnstileEnabled,
} from './turnstile'

type Env = Record<string, string | undefined>

export interface AuthConfigNotice {
  level: 'error' | 'warn'
  message: string
}

const LOCAL_DEV_SHORTCUTS: LocalDevShortcut[] = [
  'SKIP_OTP_EMAIL',
  'SKIP_MAGIC_LINK_EMAIL',
]

/**
 * Sign-in settings that are unsafe or self-defeating, found once at server
 * start so the operator sees them in the first lines of the log instead of
 * discovering them as "nobody can log in".
 */
export function collectAuthConfigNotices(
  env: Env = process.env
): AuthConfigNotice[] {
  const notices: AuthConfigNotice[] = []

  if (isTurnstileEnabled(env)) {
    if (getTurnstileAllowedHostnames(env).length === 0) {
      notices.push({ level: 'error', message: TURNSTILE_NO_HOSTNAMES_MESSAGE })
    }
    if (!env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
      notices.push({
        level: 'error',
        message:
          '[Turnstile] The bot check is ON (TURNSTILE_SECRET_KEY is set) but NEXT_PUBLIC_TURNSTILE_SITE_KEY is empty, ' +
          'so the sign-in page cannot show the challenge and every sign-in will be REJECTED. ' +
          'Fix: set NEXT_PUBLIC_TURNSTILE_SITE_KEY to the site key from the same Cloudflare Turnstile widget and rebuild, ' +
          'or unset TURNSTILE_SECRET_KEY to turn the bot check off.',
      })
    }
  } else if (env.NODE_ENV === 'production') {
    notices.push({
      level: 'warn',
      message:
        '[Turnstile] The bot check is OFF because TURNSTILE_SECRET_KEY is not set. ' +
        'Anyone can script sign-up and sign-in email requests against this server. ' +
        'Fix: create a free Cloudflare Turnstile widget and set TURNSTILE_SECRET_KEY, NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_ALLOWED_HOSTNAMES.',
    })
  }

  for (const shortcut of LOCAL_DEV_SHORTCUTS) {
    if (env[shortcut] !== 'true') continue
    const refusal = localDevShortcutRefusal(env)
    if (refusal) {
      notices.push({
        level: 'error',
        message:
          `[Auth] SECURITY: ${shortcut}=true is set but will be IGNORED because ${refusal}. ` +
          `This switch prints sign-in secrets to the server log and only works for local development on localhost. ` +
          `Fix: remove ${shortcut} from this environment.`,
      })
    } else {
      notices.push({
        level: 'warn',
        message:
          `[Auth] WARNING: ${shortcut}=true. Sign-in emails will NOT be sent; the sign-in secret is printed to this log instead. ` +
          `Anyone who can read this log can sign in as anyone. Local development only.`,
      })
    }
  }

  return notices
}

export function logAuthConfigNotices(env: Env = process.env): void {
  for (const notice of collectAuthConfigNotices(env)) {
    if (notice.level === 'error') console.error(notice.message)
    else console.warn(notice.message)
  }
}
