/**
 * WHAT THIS FILE DOES: proves the pure category → default-GL
 * resolver that lets the journal book a categorized-but-unmapped signal onto
 * the right P&L line instead of dumping it in "Unmapped". It runs isolated
 * from the DB so every branch is checked deterministically.
 *
 * THE GUARANTEES UNDER TEST:
 *   1. Core case: DEVELOPMENT_RD resolves to GL 6800 from the seed.
 *   2. Deterministic within-category pick: an operator default wins, else the
 *      lowest GL code — so the answer never depends on row order.
 *   3. The "can't route" cases return null, not a wrong guess: UNCLASSIFIED, an
 *      empty chart, and a chart whose 6800 row was deleted.
 *
 * WHY IT EXISTS: the journal fallback is only as trustworthy as this pick. If
 * it ever resolved the wrong account, real R&D spend would silently land on,
 * say, a COGS line above gross margin. These assertions can each fail — flip
 * the sort and the order/default tests break; drop the UNCLASSIFIED guard and
 * that test breaks.
 *
 * CONNECTS TO: features/cost-management/classification-utils.ts (the function +
 * the DEFAULT_GL_CODES seed it resolves against) and app/actions/journal-export.ts
 * (the consumer that turns this into journal buckets).
 */

import {
  resolveCategoryDefaultGl,
  DEFAULT_GL_CODES,
  type CategoryGlCandidate,
} from '../classification-utils'

describe('resolveCategoryDefaultGl — the headline mapping (AC)', () => {
  it('routes DEVELOPMENT_RD to GL 6800 from the seed', () => {
    const gl = resolveCategoryDefaultGl('DEVELOPMENT_RD', DEFAULT_GL_CODES)
    expect(gl).not.toBeNull()
    expect(gl!.glCode).toBe('6800')
    // The journal labels its row from glName/accountingType, so check them too.
    expect(gl!.glName).toBe('AI R&D: Experiments & Model Development')
    expect(gl!.accountingType).toBe('OPEX_RD')
  })

  it('routes PRODUCTION_COGS to 5100 (the lowest of the COGS sub-accounts)', () => {
    // 5100 / 5110 / 5120 all share PRODUCTION_COGS in the seed; the resolver
    // must deterministically pick 5100, not whichever happens to be first.
    const gl = resolveCategoryDefaultGl('PRODUCTION_COGS', DEFAULT_GL_CODES)
    expect(gl!.glCode).toBe('5100')
    expect(gl!.accountingType).toBe('COGS')
  })
})

describe('resolveCategoryDefaultGl — deterministic within-category pick', () => {
  it('prefers an operator-flagged default over a lower GL code', () => {
    // 6700 has a lower code, but 6800 is the operator default → 6800 wins. This
    // is the ordering rule that keeps a materialized chart honoring its default.
    const chart: CategoryGlCandidate[] = [
      {
        glCode: '6700',
        glName: 'Custom R&D bucket',
        costCategory: 'DEVELOPMENT_RD',
        accountingType: 'OPEX_RD',
        isDefault: false,
      },
      {
        glCode: '6800',
        glName: 'AI R&D',
        costCategory: 'DEVELOPMENT_RD',
        accountingType: 'OPEX_RD',
        isDefault: true,
      },
    ]
    expect(resolveCategoryDefaultGl('DEVELOPMENT_RD', chart)!.glCode).toBe(
      '6800'
    )
  })

  it('falls back to the lowest GL code when none is flagged default', () => {
    const chart: CategoryGlCandidate[] = [
      {
        glCode: '6900',
        glName: 'R&D B',
        costCategory: 'DEVELOPMENT_RD',
        accountingType: 'OPEX_RD',
      },
      {
        glCode: '6800',
        glName: 'R&D A',
        costCategory: 'DEVELOPMENT_RD',
        accountingType: 'OPEX_RD',
      },
    ]
    expect(resolveCategoryDefaultGl('DEVELOPMENT_RD', chart)!.glCode).toBe(
      '6800'
    )
  })

  it('is order-independent (reversed input yields the same pick)', () => {
    const reversed = [...DEFAULT_GL_CODES].reverse()
    expect(resolveCategoryDefaultGl('PRODUCTION_COGS', reversed)!.glCode).toBe(
      '5100'
    )
  })
})

describe('resolveCategoryDefaultGl — the "do not guess" cases return null', () => {
  it('returns null for UNCLASSIFIED (never a real GL category)', () => {
    expect(
      resolveCategoryDefaultGl('UNCLASSIFIED', DEFAULT_GL_CODES)
    ).toBeNull()
  })

  it('returns null for an empty/blank category', () => {
    expect(resolveCategoryDefaultGl('', DEFAULT_GL_CODES)).toBeNull()
  })

  it('returns null when the chart has no account for the category', () => {
    expect(resolveCategoryDefaultGl('DEVELOPMENT_RD', [])).toBeNull()
  })

  it('returns null when the org deleted its only matching account (deleted-6800 edge)', () => {
    // A materialized chart that no longer carries any DEVELOPMENT_RD account:
    // we cannot route to a GL that does not exist, so the dollars stay unmapped.
    const chartWithout6800: CategoryGlCandidate[] = DEFAULT_GL_CODES.filter(
      (g) => g.costCategory !== 'DEVELOPMENT_RD'
    )
    expect(
      resolveCategoryDefaultGl('DEVELOPMENT_RD', chartWithout6800)
    ).toBeNull()
  })
})
