/**
 * WHAT THIS FILE DOES: runs the REAL `mapModelAndBackfill` Server Action over
 *   a frozen synthetic event and pins the dollars it produces.
 *
 * WHY IT EXISTS: an admin repairing an unpriced model can walk through this
 *   door or through api-nest's `SignalEventsService.mapModel`. Both must bill
 *   the same. The api-nest side is pinned against this same event in
 *   apps/api-nest/src/modules/signal-events/signal-events-cache-parity.spec.ts.
 *
 * WHY THE GOLDEN IS DUPLICATED, NOT SHARED: the two files live in two jest
 *   projects with two runtimes (NestJS decorators do not compile under the
 *   dashboard's ts-jest), so the doors cannot be executed in one process.
 *   Independent copies of the expectation are the stronger arrangement
 *   anyway — neither test can satisfy itself, and a one-sided edit to either
 *   door turns one of them red.
 *
 * WHAT IS REAL HERE: the Server Action, `calculateEventCost`,
 *   `applyCacheWriteTtl` and `recomputeParentUsageCost` are all the real
 *   artifacts from @marginfront/db. Auth and Prisma are the mocked boundary.
 */

export {}

const ORG = '11111111-1111-4111-8111-111111111111'
const PARENT_ID = '33333333-3333-4333-8333-333333333333'
const CHILD_ID = '44444444-4444-4444-8444-444444444444'
const PRICING_ID = '55555555-5555-4555-8555-555555555555'
const PRICING_EXTERNAL_ID = 'anthropic.claude-opus-5'

// ─── Frozen synthetic event, expected dollars worked out by hand ─────────
// Kept byte-identical to the api-nest twin listed in the header.
const EXPECTED_USAGE_COST_DATA = {
  'claude-opus-5/input': {
    cost: 0.0262,
    units: 5240,
    costPerUnit: 0.000005,
  },
  'claude-opus-5/output': {
    cost: 0.294,
    units: 11760,
    costPerUnit: 0.000025,
  },
  'claude-opus-5/cache_read': {
    cost: 0.0225005,
    units: 45001,
    costPerUnit: 0.0000005,
  },
  'claude-opus-5/cache_write': {
    cost: 19,
    units: 1900000,
    costPerUnit: 0.00001,
  },
}
const EXPECTED_USAGE_COST_EXACT = '19.3427005'
const EXPECTED_USAGE_COST_AS_STORED = '19.342701'

