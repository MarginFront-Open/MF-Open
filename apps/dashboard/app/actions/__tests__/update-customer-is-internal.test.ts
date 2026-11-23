/**
 * The customer ↔ internal flip's write path, against a fully
 * mocked DB (no database needed; runs in the default unit slice).
 *
 *   1. WRITE: `updateCustomer(id, { isInternal })` persists the flag, both
 *      directions (customer → internal and back).
 *   2. ABSENT KEY = UNTOUCHED: a payload without `isInternal` sends
 *      `undefined` to Prisma, which skips the column — a plain status or
 *      name edit can never accidentally reclassify a record.
 *   3. RBAC: the flip rides updateCustomer's existing BUILD gate
 *      (assert-build-manager, exercised for REAL — not mocked): a
 *      finance-role caller is rejected before any DB write.
 *
 * Mock harness mirrors _shared/__tests__/assert-money-manager.test.ts.
 */

export {}

const ORG = 'org-real-1'
const USER = 'user-1'
const CUSTOMER_ID = 'cust-1'

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
const customersFindFirst = jest.fn()
const customersUpdate = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    customers: {
      findFirst: (a: unknown) => customersFindFirst(a),
      update: (a: unknown) => customersUpdate(a),
    },
  },
  Prisma: {},
}))

// What db.customers.update resolves to — updateCustomer maps every field of
// this into its return DTO, so the row must be shape-complete.
function dbCustomerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    externalId: 'ext-1',
    organizationId: ORG,
    name: 'Flip Test Co',
    email: 'flip@test.example',
    phone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    zipCode: null,
    country: null,
    billingContactName: null,
    billingContactEmail: null,
    status: 'active',
    metadata: null,
    invoiceEmailRecipients: [],
    netTerms: 30,
    timezone: 'UTC',
    isInternal: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-07-14T00:00:00Z'),
    ...overrides,
  }
}

type Mod = typeof import('../customers')
let mod: Mod

beforeAll(async () => {
  mod = await import('../customers')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  customersFindFirst.mockReset()
  customersUpdate.mockReset()
  // Defaults: an owner caller editing a customer that exists in their org.
  baMemberFindFirst.mockResolvedValue({ role: 'owner' })
  customersFindFirst.mockResolvedValue(dbCustomerRow())
  customersUpdate.mockResolvedValue(dbCustomerRow())
})

describe('updateCustomer — isInternal write path', () => {
  it('persists isInternal: true (customer → internal)', async () => {
    customersUpdate.mockResolvedValue(dbCustomerRow({ isInternal: true }))
    const result = await mod.updateCustomer(CUSTOMER_ID, { isInternal: true })
    expect(result.success).toBe(true)
    expect(customersUpdate).toHaveBeenCalledTimes(1)
    const call = customersUpdate.mock.calls[0][0] as {
      where: { id: string }
      data: { isInternal?: boolean }
    }
    expect(call.where).toEqual({ id: CUSTOMER_ID })
    expect(call.data.isInternal).toBe(true)
  })

  it('persists isInternal: false (internal → customer, the reverse flip)', async () => {
    const result = await mod.updateCustomer(CUSTOMER_ID, { isInternal: false })
    expect(result.success).toBe(true)
    const call = customersUpdate.mock.calls[0][0] as {
      data: { isInternal?: boolean }
    }
    expect(call.data.isInternal).toBe(false)
  })

  it('leaves the column untouched when the payload omits isInternal', async () => {
    const result = await mod.updateCustomer(CUSTOMER_ID, { name: 'Renamed' })
    expect(result.success).toBe(true)
    const call = customersUpdate.mock.calls[0][0] as {
      data: { isInternal?: boolean; name?: string }
    }
    // undefined = Prisma skips the column. A status/name edit can never
    // silently reclassify the record.
    expect(call.data.isInternal).toBeUndefined()
    expect(call.data.name).toBe('Renamed')
  })
})

describe('updateCustomer — the flip is BUILD-gated (finance sees, cannot flip)', () => {
  it('rejects a finance-role caller before any DB write', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    const result = await mod.updateCustomer(CUSTOMER_ID, { isInternal: true })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/owner, admin, or developer roles/i)
    expect(customersUpdate).not.toHaveBeenCalled()
  })

  it('rejects a plain member the same way', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const result = await mod.updateCustomer(CUSTOMER_ID, { isInternal: true })
    expect(result.success).toBe(false)
    expect(customersUpdate).not.toHaveBeenCalled()
  })

  it("rejects a flip on a customer outside the caller's org (IDOR guard intact)", async () => {
    customersFindFirst.mockResolvedValue(null)
    const result = await mod.updateCustomer('someone-elses-customer', {
      isInternal: true,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(customersUpdate).not.toHaveBeenCalled()
  })
})
