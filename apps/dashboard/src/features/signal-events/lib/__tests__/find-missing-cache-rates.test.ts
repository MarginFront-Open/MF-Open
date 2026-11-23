/**
 * WHAT THIS FILE DOES: Pins the Map Model dialog's BEFORE-you-commit check
 *   against `resolveEventPrice`, the guard that actually refuses at write
 *   time. The dialog's promise is "if this warns, the run will leave events
 *   unpriced; if it stays quiet, the run will price them." A check that
 *   disagrees with the guard breaks that promise in one direction or the
 *   other, and both directions are bad on a billing surface.
 * WHY IT CANNOT PASS BY ACCIDENT: the agreement test drives BOTH functions
 *   over the same matrix and compares them, so it fails if either side moves
 *   alone. The real `resolveEventPrice` from @marginfront/db is imported, not
 *   stubbed.
 * CONNECTS TO: ../find-missing-cache-rates.ts (dialog side),
 *   packages/db/src/lib/model-pricing.ts (the authority).
 */
import { resolveEventPrice, isPriceRefused } from '@marginfront/db'
import {
  findMissingCacheRates,
  describeMissingCacheRates,
} from '../find-missing-cache-rates'

// Example catalog rates for a claude-opus-5/anthropic row.
const CATALOG_RATES = {
  inputCost: 5,
  outputCost: 25,
  cacheReadCost: 0.5 as number | null,
  cacheWriteCost: 10 as number | null,
  costUnit: '1M tokens',
}

// A synthetic queued child: 30 input, 14,800 output, 1,250,000 cache-read,
// 27,500 cache-write, the shape of one stuck in NEEDS_COST_BACKFILL.
const QUEUED_CHILD = {
  inputTokens: 30,
  outputTokens: 14800,
  cacheReadTokens: 1250000,
  cacheWriteTokens: 27500,
}