jest.mock('@/app/lib/auth', () => ({
  auth: { api: { getSession: async () => null } },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
jest.mock('../_shared/parse-window-filter', () => ({
  parseWindowFilter: () => ({}),
}))
jest.mock('../_shared/assert-build-manager', () => ({
  assertBuildManager: async () => ({ ok: true, orgId: ORG }),
}))

let pricingRow: Record<string, unknown>
let childRow: Record<string, unknown>
let parentMetadata: Record<string, unknown> | null
const childWrites: { id: string; data: any }[] = []
const parentWrites: { id: string; data: any }[] = []

const tx = {
  service_pricing: { findUnique: async () => pricingRow },
  org_model_mappings: { upsert: async () => ({ id: 'mapping-id' }) },
  signal_event_services: {
    findMany: async (args: any) => {
      // recomputeParentUsageCost re-reads one parent's children.
      if (args.where?.signalEventId && !args.where?.eventStatus) {
        const w = childWrites.find((x) => x.id === CHILD_ID)
        return [
          {
            usageCost: w ? w.data.usageCost : null,
            eventStatus: w ? w.data.eventStatus : 'NEEDS_COST_BACKFILL',
          },
        ]
      }
      return [{ ...childRow, signal_events: { metadata: parentMetadata } }]
    },
    update: async (args: any) => {
      childWrites.push({ id: args.where.id, data: args.data })
      return args.data
    },
  },
  signal_events: {
    update: async (args: any) => {
      parentWrites.push({ id: args.where.id, data: args.data })
      return args.data
    },
    findUnique: async () => ({ usageCost: null, eventProcessed: 'PENDING' }),
  },
}

jest.mock('@/app/lib/db', () => {
  const actual = jest.requireActual('@marginfront/db')
  return {
    db: { $transaction: async (cb: any) => cb(tx) },
    Prisma: actual.Prisma ?? {},
    // The canonical math AND the canonical guard — NOT stubbed. These are the
    // things being pinned; stubbing either would let this door pass a test it
    // fails in production.
    resolveEventPrice: actual.resolveEventPrice,
    calculateEventCost: actual.calculateEventCost,
    applyCacheWriteTtl: actual.applyCacheWriteTtl,
    recomputeParentUsageCost: actual.recomputeParentUsageCost,
  }
})

type Mod = typeof import('../signal-events')
let mod: Mod
let Decimal: typeof import('@prisma/client/runtime/library').Decimal

beforeAll(async () => {
  Decimal = (await import('@prisma/client/runtime/library')).Decimal
  mod = await import('../signal-events')
})

beforeEach(() => {
  childWrites.length = 0
  parentWrites.length = 0
  parentMetadata = null
  pricingRow = {
    id: PRICING_ID,
    externalId: PRICING_EXTERNAL_ID,
    canonicalName: 'claude-opus-5',
    provider: 'anthropic',
    inputCost: new Decimal('5.0000000000'),
    outputCost: new Decimal('25.0000000000'),
    cacheReadCost: new Decimal('0.5000000000'),
    cacheWriteCost: new Decimal('10.0000000000'),
    costUnit: '1M tokens',
  }
  childRow = {
    id: CHILD_ID,
    signalEventId: PARENT_ID,
    model: 'claude-opus-5',
    modelProvider: 'anthropic',
    inputTokens: 5240,
    outputTokens: 11760,
    quantity: null,
    cacheReadTokens: 45001,
    cacheWriteTokens: 1900000,
  }
})

async function remap() {
  return mod.mapModelAndBackfill(
    'claude-opus-5',
    'anthropic',
    PRICING_EXTERNAL_ID
  )
}

describe('mapModelAndBackfill — the dashboard door, same event', () => {
  it('reproduces the hand-worked usageCost for that event', async () => {
    const res = await remap()
    expect(res.success).toBe(true)

    expect(childWrites).toHaveLength(1)
    const usageCost = childWrites[0].data.usageCost
    expect(usageCost.toString()).toBe(EXPECTED_USAGE_COST_EXACT)
    expect(usageCost.toFixed(6)).toBe(EXPECTED_USAGE_COST_AS_STORED)
  })

  it('reproduces the hand-worked usageCostData for that event', async () => {
    await remap()
    expect(childWrites[0].data.usageCostData).toEqual(EXPECTED_USAGE_COST_DATA)
  })

  it('rolls the cache-inclusive total up to the parent', async () => {
    await remap()
    expect(parentWrites).toHaveLength(1)
    expect(parentWrites[0].data.eventProcessed).toBe('PROCESSED')
    expect(parentWrites[0].data.usageCost.toFixed(6)).toBe(
      EXPECTED_USAGE_COST_AS_STORED
    )
  })

  it('prices a 5m Anthropic cache write at 1.25x input, not the 2x ceiling', async () => {
    parentMetadata = { cacheWriteTtl: '5m' }
    await remap()

    const line = childWrites[0].data.usageCostData['claude-opus-5/cache_write']
    expect(line.costPerUnit).toBeCloseTo(0.00000625, 12)
    expect(line.cost).toBeCloseTo(1900000 * 0.00000625, 8)
  })

  it('NEGATIVE CONTROL: a 1h hint keeps the stored 2x ceiling', async () => {
    parentMetadata = { cacheWriteTtl: '1h' }
    await remap()
    expect(childWrites[0].data.usageCostData).toEqual(EXPECTED_USAGE_COST_DATA)
  })

  it('NEGATIVE CONTROL: NULL cache columns produce NO cache lines', async () => {
    childRow.cacheReadTokens = null
    childRow.cacheWriteTokens = null
    await remap()

    expect(childWrites[0].data.usageCostData).toEqual({
      'claude-opus-5/input': {
        cost: 0.0262,
        units: 5240,
        costPerUnit: 0.000005,
      },
      'claude-opus-5/output': {
        cost: 0.294,
        units: 11760,
        costPerUnit: 0.000025,
      },
    })
    expect(childWrites[0].data.usageCost.toString()).toBe('0.3202')
  })
})

// ─── The guard, on this door ─────────────────────────────────────────────
//
// Case-for-case identical to the api-nest twin's refusal block. The two doors
// must not only price the same, they must REFUSE the same.

describe('mapModelAndBackfill refuses rather than under-bill on a missing cache rate', () => {
  beforeEach(() => {
    pricingRow.cacheWriteCost = null
  })

  it('writes NOTHING for the refused child — no cost, no PROCESSED stamp', async () => {
    await remap()
    expect(childWrites).toHaveLength(0)
    expect(parentWrites).toHaveLength(0)
  })

  it('emits NO fabricated $0.00 cache_write line anywhere', async () => {
    await remap()
    const everyLine = childWrites.flatMap((w) =>
      Object.keys(w.data.usageCostData as Record<string, unknown>)
    )
    expect(everyLine.filter((k) => k.endsWith('/cache_write'))).toEqual([])
  })

  it('reports the refusal on the result, and counts it as NOT backfilled', async () => {
    const res = await remap()
    expect(res.success).toBe(true)
    expect(res.data?.refused).toBe(1)
    expect(res.data?.refusedRates).toEqual(['cacheWriteCost'])
    expect(res.data?.backfilled).toBe(0)
    expect(res.data?.totalCostUsd).toBe(0)
  })

  it('names BOTH directions when the row prices neither', async () => {
    pricingRow.cacheReadCost = null
    const res = await remap()
    expect(res.data?.refusedRates).toEqual(['cacheReadCost', 'cacheWriteCost'])
  })

  it('PRICED-ZERO TWIN: a genuine $0.00 cache rate prices and is NOT refused', async () => {
    pricingRow.cacheWriteCost = new Decimal('0')
    const res = await remap()

    expect(res.data?.refused).toBe(0)
    expect(childWrites).toHaveLength(1)
    expect(
      childWrites[0].data.usageCostData['claude-opus-5/cache_write']
    ).toEqual({ cost: 0, units: 1900000, costPerUnit: 0 })
    expect(childWrites[0].data.usageCost.toString()).toBe('0.3427005')
  })

  it('NEGATIVE CONTROL: a NULL cache rate the event never used does not refuse', async () => {
    childRow.cacheReadTokens = null
    childRow.cacheWriteTokens = null
    const res = await remap()

    expect(res.data?.refused).toBe(0)
    expect(childWrites[0].data.usageCost.toString()).toBe('0.3202')
  })

  it('NEGATIVE CONTROL: a non-token cost unit never refuses on a NULL cache rate', async () => {
    pricingRow.canonicalName = 'websearch'
    pricingRow.provider = 'tool'
    pricingRow.inputCost = new Decimal('10.0000000000')
    pricingRow.outputCost = new Decimal('0')
    pricingRow.cacheReadCost = null
    pricingRow.costUnit = '1K calls'
    childRow.model = 'WebSearch'
    childRow.modelProvider = 'tool'
    childRow.inputTokens = null
    childRow.outputTokens = null
    childRow.quantity = new Decimal(88)

    const res = await mod.mapModelAndBackfill(
      'websearch',
      'tool',
      PRICING_EXTERNAL_ID
    )

    expect(res.data?.refused).toBe(0)
    expect(childWrites[0].data.usageCost.toString()).toBe('0.88')
  })
})
