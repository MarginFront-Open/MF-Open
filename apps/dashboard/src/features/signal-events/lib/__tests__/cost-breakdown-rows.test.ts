/**
 * The Cost Breakdown table must never drop a
 * quantity-priced (non-token) service row just because it has no numeric
 * `units` in usageCostData. sdk.service.ts writes the "<model>/input" and
 * "<model>/output" keys unconditionally for every service, LLM or not —
 * request-priced services (e.g. anthropic-web-search) never get
 * inputTokens/outputTokens, so their stored `units` is undefined forever
 * on historical rows.
 */

import { buildCostBreakdownRows } from '../cost-breakdown-rows'

describe('buildCostBreakdownRows', () => {
  it('renders a token row unchanged (numeric units already present)', () => {
    const rows = buildCostBreakdownRows(
      {
        'claude-4-sonnet-20250514/input': {
          cost: 3,
          units: 1_000_000,
          costPerUnit: 0.000003,
        },
        'claude-4-sonnet-20250514/output': {
          cost: 3,
          units: 200_000,
          costPerUnit: 0.000015,
        },
      },
      [
        {
          model: 'claude-4-sonnet-20250514',
          quantity: null,
        },
      ]
    )

    expect(rows).toEqual([
      { key: 'claude-4-sonnet-20250514/input', cost: 3, units: 1_000_000 },
      { key: 'claude-4-sonnet-20250514/output', cost: 3, units: 200_000 },
    ])
  })

  it('renders a quantity row: no units in usageCostData, falls back to the matching service quantity', () => {
    const rows = buildCostBreakdownRows(
      {
        'anthropic-web-search/input': { cost: 10, costPerUnit: 0.01 },
        'anthropic-web-search/output': { cost: 0, costPerUnit: 0 },
      },
      [{ model: 'anthropic-web-search', quantity: 1000 }]
    )

    expect(rows).toEqual([
      { key: 'anthropic-web-search/input', cost: 10, units: 1000 },
      { key: 'anthropic-web-search/output', cost: 0, units: 1000 },
    ])
  })

  it('renders a bare-cost row as "—" (no units, no matching service quantity) instead of dropping it', () => {
    const rows = buildCostBreakdownRows(
      { 'anthropic-web-search/input': { cost: 5, costPerUnit: 0.01 } },
      []
    )

    expect(rows).toEqual([
      { key: 'anthropic-web-search/input', cost: 5, units: null },
    ])
  })

  it('still skips malformed entries lacking a numeric cost', () => {
    const rows = buildCostBreakdownRows(
      {
        weird: 'not an object',
        alsoWeird: { units: 5 },
      },
      []
    )

    expect(rows).toEqual([])
  })

  it('returns [] when usageCostData is null', () => {
    expect(buildCostBreakdownRows(null, [])).toEqual([])
  })

  it('multi-service: sonnet ($6 total) and web-search ($10 total) both render', () => {
    const rows = buildCostBreakdownRows(
      {
        'claude-4-sonnet-20250514/input': { cost: 3, units: 1_000_000 },
        'claude-4-sonnet-20250514/output': { cost: 3, units: 200_000 },
        'anthropic-web-search/input': { cost: 10 },
        'anthropic-web-search/output': { cost: 0 },
      },
      [
        { model: 'claude-4-sonnet-20250514', quantity: null },
        { model: 'anthropic-web-search', quantity: 1000 },
      ]
    )

    const sonnetTotal = rows
      .filter((r) => r.key.startsWith('claude-4-sonnet-20250514/'))
      .reduce((sum, r) => sum + r.cost, 0)
    const webSearchTotal = rows
      .filter((r) => r.key.startsWith('anthropic-web-search/'))
      .reduce((sum, r) => sum + r.cost, 0)

    expect(sonnetTotal).toBe(6)
    expect(webSearchTotal).toBe(10)
  })

  it('single-service: web-search $5 line renders', () => {
    const rows = buildCostBreakdownRows(
      {
        'anthropic-web-search/input': { cost: 5 },
        'anthropic-web-search/output': { cost: 0 },
      },
      [{ model: 'anthropic-web-search', quantity: 500 }]
    )

    expect(rows.some((r) => r.cost === 5 && r.units === 500)).toBe(true)
  })
})
