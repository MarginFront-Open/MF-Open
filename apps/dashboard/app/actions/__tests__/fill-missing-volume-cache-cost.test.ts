/**
 * WHAT THIS FILE DOES: Proves the OUTCOME of `fillMissingVolume` — the second
 *   repair door on the "needs attention" screen — on a fully mocked db. It
 *   asserts the dollar amount actually written to the child row.
 * WHY IT EXISTS: A child can already carry cacheReadTokens /
 *   cacheWriteTokens when its volume is filled. If the action reads only
 *   id/signalEventId/model/modelProvider off the child, that spend is
 *   DROPPED at fill time and the row is still stamped PROCESSED. The tokens
 *   and the rates are both on hand, so the written cost must include them.
 * CONNECTS TO: packages/db/src/lib/model-pricing.ts (resolveEventPrice, the
 *   canonical guard) and ../signal-events.ts (the action).
 */

export {}

const ORG = 'org-real-build'
const USER = 'user-build'

// A claude-opus-5 / anthropic child waiting for its volume. Cache spend dwarfs
// the prompt spend, which is exactly why dropping it matters.
const CHILD_CACHE_READ_TOKENS = 1_306_052
const CHILD_CACHE_WRITE_TOKENS = 26_907

// The published service_pricing row for claude-opus-5 / anthropic.
const CLAUDE_OPUS_5_ROW = {
  id: 'sp-claude-opus-5',
  canonicalName: 'claude-opus-5',
  provider: 'anthropic',
  inputCost: 5,
  outputCost: 25,
  cacheReadCost: 0.5,
  cacheWriteCost: 10,
  costUnit: '1M tokens',
}

// Same model, but the row carries no cache-write rate, like most
// "1M tokens" rows in the price catalog.
const NULL_CACHE_WRITE_ROW = {
  ...CLAUDE_OPUS_5_ROW,
  id: 'sp-null-cache-write',
  cacheWriteCost: null,
}

// A genuinely FREE cache write. A stored 0 is a price and must fill normally.
const PRICED_ZERO_WRITE_ROW = {
  ...CLAUDE_OPUS_5_ROW,
  id: 'sp-priced-zero-write',
  cacheWriteCost: 0,
}

// anthropic-web-search / anthropic, a real "1K requests" row. Every non-token
// catalog row has NULL cache rates, and cache is inert in that math branch.
const NON_TOKEN_ROW = {
  id: 'sp-anthropic-web-search',
  canonicalName: 'anthropic-web-search',
  provider: 'anthropic',
  inputCost: 10,
  outputCost: null,
  cacheReadCost: null,
  cacheWriteCost: null,
  costUnit: '1K requests',
}

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
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
jest.mock('../_shared/assert-build-manager', () => ({
  assertBuildManager: async () => ({ ok: true, orgId: ORG }),
}))

const servicePricingFindFirst = jest.fn()
const childrenFindMany = jest.fn()
const childUpdate = jest.fn()
const recomputeParentUsageCost = jest.fn()

jest.mock('@/app/lib/db', () => {
  const real = jest.requireActual('@marginfront/db')
  const tx = {
    service_pricing: { findFirst: (a: unknown) => servicePricingFindFirst(a) },
    signal_event_services: {
      findMany: (a: unknown) => childrenFindMany(a),
      update: (a: unknown) => childUpdate(a),
    },
  }
  return {
    db: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
    Prisma: real.Prisma,
    calculateEventCost: real.calculateEventCost,
    resolveEventPrice: real.resolveEventPrice,
    applyCacheWriteTtl: real.applyCacheWriteTtl,
    recomputeParentUsageCost: (...a: unknown[]) =>
      recomputeParentUsageCost(...a),
  }
})

type SignalEvents = typeof import('../signal-events')
let signalEvents: SignalEvents

beforeAll(async () => {
  signalEvents = await import('../signal-events')
})

beforeEach(() => {
  jest.clearAllMocks()
  childUpdate.mockResolvedValue({})
  recomputeParentUsageCost.mockResolvedValue(undefined)
})

function childRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'child-1',
    signalEventId: 'event-1',
    model: 'claude-opus-5',
    modelProvider: 'anthropic',
    cacheReadTokens: CHILD_CACHE_READ_TOKENS,
    cacheWriteTokens: CHILD_CACHE_WRITE_TOKENS,
    signal_events: { metadata: null },
    ...overrides,
  }
}

const writtenCost = () => Number(childUpdate.mock.calls[0][0].data.usageCost)
const writtenStatus = () => childUpdate.mock.calls[0][0].data.eventStatus

