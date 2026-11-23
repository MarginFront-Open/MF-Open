/**
 * WHAT THIS FILE GUARDS: the $/seat (and signal tier) rate input
 * can be cleared, survives decimal entry, and renders $0 as empty. Mapping
 * '' → 0 on every keystroke would make the field impossible to clear and
 * turn a typed 0.5 into $5, a 10x price error typed in good faith.
 *
 * Pure-helper assertions run the actual parse/display rules; the source
 * assertions pin that PricingTierManager wires them into the input (the
 * helpers being correct is worthless if the component falls back to inline
 * parsing).
 */

import { readFileSync } from 'fs'
import path from 'path'
import { displayRate, parseRateInput } from '../rate-input'

describe('parseRateInput — when a keystroke commits to pricing state', () => {
  it('commits clean numbers', () => {
    expect(parseRateInput('5')).toBe(5)
    expect(parseRateInput('0.5')).toBe(0.5)
    expect(parseRateInput('12.34')).toBe(12.34)
  })

  it('commits an explicit zero (a real $0 rate is allowed)', () => {
    expect(parseRateInput('0')).toBe(0)
  })

  it('holds empty input instead of forcing 0 — the field must be clearable', () => {
    expect(parseRateInput('')).toBeNull()
    expect(parseRateInput('   ')).toBeNull()
  })

  it('a trailing decimal point still carries its integer part', () => {
    // Number('0.') === 0 — mid-entry of "0.5" the committed state is 0, and
    // the draft keeps the dot on screen so the next digit lands after it.
    expect(parseRateInput('0.')).toBe(0)
  })

  it('holds negatives and garbage instead of committing them', () => {
    expect(parseRateInput('-5')).toBeNull()
    expect(parseRateInput('abc')).toBeNull()
    expect(parseRateInput('Infinity')).toBeNull()
  })
})

describe('displayRate — how stored rates render back into the box', () => {
  it('renders zero and not-set as empty so the 0.00 placeholder shows', () => {
    expect(displayRate(0)).toBe('')
    expect(displayRate(null)).toBe('')
    expect(displayRate(undefined)).toBe('')
  })

  it('renders real rates as their plain string', () => {
    expect(displayRate(0.5)).toBe('0.5')
    expect(displayRate(10)).toBe('10')
  })
})

describe('PricingTierManager — the input actually uses the draft-state helpers', () => {
  const source = readFileSync(
    path.join(__dirname, '../components/PricingTierManager.tsx'),
    'utf-8'
  )

  it('imports the pure helpers instead of parsing inline', () => {
    expect(source).toMatch(/from '\.\.\/rate-input'/)
    expect(source).toMatch(/parseRateInput\(/)
    expect(source).toMatch(/displayRate\(/)
  })

  it('holds a per-row draft and clears it on blur', () => {
    expect(source).toMatch(/rateDrafts/)
    expect(source).toMatch(/onBlur/)
  })

  it("the rate input never maps '' to 0 on a keystroke", () => {
    expect(source).not.toMatch(/e\.target\.value === '' \? 0/)
  })
})
