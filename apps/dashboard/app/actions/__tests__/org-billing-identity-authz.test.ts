/**
 * Proves the role gate + payload honesty on the org
 * billing-identity Server Actions, following the org-settings-authz.test.ts
 * pattern. Asserts the OUTCOME for each case:
 *
 *   - a plain `member` or a `finance` user is DENIED and the org UPDATE never
 *     fires (invoice identity is org administration, the TIGHTEST gate)
 *   - an `owner` / `admin` is ALLOWED, the role is read in the caller's REAL
 *     org, and the write lands on exactly that org
 *   - a bad email or oversized field is rejected BEFORE any write
 *   - blank/whitespace fields are dropped; an all-blank save stores SQL NULL
 *     (so the print view falls back to the org display name, never junk)
 *
 * Behavioral + mutation-sensitive: delete the assertOrgManager() line from the
 * save action and the "member denied / nothing written" cases go RED. The
 * whole DB is mocked; no database needed.
 */

export {}

const ORG = 'org-real-billing-identity'
const USER = 'user-billing-identity'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = {
  activeOrganizationId: ORG,
  userId: USER,
}

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId || sessionState.userId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: sessionState.userId
                ? { id: sessionState.userId }
                : undefined,
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const DB_NULL = Symbol('Prisma.DbNull')
const baMemberFindFirst = jest.fn()
const dbOrgUpdate = jest.fn()
const dbOrgFindUnique = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    organizations: {
      update: (a: unknown) => dbOrgUpdate(a),
      findUnique: (a: unknown) => dbOrgFindUnique(a),
    },
  },
  Prisma: { DbNull: DB_NULL },
}))

type Actions = typeof import('../org-billing-identity')
let actions: Actions

beforeAll(async () => {
  actions = await import('../org-billing-identity')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[baMemberFindFirst, dbOrgUpdate, dbOrgFindUnique].forEach((m) =>
    m.mockReset()
  )
  dbOrgUpdate.mockResolvedValue({})
})

function setRole(r: string) {
  baMemberFindFirst.mockResolvedValue(r === 'noRow' ? null : { role: r })
}

const denyRoles = ['member', 'finance', 'noRow'] as const
const allowRoles = ['owner', 'admin'] as const

describe('saveOrgBillingIdentity — DENY: member + finance blocked, NOTHING written', () => {
  it.each(denyRoles)('denied for %s', async (r) => {
    setRole(r)
    const res = await actions.saveOrgBillingIdentity({ legalName: 'Acme Ltd' })
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })

  it('denied with no session at all', async () => {
    sessionState = { activeOrganizationId: null, userId: null }
    const res = await actions.saveOrgBillingIdentity({ legalName: 'Acme Ltd' })
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })
})

describe('saveOrgBillingIdentity — ALLOW: owner/admin write, scoped to the active org', () => {
  it.each(allowRoles)('role is read in the active org for %s', async (r) => {
    setRole(r)
    const res = await actions.saveOrgBillingIdentity({ legalName: 'Acme Ltd' })
    expect(res.success).toBe(true)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it.each(allowRoles)('update fires exactly once on the active org for %s', async (r) => {
    setRole(r)
    const res = await actions.saveOrgBillingIdentity({ legalName: 'Acme Ltd' })
    expect(res.success).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)
    expect(dbOrgUpdate.mock.calls[0][0].where.id).toBe(ORG)
  })
})

describe('saveOrgBillingIdentity — payload honesty (validated, trimmed, never invented)', () => {
  it('rejects a malformed email BEFORE any write', async () => {
    setRole('owner')
    const res = await actions.saveOrgBillingIdentity({
      legalName: 'Acme Ltd',
      email: 'not-an-email',
    })
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })

  it('rejects an oversized field BEFORE any write', async () => {
    setRole('owner')
    const res = await actions.saveOrgBillingIdentity({
      legalName: 'x'.repeat(256),
    })
    expect(res.success).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })

  it('trims values and drops blank fields from what gets stored', async () => {
    setRole('owner')
    const res = await actions.saveOrgBillingIdentity({
      legalName: '  Acme Ltd  ',
      addressLine1: '   ',
      email: ' billing@acme.example ',
    })
    expect(res.success).toBe(true)
    expect(dbOrgUpdate.mock.calls[0][0].data.billingIdentity).toEqual({
      legalName: 'Acme Ltd',
      email: 'billing@acme.example',
    })
  })

  it('an all-blank save stores SQL NULL, not an empty object', async () => {
    setRole('owner')
    const res = await actions.saveOrgBillingIdentity({
      legalName: '',
      city: '   ',
    })
    expect(res.success).toBe(true)
    expect(dbOrgUpdate.mock.calls[0][0].data.billingIdentity).toBe(DB_NULL)
  })
})

// MUTATION SENSITIVITY: same call, only the role flips -> outcome flips.
describe('saveOrgBillingIdentity — mutation sensitivity (role flip flips outcome)', () => {
  it('owner writes, member does not — identical input', async () => {
    setRole('owner')
    expect(
      (await actions.saveOrgBillingIdentity({ legalName: 'Acme Ltd' })).success
    ).toBe(true)
    expect(dbOrgUpdate).toHaveBeenCalledTimes(1)

    dbOrgUpdate.mockClear()
    setRole('member')
    expect(
      (await actions.saveOrgBillingIdentity({ legalName: 'Acme Ltd' })).success
    ).toBe(false)
    expect(dbOrgUpdate).not.toHaveBeenCalled()
  })
})

describe('getOrgBillingIdentity — session-scoped read, honest null on junk', () => {
  it('fails without a session', async () => {
    sessionState = { activeOrganizationId: null, userId: null }
    const res = await actions.getOrgBillingIdentity()
    expect(res.success).toBe(false)
  })

  it('reads the session org and returns the stored identity with the org name', async () => {
    dbOrgFindUnique.mockResolvedValue({
      name: 'Acme Corp',
      billingIdentity: { legalName: 'Acme Ltd', email: 'billing@acme.example' },
    })
    const res = await actions.getOrgBillingIdentity()
    expect(res).toEqual({
      success: true,
      data: {
        orgName: 'Acme Corp',
        identity: { legalName: 'Acme Ltd', email: 'billing@acme.example' },
      },
    })
    expect(dbOrgFindUnique.mock.calls[0][0].where.id).toBe(ORG)
  })

  it('returns identity null when nothing is stored (org-name fallback territory)', async () => {
    dbOrgFindUnique.mockResolvedValue({ name: 'Acme Corp', billingIdentity: null })
    const res = await actions.getOrgBillingIdentity()
    expect(res).toEqual({
      success: true,
      data: { orgName: 'Acme Corp', identity: null },
    })
  })

  it('returns identity null when the stored JSON is malformed, never junk', async () => {
    dbOrgFindUnique.mockResolvedValue({
      name: 'Acme Corp',
      billingIdentity: { email: 12345, legalName: { nested: true } },
    })
    const res = await actions.getOrgBillingIdentity()
    expect(res).toEqual({
      success: true,
      data: { orgName: 'Acme Corp', identity: null },
    })
  })
})
