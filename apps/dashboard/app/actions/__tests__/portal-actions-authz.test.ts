/**
 * The portal role gate on the real Server Actions: refused callers never reach
 * a customer lookup, mint or email. Removing the gate from any action except
 * sendCustomerPortalLink (backed by generateCustomerPortalLink's gate) turns
 * its "refuses" cases red.
 */

export {}

const ORG = 'org-real-portal'
const USER = 'user-portal'
const USER_EMAIL = 'me@team.test'
const CUSTOMER = { id: 'cust-1', name: 'Acme', email: 'billing@acme.test' }

let sessionState: { activeOrganizationId: string | null } = {
  activeOrganizationId: ORG,
}

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: USER, email: USER_EMAIL },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const baMemberFindFirst = jest.fn()
const prismaCustomersFindFirst = jest.fn()
const prismaOrgFindUnique = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    customers: { findFirst: (a: unknown) => prismaCustomersFindFirst(a) },
    organizations: { findUnique: (a: unknown) => prismaOrgFindUnique(a) },
  },
}))

const createPortalSession = jest.fn()
const createPortalMagicLink = jest.fn()
jest.mock('@/app/lib/portal-auth', () => ({
  MAGIC_LINK_TOKEN_PREFIX: 'mgl_',
  createPortalSession: (...a: unknown[]) => createPortalSession(...a),
  createPortalMagicLink: (...a: unknown[]) => createPortalMagicLink(...a),
}))
jest.mock('@/lib/portal-url', () => ({
  buildRedeemUrl: (token: string) => `https://portal.test/r/${token}`,
}))

const resendSend = jest.fn()
jest.mock('resend', () => ({
  Resend: class {
    emails = { send: (a: unknown) => resendSend(a) }
  },
}))

type Result = { success: boolean; error?: string; errorCode?: string }
let actions: Array<[string, () => Promise<Result>]>

beforeAll(async () => {
  const { impersonateCustomer } = await import('../impersonate-customer')
  const { generateCustomerPortalLink } = await import(
    '../generate-customer-portal-link'
  )
  const { sendCustomerPortalLink } = await import(
    '../send-customer-portal-link'
  )
  const { openTestPortal } = await import('../test-portal')
  actions = [
    ['impersonateCustomer', () => impersonateCustomer(CUSTOMER.id)],
    [
      'generateCustomerPortalLink',
      () => generateCustomerPortalLink(CUSTOMER.id),
    ],
    ['sendCustomerPortalLink', () => sendCustomerPortalLink(CUSTOMER.id)],
    ['openTestPortal', () => openTestPortal()],
  ]
})

const ORIGINAL_RESEND_KEY = process.env.RESEND_API_KEY
const ORIGINAL_INVOICE_SENDER = process.env.RESEND_INVOICE_FROM_EMAIL
const ORIGINAL_SENDER = process.env.RESEND_FROM_EMAIL
const ORIGINAL_COMPANY_NAME = process.env.NEXT_PUBLIC_COMPANY_NAME

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG }
  for (const m of [
    baMemberFindFirst,
    prismaCustomersFindFirst,
    prismaOrgFindUnique,
    createPortalSession,
    createPortalMagicLink,
    resendSend,
  ]) {
    m.mockReset()
  }
  prismaCustomersFindFirst.mockResolvedValue(CUSTOMER)
  prismaOrgFindUnique.mockResolvedValue({ slug: 'acme-org', name: 'Acme Org' })
  createPortalSession.mockResolvedValue('prtl_token')
  createPortalMagicLink.mockResolvedValue('mgl_token')
  resendSend.mockResolvedValue({ data: { id: 'email-1' }, error: null })
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.RESEND_INVOICE_FROM_EMAIL = 'Billing <noreply@billing.test>'
  delete process.env.RESEND_FROM_EMAIL
})

