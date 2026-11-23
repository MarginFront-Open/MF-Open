import {
  DEFAULT_NEEDS_ATTENTION_TAB,
  NEEDS_ATTENTION_TABS,
  defaultNeedsAttentionTab,
  resolveNeedsAttentionTab,
  type NeedsAttentionTabCounts,
} from '../needs-attention-tabs'

/**
 * The Needs Attention sub-tab registry and its `?tab=` contract
 * (shared with deep links elsewhere in the app). Same shape as money-tabs.test.ts.
 */
const counts = (
  costBackfill: number,
  missingVolume: number,
  creditPools: number
): NeedsAttentionTabCounts => ({
  'cost-backfill': costBackfill,
  'missing-volume': missingVolume,
  'credit-pools': creditPools,
})

const NOTHING = counts(0, 0, 0)

describe('NEEDS_ATTENTION_TABS registry', () => {
  it('ships exactly Cost backfill, Missing volume, Credit pools, in that order', () => {
    expect(NEEDS_ATTENTION_TABS.map((tab) => tab.id)).toEqual([
      'cost-backfill',
      'missing-volume',
      'credit-pools',
    ])
    expect(NEEDS_ATTENTION_TABS.map((tab) => tab.label)).toEqual([
      'Cost backfill',
      'Missing volume',
      'Credit pools',
    ])
  })

  it('names cost backfill as the fallback tab', () => {
    expect(DEFAULT_NEEDS_ATTENTION_TAB).toBe('cost-backfill')
  })
})

describe('defaultNeedsAttentionTab', () => {
  it('opens the first tab that has rows', () => {
    expect(defaultNeedsAttentionTab(counts(3, 2, 1))).toBe('cost-backfill')
    expect(defaultNeedsAttentionTab(counts(0, 2, 1))).toBe('missing-volume')
    expect(defaultNeedsAttentionTab(counts(0, 0, 1))).toBe('credit-pools')
  })

  it('falls back to cost backfill when every count is zero', () => {
    expect(defaultNeedsAttentionTab(NOTHING)).toBe('cost-backfill')
  })
})

describe('resolveNeedsAttentionTab', () => {
  it('resolves a known tab id verbatim, even when that tab is empty', () => {
    expect(resolveNeedsAttentionTab('cost-backfill', NOTHING)).toBe(
      'cost-backfill'
    )
    expect(resolveNeedsAttentionTab('missing-volume', NOTHING)).toBe(
      'missing-volume'
    )
    expect(resolveNeedsAttentionTab('credit-pools', NOTHING)).toBe(
      'credit-pools'
    )
  })

  it('falls back to the first tab with rows when ?tab= is absent', () => {
    expect(resolveNeedsAttentionTab(null, counts(0, 4, 0))).toBe(
      'missing-volume'
    )
    expect(resolveNeedsAttentionTab(null, NOTHING)).toBe(
      DEFAULT_NEEDS_ATTENTION_TAB
    )
  })

  it('falls back rather than crashing on an unrecognized value (stale bookmark, typo, casing)', () => {
    expect(resolveNeedsAttentionTab('bogus', counts(0, 0, 5))).toBe(
      'credit-pools'
    )
    expect(resolveNeedsAttentionTab('', counts(0, 0, 5))).toBe('credit-pools')
    expect(resolveNeedsAttentionTab('Cost-Backfill', NOTHING)).toBe(
      DEFAULT_NEEDS_ATTENTION_TAB
    )
    expect(resolveNeedsAttentionTab('credit_pools', NOTHING)).toBe(
      DEFAULT_NEEDS_ATTENTION_TAB
    )
  })
})
