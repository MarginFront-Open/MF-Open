import { readFileSync } from 'fs'
import { join } from 'path'
import {
  getEnabledSocialProviders,
  getSocialProviderCredentials,
} from '../social-providers'

const DASHBOARD = join(__dirname, '..', '..', '..')

describe('which social sign-in providers are on', () => {
  it('is none on an install with no provider credentials', () => {
    expect(getEnabledSocialProviders({})).toEqual([])
  })

  it('needs both the client id and the secret', () => {
    expect(getEnabledSocialProviders({ GOOGLE_CLIENT_ID: 'id' })).toEqual([])
    expect(getEnabledSocialProviders({ GOOGLE_CLIENT_SECRET: 's' })).toEqual([])
    expect(
      getEnabledSocialProviders({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 's',
      })
    ).toEqual(['google'])
  })

  it('lists each configured provider and hands Better Auth the same set', () => {
    const env = {
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gs',
      GITHUB_CLIENT_ID: 'hid',
      GITHUB_CLIENT_SECRET: 'hs',
    }
    expect(getEnabledSocialProviders(env)).toEqual(['google', 'github'])
    expect(getSocialProviderCredentials(env)).toEqual({
      google: { clientId: 'gid', clientSecret: 'gs' },
      github: { clientId: 'hid', clientSecret: 'hs' },
    })
  })
})

describe('the sign-in screen only shows a provider button when that provider is on', () => {
  const signInFormPath = join(
    DASHBOARD,
    'src',
    'features',
    'auth',
    'sign-in',
    'components',
    'sign-in-form.tsx'
  )

  it('wraps every Google button in the provider gate', () => {
    const source = readFileSync(signInFormPath, 'utf8')
    const gated = [
      ...source.matchAll(
        /<IfSocialProvider provider='google'>([\s\S]*?)<\/IfSocialProvider>/g
      ),
    ]
      .map((m) => m[1])
      .join('\n')
    const outside = source.replace(
      /<IfSocialProvider provider='google'>[\s\S]*?<\/IfSocialProvider>/g,
      ''
    )

    const clickHandlers = /onClick=\{(handleGoogleLogin|\(\) => handleSocial\('google'\))\}/g
    expect(gated.match(clickHandlers)?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(outside.match(clickHandlers)).toBeNull()
  })

  it('the gate shows nothing unless the server listed the provider', () => {
    const source = readFileSync(
      join(
        DASHBOARD,
        'src',
        'features',
        'auth',
        'sign-in',
        'lib',
        'social-providers-context.tsx'
      ),
      'utf8'
    )
    expect(source).toContain(
      'createContext<readonly SocialProviderId[]>([])'
    )
  })

  it('the auth layout feeds the gate from the server environment', () => {
    const source = readFileSync(
      join(DASHBOARD, 'app', '(auth)', 'layout.tsx'),
      'utf8'
    )
    expect(source).toContain(
      '<SocialProvidersProvider providers={getEnabledSocialProviders()}>'
    )
    expect(source).toContain("export const dynamic = 'force-dynamic'")
  })
})
