import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The Month dropdown (shared by Money, FinOps, and Build) says which option
 * is the in-progress month, matching the "(current)" suffix
 * month-end-close/index.tsx renders for
 * monthsAgo === 0. Source-assertion only (dashboard jest is node-only, no
 * RTL) — this checks the marker exists on the right option, not a render.
 */
const SRC = readFileSync(
  join(__dirname, '..', 'date-range-selector.tsx'),
  'utf8'
)

describe('DateRangeSelector — the Month dropdown marks the in-progress month', () => {
  it('appends " (current)" only for monthsAgo === 0', () => {
    expect(SRC).toMatch(/\{option\.monthsAgo === 0 \? ' \(current\)' : ''\}/)
  })

  it('the marker sits inside the same <option> as the label, not a second row', () => {
    const optionStart = SRC.indexOf('{MONTH_OPTIONS.map')
    const optionEnd = SRC.indexOf('</select>', optionStart)
    const block = SRC.slice(optionStart, optionEnd)
    expect(block).toMatch(/\{option\.label\}/)
    expect(block).toMatch(/\{option\.monthsAgo === 0 \? ' \(current\)' : ''\}/)
  })
})
