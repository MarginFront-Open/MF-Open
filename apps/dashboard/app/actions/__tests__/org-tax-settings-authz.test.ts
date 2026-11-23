/**
 * WHAT THIS FILE DOES: proves the money-write gate on updateOrgTaxSettings
 * (toggling Stripe automatic tax changes what every customer is charged). This action
 * uses the ActionResult<T> union, whose failure arm is { success: false, error } — the
 * same shape the gate returns — so the gate composes cleanly inside its try/catch.
 *
 *   - member / no-membership -> { success: false }, NO organizations.update
 *   - finance -> the update fires, scoped to the caller's own (real) org
 */

export {}

const ORG = 'org-real-tax'
const USER = 'user-tax'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = { activeOrganizationId: ORG, userId: USER }

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const baMemberFindFirst = jest.fn()
const orgUpdate = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    organizations: { update: (a: unknown) => orgUpdate(a) },
  },
}))

type Mod = typeof import('../org-tax-settings')
let mod: Mod

beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  mod = await import('../org-tax-settings')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  orgUpdate.mockReset()
})

describe('updateOrgTaxSettings — money-write gate', () => {
  it('rejects a plain member and does NOT update the org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.updateOrgTaxSettings(true)
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toMatch(/finance, admin, or owner/i)
    expect(orgUpdate).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a caller with no membership row', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const res = await mod.updateOrgTaxSettings(true)
    expect(res.success).toBe(false)
    expect(orgUpdate).not.toHaveBeenCalled()
  })

  it('lets an admin toggle tax, scoped to their own org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'admin' })
    orgUpdate.mockResolvedValue({ stripeAutomaticTax: true })
    const res = await mod.updateOrgTaxSettings(true)
    expect(res.success).toBe(true)
    expect(orgUpdate.mock.calls[0][0].where.id).toBe(ORG)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })
})