describe('findMissingCacheRates', () => {
  it('stays quiet when the row prices everything the events used', () => {
    expect(
      findMissingCacheRates({
        costUnit: '1M tokens',
        cacheReadCost: 0.5,
        cacheWriteCost: 10,
        cacheReadTokens: 1250000,
        cacheWriteTokens: 27500,
      })
    ).toEqual([])
  })

  it('names the missing direction when the events used it', () => {
    expect(
      findMissingCacheRates({
        costUnit: '1M tokens',
        cacheReadCost: 0.5,
        cacheWriteCost: null,
        cacheReadTokens: 1250000,
        cacheWriteTokens: 27500,
      })
    ).toEqual(['cacheWriteCost'])
  })

  it('names both directions when the row prices neither', () => {
    expect(
      findMissingCacheRates({
        costUnit: '1M tokens',
        cacheReadCost: null,
        cacheWriteCost: null,
        cacheReadTokens: 1250000,
        cacheWriteTokens: 27500,
      })
    ).toEqual(['cacheReadCost', 'cacheWriteCost'])
  })

  it('NEGATIVE CONTROL: silent when the events used no cache at all', () => {
    // Most "1M tokens" rows in the price catalog have no cacheWriteCost. A
    // warning keyed on the missing rate alone would fire on nearly every
    // mapping, and an operator who sees it every time stops reading it.
    expect(
      findMissingCacheRates({
        costUnit: '1M tokens',
        cacheReadCost: null,
        cacheWriteCost: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    ).toEqual([])
  })

  it('PRICED-ZERO TWIN: a genuine $0.00 rate is a price, not a gap', () => {
    expect(
      findMissingCacheRates({
        costUnit: '1M tokens',
        cacheReadCost: 0,
        cacheWriteCost: 0,
        cacheReadTokens: 1250000,
        cacheWriteTokens: 27500,
      })
    ).toEqual([])
  })

  it('NEGATIVE CONTROL: silent on a cost unit that never prices cache', () => {
    expect(
      findMissingCacheRates({
        costUnit: '1K calls',
        cacheReadCost: null,
        cacheWriteCost: null,
        cacheReadTokens: 1250000,
        cacheWriteTokens: 27500,
      })
    ).toEqual([])
  })
})

describe('describeMissingCacheRates speaks English, not column names', () => {
  it('covers each shape', () => {
    expect(describeMissingCacheRates(['cacheReadCost'])).toBe(
      'reading from the cache'
    )
    expect(describeMissingCacheRates(['cacheWriteCost'])).toBe(
      'writing to the cache'
    )
    expect(describeMissingCacheRates(['cacheReadCost', 'cacheWriteCost'])).toBe(
      'reading from and writing to the cache'
    )
  })

  it('never leaks a column name to the customer', () => {
    const everyShape = [
      ['cacheReadCost'],
      ['cacheWriteCost'],
      ['cacheReadCost', 'cacheWriteCost'],
    ]
    for (const shape of everyShape) {
      const copy = describeMissingCacheRates(shape)
      expect(copy).not.toMatch(/cacheReadCost|cacheWriteCost/)
      // "just" is banned in customer-facing copy.
      expect(copy).not.toMatch(/\bjust\b/i)
    }
  })
})

describe('the dialog check AGREES with the guard that actually refuses', () => {
  // Every combination that matters: both cost-unit branches, rate present /
  // absent / priced-zero, and cache counts present / absent.
  const rateOptions: (number | null)[] = [null, 0, 10]
  const countOptions = [0, 26907]
  const costUnits = ['1M tokens', '1K calls']

  it('warns exactly when resolveEventPrice refuses, across the matrix', () => {
    const disagreements: string[] = []
    let refusals = 0
    let cases = 0

    for (const costUnit of costUnits) {
      for (const cacheReadCost of rateOptions) {
        for (const cacheWriteCost of rateOptions) {
          for (const cacheReadTokens of countOptions) {
            for (const cacheWriteTokens of countOptions) {
              cases++
              const entry = {
                ...CATALOG_RATES,
                costUnit,
                cacheReadCost: cacheReadCost ?? undefined,
                cacheWriteCost: cacheWriteCost ?? undefined,
              }
              const guard = resolveEventPrice({
                inputTokens: QUEUED_CHILD.inputTokens,
                outputTokens: QUEUED_CHILD.outputTokens,
                quantity: 1,
                entry,
                cacheReadTokens,
                cacheWriteTokens,
                provider: 'anthropic',
                model: 'claude-opus-5',
              })
              const guardRefused = isPriceRefused(guard)
              if (guardRefused) refusals++

              const dialogWarns =
                findMissingCacheRates({
                  costUnit,
                  cacheReadCost,
                  cacheWriteCost,
                  cacheReadTokens,
                  cacheWriteTokens,
                }).length > 0

              if (dialogWarns !== guardRefused) {
                disagreements.push(
                  `${costUnit} cr=${cacheReadCost} cw=${cacheWriteCost} ` +
                    `crTok=${cacheReadTokens} cwTok=${cacheWriteTokens}: ` +
                    `dialog=${dialogWarns} guard=${guardRefused}`
                )
              }
            }
          }
        }
      }
    }

    expect(disagreements).toEqual([])
    expect(cases).toBe(72)
    // The matrix must actually exercise the refusal path — an agreement test
    // over a matrix where nothing refuses agrees trivially.
    expect(refusals).toBeGreaterThan(0)
  })

  it('names the SAME rates the guard names', () => {
    const guard = resolveEventPrice({
      inputTokens: QUEUED_CHILD.inputTokens,
      outputTokens: QUEUED_CHILD.outputTokens,
      quantity: 1,
      entry: {
        ...CATALOG_RATES,
        cacheReadCost: undefined,
        cacheWriteCost: undefined,
      },
      cacheReadTokens: QUEUED_CHILD.cacheReadTokens,
      cacheWriteTokens: QUEUED_CHILD.cacheWriteTokens,
      provider: 'anthropic',
      model: 'claude-opus-5',
    })
    if (!isPriceRefused(guard)) throw new Error('expected a refusal')

    expect(
      findMissingCacheRates({
        costUnit: '1M tokens',
        cacheReadCost: null,
        cacheWriteCost: null,
        cacheReadTokens: QUEUED_CHILD.cacheReadTokens,
        cacheWriteTokens: QUEUED_CHILD.cacheWriteTokens,
      })
    ).toEqual(guard.missingRates)
  })
})
