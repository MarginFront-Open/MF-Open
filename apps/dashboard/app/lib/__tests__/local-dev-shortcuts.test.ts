import {
  isLocalDevShortcutActive,
  localDevShortcutRefusal,
} from '../local-dev-shortcuts'

const LOCAL_ENV = {
  NODE_ENV: 'development',
  BETTER_AUTH_URL: 'http://localhost:3000',
  SKIP_OTP_EMAIL: 'true',
  SKIP_MAGIC_LINK_EMAIL: 'true',
}

function headers(values: Record<string, string>) {
  return new Headers(values)
}

describe('local-development sign-in shortcuts', () => {
  let errorSpy: jest.SpyInstance
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('is off unless the switch is explicitly "true", even in development on localhost', () => {
    const env = { ...LOCAL_ENV, SKIP_OTP_EMAIL: undefined }
    expect(isLocalDevShortcutActive('SKIP_OTP_EMAIL', null, env)).toBe(false)
    expect(
      isLocalDevShortcutActive('SKIP_OTP_EMAIL', null, {
        ...LOCAL_ENV,
        SKIP_OTP_EMAIL: '1',
      })
    ).toBe(false)
  })

  it('works on localhost outside production, and says so loudly', () => {
    expect(
      isLocalDevShortcutActive(
        'SKIP_OTP_EMAIL',
        headers({ host: 'localhost:3000' }),
        LOCAL_ENV
      )
    ).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SKIP_OTP_EMAIL=true is ACTIVE')
    )
  })

  it('refuses when NODE_ENV is production', () => {
    const env = { ...LOCAL_ENV, NODE_ENV: 'production' }
    expect(isLocalDevShortcutActive('SKIP_OTP_EMAIL', null, env)).toBe(false)
    expect(isLocalDevShortcutActive('SKIP_MAGIC_LINK_EMAIL', null, env)).toBe(
      false
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('was IGNORED because NODE_ENV is "production"')
    )
  })

  it('refuses when the app is configured for a real hostname', () => {
    const env = { ...LOCAL_ENV, BETTER_AUTH_URL: 'https://app.example.com' }
    expect(isLocalDevShortcutActive('SKIP_OTP_EMAIL', null, env)).toBe(false)
    expect(localDevShortcutRefusal(env)).toContain('not localhost')
  })

  it('refuses on a hosted deployment even if a localhost address leaked into its config', () => {
    const env = { ...LOCAL_ENV, VERCEL_URL: 'my-app.vercel.app' }
    expect(isLocalDevShortcutActive('SKIP_OTP_EMAIL', null, env)).toBe(false)
  })

  it.each([
    ['a tunnel host header', { host: 'abc123.ngrok.app' }],
    [
      'a proxy forwarding a public host',
      { host: 'localhost:3000', 'x-forwarded-host': 'dev.example.com' },
    ],
    ['a LAN address', { host: '192.168.1.20:3000' }],
    ['a look-alike host', { host: 'localhost.evil.example' }],
  ])(
    'refuses when the request arrived through %s, even in development',
    (_label, headerValues) => {
      expect(
        isLocalDevShortcutActive(
          'SKIP_OTP_EMAIL',
          headers(headerValues),
          LOCAL_ENV
        )
      ).toBe(false)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('is not localhost')
      )
    }
  )

  it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'app.localhost'])(
    'accepts the loopback host %s',
    (host) => {
      expect(localDevShortcutRefusal(LOCAL_ENV, headers({ host }))).toBeNull()
    }
  )
})
