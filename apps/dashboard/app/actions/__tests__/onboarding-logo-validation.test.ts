export {}

const ORG = 'org-logo-validation'
const USER = 'user-logo-validation'

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ORG },
        user: { id: USER },
      }),
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('@/lib/api/config', () => ({ API_BASE_URL: 'http://test.local' }))

const baMemberFindFirst = jest.fn()
const dbOrgUpdate = jest.fn()
const dbOrgFindUnique = jest.fn()
const dbTransaction = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    organizations: {
      update: (a: unknown) => dbOrgUpdate(a),
      findUnique: (a: unknown) => dbOrgFindUnique(a),
    },
    $transaction: (fn: unknown) => dbTransaction(fn),
  },
  Prisma: { InputJsonValue: {} },
}))

let onboarding: typeof import('../onboarding')

beforeAll(async () => {
  onboarding = await import('../onboarding')
})

beforeEach(() => {
  baMemberFindFirst.mockReset().mockResolvedValue({ role: 'owner' })
  dbOrgUpdate.mockReset().mockResolvedValue({})
  dbOrgFindUnique.mockReset().mockResolvedValue({ designjson: {} })
  dbTransaction
    .mockReset()
    .mockImplementation(async (fn: (tx: any) => unknown) =>
      fn({
        agents: { create: jest.fn().mockResolvedValue({}) },
        signals: { create: jest.fn().mockResolvedValue({}) },
        pricing_plans: { create: jest.fn().mockResolvedValue({}) },
        agent_pricing_plans: { create: jest.fn().mockResolvedValue({}) },
        pricing_strategies: { create: jest.fn().mockResolvedValue({}) },
      })
    )
})

describe('dashboard onboarding logo write validation', () => {
  it.each([
    'http://cdn.example.com/logo.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/logo.png',
    'https://[::1]/logo.png',
    'data:image/png;base64,AAAA',
  ])(
    'updateOnboardingStatus rejects unsafe companyLogo %s without updating DB',
    async (companyLogo) => {
      const res = await onboarding.updateOnboardingStatus({
        branding: { companyLogo },
      })

      expect(res.success).toBe(false)
      if (!res.success) {
        expect(res.error).toContain('public https:// address')
      }
      expect(dbOrgUpdate).not.toHaveBeenCalled()
    }
  )

  it('updateOnboardingStatus accepts a valid public HTTPS companyLogo', async () => {
    const res = await onboarding.updateOnboardingStatus({
      branding: { companyLogo: 'https://cdn.example.com/logo.png' },
    })

    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logo: 'https://cdn.example.com/logo.png',
        }),
      })
    )
  })

  it('createFromEnhancedPreview drops unsafe scraped companyInfo.logo without failing onboarding', async () => {
    const res = await onboarding.createFromEnhancedPreview({
      success: true,
      websiteUrl: 'https://acme.example.com',
      companyInfo: {
        name: 'Acme',
        logo: 'http://169.254.169.254/latest/meta-data/',
        website: 'https://acme.example.com',
      },
      pricingData: { tiers: [], signals: [], serviceCosts: [] },
      customers: [],
      summary: {
        pricingTiersCount: 0,
        signalsCount: 0,
        serviceCostsCount: 0,
        customersCount: 0,
      },
    })

    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)
    const updateData = dbOrgUpdate.mock.calls[0][0].data
    expect(updateData.logo).toBeUndefined()
    expect(updateData.website).toBe('https://acme.example.com')
  })

  it('createFromEnhancedPreview saves valid public HTTPS companyInfo.logo', async () => {
    const res = await onboarding.createFromEnhancedPreview({
      success: true,
      websiteUrl: 'https://acme.example.com',
      companyInfo: {
        name: 'Acme',
        logo: 'https://cdn.example.com/logo.png',
        website: 'https://acme.example.com',
      },
      pricingData: { tiers: [], signals: [], serviceCosts: [] },
      customers: [],
      summary: {
        pricingTiersCount: 0,
        signalsCount: 0,
        serviceCostsCount: 0,
        customersCount: 0,
      },
    })

    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logo: 'https://cdn.example.com/logo.png',
        }),
      })
    )
  })
})
