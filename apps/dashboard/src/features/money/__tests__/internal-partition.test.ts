/**
 * Proves the internal/external partition splits
 * the first-class "Internal" bucket out WITHOUT folding it into "Other" or
 * losing a row. Hand-built fixtures: 2 internal seats, 2 real customers, plus
 * the null-key "no customer" row. Node-only (no RTL) — pure derivation.
 */

import {
  buildInternalCustomerMeta,
  partitionCustomerRowsByInternal,
  sumCostByInternalPartition,
} from '../internal-partition'

const INTERNAL_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const INTERNAL_B = 'aaaaaaaa-0000-0000-0000-000000000002'
const CUSTOMER_X = 'cccccccc-0000-0000-0000-000000000003'
const CUSTOMER_Y = 'cccccccc-0000-0000-0000-000000000004'

const customers = [
  { id: INTERNAL_A, isInternal: true, defaultGlCodeId: 'gl-7100-internal-ai' },
  { id: INTERNAL_B, isInternal: true, defaultGlCodeId: null },
  { id: CUSTOMER_X, isInternal: false, defaultGlCodeId: null },
  { id: CUSTOMER_Y, isInternal: false, defaultGlCodeId: null },
]

interface Row {
  key: string | null
  cost: number
  eventCount: number
}

const rows: Row[] = [
  { key: INTERNAL_A, cost: 40, eventCount: 4 },
  { key: CUSTOMER_X, cost: 100, eventCount: 10 },
  { key: INTERNAL_B, cost: 25, eventCount: 2 },
  { key: CUSTOMER_Y, cost: 60, eventCount: 6 },
  { key: null, cost: 5, eventCount: 1 }, // events with no customer
]

describe('partitionCustomerRowsByInternal', () => {
  const meta = buildInternalCustomerMeta(customers)
  const { internal, external } = partitionCustomerRowsByInternal(rows, meta)

  it('routes flagged customers into the Internal bucket', () => {
    expect(internal.map((r) => r.key).sort()).toEqual(
      [INTERNAL_A, INTERNAL_B].sort()
    )
  })

  it('routes real customers into the External bucket', () => {
    expect(external.map((r) => r.key)).toContain(CUSTOMER_X)
    expect(external.map((r) => r.key)).toContain(CUSTOMER_Y)
  })

  it('treats the null-key "no customer" row as external, not internal', () => {
    expect(external.some((r) => r.key === null)).toBe(true)
    expect(internal.some((r) => r.key === null)).toBe(false)
  })

  it('partitions exactly — every row lands in exactly one bucket, none dropped', () => {
    expect(internal.length + external.length).toBe(rows.length)
    const seen = new Set([...internal, ...external])
    expect(seen.size).toBe(rows.length)
  })

  it('preserves the cost invariant — Internal is NOT folded into Other', () => {
    const sum = (rs: Row[]) => rs.reduce((acc, r) => acc + r.cost, 0)
    expect(sum(internal) + sum(external)).toBe(sum(rows))
    expect(sum(internal)).toBe(65) // 40 + 25
    expect(sum(external)).toBe(165) // 100 + 60 + 5
  })

  it('carries each internal customer default GL through the meta map', () => {
    expect(meta.get(INTERNAL_A)?.defaultGlCodeId).toBe('gl-7100-internal-ai')
    expect(meta.get(INTERNAL_B)?.defaultGlCodeId).toBeNull()
    expect(meta.get(CUSTOMER_X)?.isInternal).toBe(false)
  })
})

describe('sumCostByInternalPartition', () => {
  const meta = buildInternalCustomerMeta(customers)

  it('totals each side of the partition from the same rows', () => {
    const { internal, external } = sumCostByInternalPartition(rows, meta)
    expect(internal).toBe(65) // 40 + 25
    expect(external).toBe(165) // 100 + 60 + 5 (null-key is external)
  })

  it('internal + external === total window cost (the two ROI actuals add back up)', () => {
    const total = rows.reduce((acc, r) => acc + r.cost, 0)
    const { internal, external } = sumCostByInternalPartition(rows, meta)
    expect(internal + external).toBe(total)
  })

  it('an all-external org puts every dollar in external, zero internal', () => {
    const externalOnly = buildInternalCustomerMeta([
      { id: CUSTOMER_X, isInternal: false, defaultGlCodeId: null },
      { id: CUSTOMER_Y, isInternal: false, defaultGlCodeId: null },
    ])
    const { internal, external } = sumCostByInternalPartition(
      [
        { key: CUSTOMER_X, cost: 100 },
        { key: CUSTOMER_Y, cost: 60 },
      ],
      externalOnly
    )
    expect(internal).toBe(0)
    expect(external).toBe(160)
  })
})
