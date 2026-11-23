export type SocialProviderId = 'google' | 'github'

type Env = Record<string, string | undefined>

/**
 * The social sign-in providers this install has credentials for. One source of
 * truth for both the server (which providers Better Auth registers) and the
 * sign-in screens (which buttons are shown), so a button can never appear for a
 * provider that would fail on click.
 */
export function getSocialProviderCredentials(
  env: Env = process.env
): Partial<
  Record<SocialProviderId, { clientId: string; clientSecret: string }>
> {
  const providers: Partial<
    Record<SocialProviderId, { clientId: string; clientSecret: string }>
  > = {}

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    }
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }
  }
  return providers
}

export function getEnabledSocialProviders(
  env: Env = process.env
): SocialProviderId[] {
  return Object.keys(getSocialProviderCredentials(env)) as SocialProviderId[]
}