afterAll(() => {
  if (ORIGINAL_RESEND_KEY === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND_KEY
  if (ORIGINAL_INVOICE_SENDER === undefined) delete process.env.RESEND_INVOICE_FROM_EMAIL
  else process.env.RESEND_INVOICE_FROM_EMAIL = ORIGINAL_INVOICE_SENDER
  if (ORIGINAL_SENDER === undefined) delete process.env.RESEND_FROM_EMAIL
  else process.env.RESEND_FROM_EMAIL = ORIGINAL_SENDER
  if (ORIGINAL_COMPANY_NAME === undefined) delete process.env.NEXT_PUBLIC_COMPANY_NAME
  else process.env.NEXT_PUBLIC_COMPANY_NAME = ORIGINAL_COMPANY_NAME
})

function expectNothingMinted() {
  expect(prismaCustomersFindFirst).not.toHaveBeenCalled()
  expect(createPortalSession).not.toHaveBeenCalled()
  expect(createPortalMagicLink).not.toHaveBeenCalled()
  expect(resendSend).not.toHaveBeenCalled()
}

const run = (name: string) => actions.find(([n]) => n === name)![1]()

describe.each([
  'impersonateCustomer',
  'generateCustomerPortalLink',
  'sendCustomerPortalLink',
  'openTestPortal',
])('%s — role gate', (name) => {
  it.each(['member', 'developer', 'legal'])(
    'refuses a %s and mints nothing',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const result = await run(name)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/finance, admin, or owner/i)
      expectNothingMinted()
    }
  )

  it('refuses a caller with no membership row and mints nothing', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const result = await run(name)
    expect(result.success).toBe(false)
    expectNothingMinted()
  })

  it('refuses a signed-out caller without a role lookup', async () => {
    sessionState = { activeOrganizationId: null }
    const result = await run(name)
    expect(result.success).toBe(false)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
    expectNothingMinted()
  })

  it.each(['owner', 'admin', 'finance'])(
    'lets a %s through',
    async (role) => {
      baMemberFindFirst.mockResolvedValue({ role })
      const result = await run(name)
      expect(result.success).toBe(true)
      for (const [arg] of baMemberFindFirst.mock.calls) {
        expect(arg.where).toMatchObject({
          organizationId: ORG,
          userId: USER,
        })
      }
    }
  )
})

describe('allowed callers mint in the active org', () => {
  beforeEach(() => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
  })

  it('impersonateCustomer stamps the caller as impersonatedBy', async () => {
    await run('impersonateCustomer')
    expect(prismaCustomersFindFirst.mock.calls[0][0].where).toMatchObject({
      id: CUSTOMER.id,
      organizationId: ORG,
    })
    expect(createPortalSession).toHaveBeenCalledWith(
      CUSTOMER.id,
      ORG,
      null,
      'Admin Impersonation',
      { impersonatedBy: USER }
    )
  })

  it('generateCustomerPortalLink mints a magic link for the org customer', async () => {
    await run('generateCustomerPortalLink')
    expect(prismaCustomersFindFirst.mock.calls[0][0].where).toMatchObject({
      id: CUSTOMER.id,
      organizationId: ORG,
    })
    expect(createPortalMagicLink.mock.calls[0].slice(0, 2)).toEqual([
      CUSTOMER.id,
      ORG,
    ])
  })

  it('sendCustomerPortalLink emails the customer', async () => {
    await run('sendCustomerPortalLink')
    expect(createPortalMagicLink).toHaveBeenCalledTimes(1)
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: CUSTOMER.email })
    )
  })

  it('sendCustomerPortalLink omits MarginFront and copyright when NEXT_PUBLIC_COMPANY_NAME is unset', async () => {
    delete process.env.NEXT_PUBLIC_COMPANY_NAME
    await run('sendCustomerPortalLink')
    const sent = resendSend.mock.calls[0][0]
    expect(sent.html).not.toContain('MarginFront')
    expect(sent.html).not.toContain('©')
  })

  it('sendCustomerPortalLink renders escaped operator copyright when NEXT_PUBLIC_COMPANY_NAME is set', async () => {
    process.env.NEXT_PUBLIC_COMPANY_NAME = 'Acme & <Co>'
    await run('sendCustomerPortalLink')
    const sent = resendSend.mock.calls[0][0]
    expect(sent.html).not.toContain('MarginFront')
    expect(sent.html).toMatch(/© \d{4} Acme &amp; &lt;Co&gt;/)
  })

  it('sendCustomerPortalLink refuses to send without a configured sender, and says which setting fixes it', async () => {
    delete process.env.RESEND_INVOICE_FROM_EMAIL
    const result = await run('sendCustomerPortalLink')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/RESEND_INVOICE_FROM_EMAIL/)
    expect(result.error).toMatch(/Copy URL/)
    expect(resendSend).not.toHaveBeenCalled()
  })

  it('openTestPortal looks up the caller’s own test customer', async () => {
    await run('openTestPortal')
    expect(prismaCustomersFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      email: USER_EMAIL,
    })
    expect(createPortalSession.mock.calls[0][4]).toEqual({
      impersonatedBy: USER,
    })
  })
})

describe('generateCustomerPortalLink error codes', () => {
  it('reports forbidden for a member', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const result = await run('generateCustomerPortalLink')
    expect(result.errorCode).toBe('forbidden')
  })

  it('reports unauthenticated for a signed-out caller', async () => {
    sessionState = { activeOrganizationId: null }
    const result = await run('generateCustomerPortalLink')
    expect(result.errorCode).toBe('unauthenticated')
  })
})
