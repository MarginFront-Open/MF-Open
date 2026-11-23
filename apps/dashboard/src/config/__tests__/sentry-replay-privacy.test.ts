const replayIntegration = jest.fn((options: unknown) => ({ replay: options }))
const init = jest.fn()

jest.mock('@sentry/nextjs', () => ({
  init: (...a: unknown[]) => init(...a),
  replayIntegration: (options: unknown) => replayIntegration(options),
  browserTracingIntegration: () => ({}),
}))

const REAL_ENV = process.env

describe('Sentry session replay privacy', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    process.env = {
      ...REAL_ENV,
      NEXT_PUBLIC_SENTRY_DSN: 'https://key@sentry.example/1',
    }
    delete process.env.NEXT_PUBLIC_SENTRY_REPLAY_UNMASK
  })

  afterEach(() => {
    process.env = REAL_ENV
  })

  const MASKED = { maskAllText: true, maskAllInputs: true, blockAllMedia: true }

  it('masks all text and inputs and blocks all media by default', async () => {
    const { getReplayPrivacyOptions } = await import('../sentry')
    expect(getReplayPrivacyOptions()).toEqual(MASKED)
  })

  it.each(['false', '1', 'yes', ''])(
    'stays masked when NEXT_PUBLIC_SENTRY_REPLAY_UNMASK is %j',
    async (value) => {
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_UNMASK = value
      const { getReplayPrivacyOptions } = await import('../sentry')
      expect(getReplayPrivacyOptions()).toEqual(MASKED)
    }
  )

  it('unmasks text and media only on an explicit "true", and still masks inputs', async () => {
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_UNMASK = 'true'
    const { getReplayPrivacyOptions } = await import('../sentry')
    expect(getReplayPrivacyOptions()).toEqual({
      maskAllText: false,
      maskAllInputs: true,
      blockAllMedia: false,
    })
  })

  it('initSentry() starts replay masked', async () => {
    const { initSentry } = await import('../sentry')
    initSentry()
    expect(replayIntegration).toHaveBeenCalledWith(MASKED)
  })

  it('sentry.client.config starts replay masked', async () => {
    await import('../../../sentry.client.config')
    expect(replayIntegration).toHaveBeenCalledWith(MASKED)
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('does not start Sentry at all without a DSN', async () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    await import('../../../sentry.client.config')
    const { initSentry } = await import('../sentry')
    initSentry()
    expect(init).not.toHaveBeenCalled()
    jest.restoreAllMocks()
  })
})
