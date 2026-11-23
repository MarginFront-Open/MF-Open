/**
 * WHAT THIS FILE DOES: proves the money-write gate on a representative
 * invoices action (voidInvoice — an irreversible book write). Fully mocked DB.
 *
 *   - member / no-membership -> { success: false }, and NEITHER the invoice
 *     lookup NOR the void update is ever called (the gate stops it before any DB
 *     touch).
 *   - finance -> the gate passes and execution reaches the data layer; the
 *     invoice lookup is scoped to the caller's own (real) org. Invoices use the
 *     raw active org as their data org, so role-org and
 *     data-org are the same here — proven by the lookup's organizationId.
 */

export {}

const ORG = 'org-real-inv'
const USER = 'user-inv'

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
const baMemberFindFirst = jest.fn()
const invoiceFindFirst = jest.fn()
const invoiceUpdate = jest.fn()
jest.mock('@/app/lib/db', () => ({
  // invoices.ts also imports { Prisma } from this module — provide a stub so the
  // import doesn't blow up at module load.
  Prisma: {},
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    invoices: {
      findFirst: (a: unknown) => invoiceFindFirst(a),
      update: (a: unknown) => invoiceUpdate(a),
    },
  },
}))

type Mod = typeof import('../invoices')
let mod: Mod

beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  mod = await import('../invoices')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  invoiceFindFirst.mockReset()
  invoiceUpdate.mockReset()
})

describe('voidInvoice — money-write gate', () => {
  it('rejects a plain member and never touches the invoice', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.voidInvoice('inv-1', 'mistake')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/finance, admin, or owner/i)
    expect(invoiceFindFirst).not.toHaveBeenCalled()
    expect(invoiceUpdate).not.toHaveBeenCalled()
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('rejects a caller with no membership row and never touches the invoice', async () => {
    baMemberFindFirst.mockResolvedValue(null)
    const res = await mod.voidInvoice('inv-1', 'mistake')
    expect(res.success).toBe(false)
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })

  it('lets a finance user through to the data layer, scoped to their own org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    invoiceFindFirst.mockResolvedValue(null) // stop cleanly at "Invoice not found"
    const res = await mod.voidInvoice('inv-1', 'mistake')
    // The gate passed: the action reached its org-scoped invoice lookup.
    expect(invoiceFindFirst).toHaveBeenCalledTimes(1)
    expect(invoiceFindFirst.mock.calls[0][0].where).toMatchObject({
      id: 'inv-1',
      organizationId: ORG,
    })
    // No matching invoice -> the action's own not-found path, NOT the gate.
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })
})
