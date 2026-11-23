import {
  TURNSTILE_NO_HOSTNAMES_MESSAGE,
  verifyTurnstileToken,
} from '../turnstile'

// The Cloudflare siteverify endpoint is called via global.fetch. We mock it
// per-test to assert the helper's branching logic without hitting the real
// network. Restores the original fetch in afterEach.

const REAL_FETCH = global.fetch
const REAL_ENV = process.env

describe('verifyTurnstileToken', () => {
  beforeEach(() => {
    process.env = {
      ...REAL_ENV,
      TURNSTILE_SECRET_KEY: 'fake-secret-key',
      TURNSTILE_ALLOWED_HOSTNAMES: 'app.example.com, localhost',
    }
  })

  afterEach(() => {
    process.env = REAL_ENV
    global.fetch = REAL_FETCH
  })

  function mockFetch(response: any) {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => response,
    }) as any
  }

  it('returns false when token is missing', async () => {
    const result = await verifyTurnstileToken(null)
    expect(result).toBe(false)
  })

  it('returns false when token is undefined', async () => {
    const result = await verifyTurnstileToken(undefined)
    expect(result).toBe(false)
  })

  it('returns false when token is empty string', async () => {
    const result = await verifyTurnstileToken('')
    expect(result).toBe(false)
  })

  it('returns false when TURNSTILE_SECRET_KEY is unset', async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    const result = await verifyTurnstileToken('some-token')
    expect(result).toBe(false)
  })

  it('returns true on Cloudflare success when hostname is in TURNSTILE_ALLOWED_HOSTNAMES', async () => {
    mockFetch({ success: true, hostname: 'app.example.com' })
    const result = await verifyTurnstileToken('valid-token', '1.2.3.4')
    expect(result).toBe(true)
  })

  it('accepts every hostname in the comma-separated list', async () => {
    mockFetch({ success: true, hostname: 'localhost' })
    const result = await verifyTurnstileToken('valid-token')
    expect(result).toBe(true)
  })

  it('has no built-in hostnames: with the list unset it rejects everything and never calls Cloudflare', async () => {
    delete process.env.TURNSTILE_ALLOWED_HOSTNAMES
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ success: true, hostname: 'localhost' }),
    })
    global.fetch = fetchMock as any

    expect(await verifyTurnstileToken('valid-token')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(TURNSTILE_NO_HOSTNAMES_MESSAGE)
    expect(TURNSTILE_NO_HOSTNAMES_MESSAGE).toContain('Fix:')
    errorSpy.mockRestore()
  })

  it.each(['app.example.org', 'qa.example.org'])(
    'does not accept the hostname %s unless the operator lists it',
    async (hostname) => {
      mockFetch({ success: true, hostname })
      expect(await verifyTurnstileToken('valid-token')).toBe(false)
    }
  )

  it('rejects a Cloudflare success that names no hostname', async () => {
    mockFetch({ success: true })
    expect(await verifyTurnstileToken('valid-token')).toBe(false)
  })

  it('returns false on Cloudflare success but hostname mismatch (replay defense)', async () => {
    // An attacker minted the token on their own site and replayed it.
    mockFetch({ success: true, hostname: 'attacker.example.com' })
    const result = await verifyTurnstileToken('replayed-token')
    expect(result).toBe(false)
  })

  it('respects TURNSTILE_ALLOWED_HOSTNAMES override', async () => {
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'custom-host.example.com'
    mockFetch({ success: true, hostname: 'custom-host.example.com' })
    const result = await verifyTurnstileToken('valid-token')
    expect(result).toBe(true)
  })

  it('returns false when Cloudflare reports verification failure', async () => {
    mockFetch({
      success: false,
      'error-codes': ['invalid-input-response'],
    })
    const result = await verifyTurnstileToken('bad-token')
    expect(result).toBe(false)
  })

  it('returns false on timeout-or-duplicate (replayed token)', async () => {
    mockFetch({
      success: false,
      'error-codes': ['timeout-or-duplicate'],
    })
    const result = await verifyTurnstileToken('already-used-token')
    expect(result).toBe(false)
  })

  it('returns false when fetch throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any
    const result = await verifyTurnstileToken('token')
    expect(result).toBe(false)
  })

  it('forwards remoteip to Cloudflare when provided', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ success: true, hostname: 'localhost' }),
    })
    global.fetch = fetchMock as any

    await verifyTurnstileToken('valid-token', '203.0.113.42')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const body = init.body as URLSearchParams
    expect(body.get('secret')).toBe('fake-secret-key')
    expect(body.get('response')).toBe('valid-token')
    expect(body.get('remoteip')).toBe('203.0.113.42')
  })

  it('omits remoteip from request when not provided', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ success: true, hostname: 'localhost' }),
    })
    global.fetch = fetchMock as any

    await verifyTurnstileToken('valid-token')

    const [, init] = fetchMock.mock.calls[0]
    const body = init.body as URLSearchParams
    expect(body.get('remoteip')).toBeNull()
  })
})

describe('TURNSTILE_PROTECTED_PATHS', () => {
  const { readFileSync } = jest.requireActual<typeof import('fs')>('fs')
  const { dirname, join } = jest.requireActual<typeof import('path')>('path')
  const { TURNSTILE_PROTECTED_PATHS } =
    jest.requireActual<typeof import('../turnstile')>('../turnstile')
  const betterAuthDist = dirname(require.resolve('better-auth'))
  const betterAuthRoutes = [
    'api/routes/sign-in.mjs',
    'api/routes/sign-up.mjs',
    'plugins/email-otp/routes.mjs',
    'plugins/magic-link/index.mjs',
  ]
    .map((file) => readFileSync(join(betterAuthDist, file), 'utf8'))
    .join('\n')

  it('covers both password-reset paths that send a code email on their own', () => {
    expect(TURNSTILE_PROTECTED_PATHS.has('/email-otp/request-password-reset')).toBe(
      true
    )
    expect(TURNSTILE_PROTECTED_PATHS.has('/forget-password/email-otp')).toBe(true)
  })

  it('lists only paths the installed Better Auth really serves', () => {
    for (const path of TURNSTILE_PROTECTED_PATHS) {
      expect(betterAuthRoutes).toContain(`createAuthEndpoint("${path}"`)
    }
  })
})
