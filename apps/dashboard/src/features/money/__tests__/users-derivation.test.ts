import {
  countUsersTabCustomers,
  filterUsersTabCustomers,
  partitionUsersTabCustomers,
  type UsersTabCustomer,
} from '../users-derivation'

/**
 * The Money → Users tab's filter logic. Real
 * assertions against hand-built fixtures (2 internal seats, 3 real
 * customers), mirroring internal-partition.test.ts's fixture style since
 * this module wraps that primitive for a flat customer list rather than
 * breakdown rows.
 */

const INTERNAL_1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const INTERNAL_2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const CUSTOMER_1 = 'cccccccc-0000-0000-0000-000000000003'
const CUSTOMER_2 = 'cccccccc-0000-0000-0000-000000000004'
const CUSTOMER_3 = 'cccccccc-0000-0000-0000-000000000005'

const CUSTOMERS: UsersTabCustomer[] = [
  {
    id: INTERNAL_1,
    name: 'Ada (internal test seat)',
    email: 'ada@internal.example',
    externalId: '',
    status: 'active',
    isInternal: true,
    defaultGlCodeId: 'gl-7100-internal-ai',
  },
  {
    id: CUSTOMER_1,
    name: 'Acme Corp',
    email: 'billing@acme.example',
    externalId: 'acme-1',
    status: 'active',
    isInternal: false,
    defaultGlCodeId: null,
  },
  {
    id: INTERNAL_2,
    name: 'Grace (Internal sandbox)',
    email: 'grace@internal.example',
    externalId: '',
    status: 'inactive',
    isInternal: true,
    defaultGlCodeId: null,
  },
  {
    id: CUSTOMER_2,
    name: 'Beta LLC',
    email: 'ap@beta.example',
    externalId: 'beta-2',
    status: 'active',
    isInternal: false,
    defaultGlCodeId: null,
  },
  {
    id: CUSTOMER_3,
    name: 'Suspended Co',
    email: 'ops@suspended.example',
    externalId: 'susp-3',
    status: 'suspended',
    isInternal: false,
    defaultGlCodeId: null,
  },
]

describe('partitionUsersTabCustomers', () => {
  it('routes internal seats and real customers into their own buckets', () => {
    const { internal, external } = partitionUsersTabCustomers(CUSTOMERS)
    expect(internal.map((c) => c.id).sort()).toEqual(
      [INTERNAL_1, INTERNAL_2].sort()
    )
    expect(external.map((c) => c.id).sort()).toEqual(
      [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3].sort()
    )
  })

  it('partitions exactly — every customer lands in one bucket, none dropped', () => {
    const { internal, external } = partitionUsersTabCustomers(CUSTOMERS)
    expect(internal.length + external.length).toBe(CUSTOMERS.length)
  })
})

describe('countUsersTabCustomers', () => {
  it('agrees with the partition — the three counts can never disagree with the filtered lists', () => {
    const counts = countUsersTabCustomers(CUSTOMERS)
    expect(counts).toEqual({ all: 5, external: 3, internal: 2 })
  })
})

describe('filterUsersTabCustomers', () => {
  it("'all' returns every customer, order preserved", () => {
    expect(filterUsersTabCustomers(CUSTOMERS, 'all').map((c) => c.id)).toEqual(
      CUSTOMERS.map((c) => c.id)
    )
  })

  it("'internal' returns ONLY the isInternal-flagged customers", () => {
    const rows = filterUsersTabCustomers(CUSTOMERS, 'internal')
    expect(rows.map((c) => c.id).sort()).toEqual(
      [INTERNAL_1, INTERNAL_2].sort()
    )
    expect(rows.every((c) => c.isInternal)).toBe(true)
  })

  it("'external' returns ONLY real customers, never an internal seat", () => {
    const rows = filterUsersTabCustomers(CUSTOMERS, 'external')
    expect(rows.map((c) => c.id).sort()).toEqual(
      [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3].sort()
    )
    expect(rows.every((c) => !c.isInternal)).toBe(true)
  })

  it('carries each internal customer default GL through unchanged (no second lookup)', () => {
    const rows = filterUsersTabCustomers(CUSTOMERS, 'internal')
    const ada = rows.find((c) => c.id === INTERNAL_1)
    const grace = rows.find((c) => c.id === INTERNAL_2)
    expect(ada?.defaultGlCodeId).toBe('gl-7100-internal-ai')
    expect(grace?.defaultGlCodeId).toBeNull()
  })
})

/**
 * The flip is a live flag: the partition re-derives from
 * isInternal alone, so a flipped record moves buckets (and the counts
 * follow) with no other state to update.
 */
describe('flipping isInternal moves the record between buckets', () => {
  it('customer → internal: the record leaves External, joins Internal, counts follow', () => {
    const flipped = CUSTOMERS.map((c) =>
      c.id === CUSTOMER_1 ? { ...c, isInternal: true } : c
    )
    expect(countUsersTabCustomers(flipped)).toEqual({
      all: 5,
      external: 2,
      internal: 3,
    })
    expect(
      filterUsersTabCustomers(flipped, 'internal').map((c) => c.id)
    ).toContain(CUSTOMER_1)
    expect(
      filterUsersTabCustomers(flipped, 'external').map((c) => c.id)
    ).not.toContain(CUSTOMER_1)
  })

  it('internal → customer: the reverse flip re-buckets the same way', () => {
    const flipped = CUSTOMERS.map((c) =>
      c.id === INTERNAL_1 ? { ...c, isInternal: false } : c
    )
    expect(countUsersTabCustomers(flipped)).toEqual({
      all: 5,
      external: 4,
      internal: 1,
    })
    expect(
      filterUsersTabCustomers(flipped, 'external').map((c) => c.id)
    ).toContain(INTERNAL_1)
    expect(
      filterUsersTabCustomers(flipped, 'internal').map((c) => c.id)
    ).not.toContain(INTERNAL_1)
  })

  it('a flip never drops or duplicates a record — total stays exact', () => {
    const flipped = CUSTOMERS.map((c) =>
      c.id === CUSTOMER_1 ? { ...c, isInternal: true } : c
    )
    const { internal, external } = partitionUsersTabCustomers(flipped)
    expect(internal.length + external.length).toBe(CUSTOMERS.length)
  })
})
