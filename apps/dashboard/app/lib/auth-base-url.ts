type Env = Record<string, string | undefined>

/**
 * The address Better Auth builds sign-in links and OAuth callbacks from.
 *
 * Order matters. OAuth providers only accept the exact callback address that
 * was registered with them, so an explicit non-localhost BETTER_AUTH_URL wins
 * over VERCEL_URL (which changes on every deployment). A localhost
 * BETTER_AUTH_URL is only trusted when VERCEL_URL is absent, so a localhost
 * value that leaks into a deployment cannot win.
 */
export function getAuthBaseURL(env: Env = process.env): string {
  if (env.BETTER_AUTH_URL && !env.BETTER_AUTH_URL.includes('localhost')) {
    return env.BETTER_AUTH_URL
  }
  if (
    env.NEXT_PUBLIC_BETTER_AUTH_URL &&
    !env.NEXT_PUBLIC_BETTER_AUTH_URL.includes('localhost')
  ) {
    return env.NEXT_PUBLIC_BETTER_AUTH_URL
  }
  if (env.VERCEL_URL) {
    return `https://${env.VERCEL_URL}`
  }
  if (env.BETTER_AUTH_URL) {
    return env.BETTER_AUTH_URL
  }
  return 'http://localhost:3000'
}