describe('filling volume must not drop the cache spend already on the child', () => {
  it('prices the cache tokens the child was already carrying', async () => {
    servicePricingFindFirst.mockResolvedValue(CLAUDE_OPUS_5_ROW)
    childrenFindMany.mockResolvedValue([childRow()])

    const result = await signalEvents.fillMissingVolume(
      'claude-opus-5',
      'anthropic',
      1000,
      2000
    )

    expect(result.success).toBe(true)
    // input 1,000 x $5/1M            = $0.005
    // output 2,000 x $25/1M          = $0.05
    // cacheRead 1,306,052 x $0.5/1M  = $0.653026
    // cacheWrite 26,907 x $10/1M     = $0.26907
    //                                 ---------
    //                                  $0.977096
    expect(writtenCost()).toBeCloseTo(0.977096, 9)
    expect(writtenStatus()).toBe('PROCESSED')
    expect(result.data?.totalCostUsd).toBeCloseTo(0.977096, 9)
    // Prompt spend only would be $0.055, 94% of the bill missing.
    expect(writtenCost()).not.toBeCloseTo(0.055, 9)
  })

  it('emits the cache lines in the cost-by-service breakdown', async () => {
    servicePricingFindFirst.mockResolvedValue(CLAUDE_OPUS_5_ROW)
    childrenFindMany.mockResolvedValue([childRow()])

    await signalEvents.fillMissingVolume(
      'claude-opus-5',
      'anthropic',
      1000,
      2000
    )

    const data = childUpdate.mock.calls[0][0].data.usageCostData
    expect(data['claude-opus-5/cache_read'].units).toBe(CHILD_CACHE_READ_TOKENS)
    expect(data['claude-opus-5/cache_read'].cost).toBeCloseTo(0.653026, 9)
    expect(data['claude-opus-5/cache_write'].units).toBe(
      CHILD_CACHE_WRITE_TOKENS
    )
    expect(data['claude-opus-5/cache_write'].cost).toBeCloseTo(0.26907, 9)
  })

  it('selects the cache columns and the TTL hint off the child', async () => {
    servicePricingFindFirst.mockResolvedValue(CLAUDE_OPUS_5_ROW)
    childrenFindMany.mockResolvedValue([])

    await signalEvents.fillMissingVolume('claude-opus-5', 'anthropic', 1, 1)

    const select = childrenFindMany.mock.calls[0][0].select
    expect(select.cacheReadTokens).toBe(true)
    expect(select.cacheWriteTokens).toBe(true)
    expect(select.signal_events).toEqual({ select: { metadata: true } })
  })

  it('re-bases a 5m cache write through the same TTL rule as ingest', async () => {
    servicePricingFindFirst.mockResolvedValue(CLAUDE_OPUS_5_ROW)
    childrenFindMany.mockResolvedValue([
      childRow({
        cacheReadTokens: 0,
        signal_events: { metadata: { cacheWriteTtl: '5m' } },
      }),
    ])

    await signalEvents.fillMissingVolume('claude-opus-5', 'anthropic', 0, 0)

    // 5m writes bill at 1.25x input ($6.25/1M), not the stored 2x ceiling.
    expect(writtenCost()).toBeCloseTo((26_907 * 6.25) / 1_000_000, 9)
  })
})

describe('a missing cache rate is refused, not filled at $0', () => {
  it('leaves the child unresolved instead of stamping PROCESSED', async () => {
    servicePricingFindFirst.mockResolvedValue(NULL_CACHE_WRITE_ROW)
    childrenFindMany.mockResolvedValue([childRow()])

    const result = await signalEvents.fillMissingVolume(
      'claude-opus-5',
      'anthropic',
      1000,
      2000
    )

    expect(result.success).toBe(true)
    expect(childUpdate).not.toHaveBeenCalled()
    expect(result.data?.backfilled).toBe(0)
    expect(result.data?.refused).toBe(1)
    expect(result.data?.refusedRates).toEqual(['cacheWriteCost'])
    expect(result.data?.totalCostUsd).toBe(0)
  })

  it('fills the priced children and refuses only the cache-bearing one', async () => {
    servicePricingFindFirst.mockResolvedValue(NULL_CACHE_WRITE_ROW)
    childrenFindMany.mockResolvedValue([
      childRow({ id: 'no-cache', cacheReadTokens: 0, cacheWriteTokens: 0 }),
      childRow({ id: 'has-cache' }),
    ])

    const result = await signalEvents.fillMissingVolume(
      'claude-opus-5',
      'anthropic',
      1000,
      2000
    )

    expect(childUpdate).toHaveBeenCalledTimes(1)
    expect(childUpdate.mock.calls[0][0].where).toEqual({ id: 'no-cache' })
    expect(result.data?.backfilled).toBe(1)
    expect(result.data?.refused).toBe(1)
  })
})

describe('priced-zero and non-token rows', () => {
  it('a genuine $0 cache-write rate fills at $0 for that term, never refuses', async () => {
    servicePricingFindFirst.mockResolvedValue(PRICED_ZERO_WRITE_ROW)
    childrenFindMany.mockResolvedValue([childRow()])

    const result = await signalEvents.fillMissingVolume(
      'claude-opus-5',
      'anthropic',
      1000,
      2000
    )

    expect(result.data?.refused).toBe(0)
    // Everything but the free cache write: 0.005 + 0.05 + 0.653026
    expect(writtenCost()).toBeCloseTo(0.708026, 9)
    expect(
      childUpdate.mock.calls[0][0].data.usageCostData[
        'claude-opus-5/cache_write'
      ].cost
    ).toBe(0)
  })

  it('a NON-token row with cache tokens on the child fills on quantity alone', async () => {
    servicePricingFindFirst.mockResolvedValue(NON_TOKEN_ROW)
    childrenFindMany.mockResolvedValue([
      childRow({ model: 'anthropic-web-search' }),
    ])

    const result = await signalEvents.fillMissingVolume(
      'anthropic-web-search',
      'anthropic',
      undefined,
      undefined,
      250
    )

    expect(result.success).toBe(true)
    expect(result.data?.refused).toBe(0)
    // 250 requests x $10 per 1K = $2.50. Cache is inert in this branch.
    expect(writtenCost()).toBeCloseTo(2.5, 9)
    expect(writtenStatus()).toBe('PROCESSED')
  })
})
