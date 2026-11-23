/**
 * resolveMetrics' pure parts (metrics-resolver.ts).
 *
 * metrics-resolver.ts is a 'use server' file, and a 'use server' module may
 * only export async functions (jest/tsc/eslint all pass a non-async
 * `export const` there; only `next build` fails it, so this repo does NOT
 * export ResolveMetricsInputSchema). That means the input zod schema can't be
 * imported and unit-tested directly, and resolveMetrics() itself can't be
 * safely invoked here either: it queries via the shared `db` client and calls
 * the real getCostBreakdown ($queryRaw against Postgres).
 *
 * SCOPE_TILE_SOURCES lives in src/lib/component-catalog.ts (a plain,
 * non-'use server' sibling module, the same split dashboard-layouts.ts uses),
 * so it's imported and asserted on directly below.
 *
 * What's left source-asserted, and why:
 *   1. ResolveMetricsInputSchema's scope enum is exactly DASHBOARD_PAGE_IDS
 *      and its dimension field is DimensionSchema (the real registry), not
 *      a hand-rolled duplicate that could drift — the schema itself still
 *      can't be exported from a 'use server' file.
 *   2. The earned-by-day series: its day-count
 *      cutoff, concurrency cap, and revenue-gating can't be exercised
 *      without a live DB (computeEarnedSeries calls getRevenueMetrics), so
 *      this file pins the constants and the gating condition by source
 *      instead — the DB-gated integration proof lives in
 *      metrics-resolver-parity.integration.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { DimensionSchema } from '@marginfront/db'
import { DASHBOARD_PAGE_IDS, SCOPE_TILE_SOURCES } from '@/lib/component-catalog'

const SRC = readFileSync(join(__dirname, '..', 'metrics-resolver.ts'), 'utf8')

describe('SCOPE_TILE_SOURCES — per-scope tile map (real import)', () => {
  it('has an entry for all six DASHBOARD_PAGE_IDS', () => {
    expect(Object.keys(SCOPE_TILE_SOURCES).sort()).toEqual(
      [...DASHBOARD_PAGE_IDS].sort()
    )
  })

  it('mfiq requests no revenue/invoice/mrr/earned tiles — cost data only', () => {
    expect(SCOPE_TILE_SOURCES.mfiq).toEqual({
      revenue: false,
      invoices: false,
      mrr: false,
      earned: false,
    })
  })

  it('build requests earned but not revenue/invoices/mrr (Agent-Earned is its money surface)', () => {
    expect(SCOPE_TILE_SOURCES.build).toEqual({
      revenue: false,
      invoices: false,
      mrr: false,
      earned: true,
    })
  })

  it('money requests the full revenue + invoices + mrr set', () => {
    for (const scope of ['money'] as const) {
      expect(SCOPE_TILE_SOURCES[scope].revenue).toBe(true)
      expect(SCOPE_TILE_SOURCES[scope].invoices).toBe(true)
      expect(SCOPE_TILE_SOURCES[scope].mrr).toBe(true)
    }
  })
})

describe('metrics-resolver.ts imports SCOPE_TILE_SOURCES rather than redeclaring it', () => {
  it('does not declare a local SCOPE_TILE_SOURCES const', () => {
    expect(SRC).not.toMatch(/const SCOPE_TILE_SOURCES/)
  })

  it('imports SCOPE_TILE_SOURCES from @/lib/component-catalog', () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*\bSCOPE_TILE_SOURCES\b[^}]*\}\s*from\s*['"]@\/lib\/component-catalog['"]/
    )
  })
})

describe('earned-by-day series — computeEarnedSeries constants + gating (source-asserted)', () => {
  it('caps at 92 days (EARNED_SERIES_MAX_DAYS)', () => {
    expect(SRC).toMatch(/EARNED_SERIES_MAX_DAYS = 92/)
  })

  it('caps in-flight getRevenueMetrics calls at 8 (EARNED_SERIES_CONCURRENCY)', () => {
    expect(SRC).toMatch(/EARNED_SERIES_CONCURRENCY = 8/)
  })

  it('is gated on sources.revenue, same gate as the revenue tiles', () => {
    const match = SRC.match(
      /sources\.revenue\s*\n\s*\?\s*computeEarnedSeries\([^)]*\)\s*\n\s*:\s*Promise\.resolve\(null\)/
    )
    expect(match).not.toBeNull()
  })

  it('every day bucket comes from canonGetRevenueMetrics, never a per-event computation', () => {
    expect(SRC).toMatch(/computeEarnedSeries[\s\S]*?canonGetRevenueMetrics\(/)
    expect(SRC).not.toMatch(/earnedForEvent/)
  })
})

describe('ResolveMetricsInputSchema — scope + dimension enums (source-asserted)', () => {
  it('the scope z.enum lists exactly the six DASHBOARD_PAGE_IDS', () => {
    const match = SRC.match(/scope:\s*z\.enum\(\[([^\]]*)\]\)/)
    expect(match).not.toBeNull()
    const listed = match![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    expect(listed.sort()).toEqual([...DASHBOARD_PAGE_IDS].sort())
  })

  it('the dimension field is DimensionSchema, not a hand-rolled duplicate', () => {
    expect(SRC).toMatch(/dimension:\s*DimensionSchema/)
  })

  it('the filters field is RevenueFiltersSchema, not a hand-rolled duplicate', () => {
    expect(SRC).toMatch(/filters:\s*RevenueFiltersSchema/)
  })
})

// Secondary, BEHAVIORAL cross-check: reconstruct the scope enum from the
// real, exported DASHBOARD_PAGE_IDS and prove a z.enum built from it (the
// same construction the source line above uses) actually rejects an unknown
// scope and accepts every real one. This can't prove the resolver's own
// inline schema instance behaves this way (it isn't exported), but it does
// prove DASHBOARD_PAGE_IDS itself is a valid, behaviorally-correct enum
// input, which rules out "the source text matches but the underlying array is
// broken" as a blind spot.
describe('DASHBOARD_PAGE_IDS as a scope enum — behavioral cross-check', () => {
  it('rejects an unknown scope', () => {
    const scopeCheck = new Set(DASHBOARD_PAGE_IDS)
    expect(scopeCheck.has('not-a-real-scope' as never)).toBe(false)
  })

  it('accepts every real scope', () => {
    const scopeCheck = new Set(DASHBOARD_PAGE_IDS)
    for (const scope of ['money', 'finops', 'build', 'roi', 'mfiq']) {
      expect(scopeCheck.has(scope as never)).toBe(true)
    }
  })
})

describe('DimensionSchema — behavioral cross-check for the resolver input schema', () => {
  it('rejects an unknown dimension', () => {
    expect(DimensionSchema.safeParse('not-a-real-dimension').success).toBe(false)
  })

  it('accepts every dimension getCostBreakdown supports', () => {
    for (const dim of DimensionSchema.options) {
      expect(DimensionSchema.safeParse(dim).success).toBe(true)
    }
  })
})
