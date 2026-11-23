/**
 * WHAT THIS FILE DOES: proves the money-write gate on a representative
 * chart-of-accounts action (upsertGlCode). Fully mocked DB.
 *
 *   - member / no-membership  -> { success: false }, NO chart_of_accounts write
 *   - finance/admin/owner     -> the create fires, and both the role lookup and
 *                                the write are scoped to the caller's active org.
 */

export {}

const ORG = 'org-coa'
const USER = 'user-coa'

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
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))

// The helper reads `db.ba_member`; the action writes via `db.chart_of_accounts`.
const baMemberFindFirst = jest.fn()
const coaCount = jest.fn()
const coaCreate = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    chart_of_accounts: {
      count: (a: unknown) => coaCount(a),
      create: (a: unknown) => coaCreate(a),
    },
  },
}))

type Mod = typeof import('../chart-of-accounts')
let mod: Mod

beforeAll(async () => {
  mod = await import('../chart-of-accounts')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  coaCount.mockReset().mockResolvedValue(1) // defaults already persisted -> skip createMany
  coaCreate.mockReset()
})

// A valid GL code whose category + accounting type agree (PRODUCTION_COGS -> COGS),
// so the action gets past its own validation and reaches the write.
const VALID_INPUT = {
  glCode: '5100',
  glName: 'AI Inference COGS',
  costCategory: 'PRODUCTION_COGS' as const,
  accountingType: 'COGS' as const,
}

describe('upsertGlCode — money-write gate', () => {
  it('rejects a plain member and writes NOTHING', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.upsertGlCode(VALID_INPUT)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/finance, admin, or owner/i)
    expect(coaCreate).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a caller with no membership row and writes NOTHING', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const res = await mod.upsertGlCode(VALID_INPUT)
    expect(res.success).toBe(false)
    expect(coaCreate).not.toHaveBeenCalled()
  })

  it('lets a finance user create — role checked and data written on the active org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    coaCreate.mockResolvedValue({
      id: 'gl-1',
      glCode: '5100',
      glName: 'AI Inference COGS',
      costCategory: 'PRODUCTION_COGS',
      accountingType: 'COGS',
      isDefault: false,
      description: null,
    })

    const res = await mod.upsertGlCode(VALID_INPUT)

    expect(res.success).toBe(true)
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
    expect(coaCreate.mock.calls[0][0].data.orgId).toBe(ORG)
  })
})
