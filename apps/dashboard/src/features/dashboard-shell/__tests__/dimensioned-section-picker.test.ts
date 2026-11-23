/**
 * DimensionedSection's showDimensionPicker
 * prop. Dashboard jest is node-only with no RTL (jest.config.ts), so this
 * is a conditional-render source-assert rather than a browser test, the same
 * approach shell-safety.test.ts uses for this file.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(
  join(__dirname, '..', 'dimensioned-section.tsx'),
  'utf8'
)

describe('DimensionedSection — showDimensionPicker prop', () => {
  it('declares showDimensionPicker as an optional boolean prop', () => {
    expect(src).toMatch(/showDimensionPicker\?:\s*boolean/)
  })

  it('defaults to true (backward-compatible — every existing caller keeps the picker)', () => {
    expect(src).toMatch(/showDimensionPicker\s*=\s*true/)
  })

  it('the "Group by" block only renders when showDimensionPicker is true', () => {
    expect(src).toMatch(/\{showDimensionPicker\s*&&\s*\(/)
    // The gated block still contains the picker's own markup (role='group'
    // aria-label='Group by') so the conditional wraps the right JSX, not an
    // unrelated one.
    const gateIndex = src.indexOf('{showDimensionPicker &&')
    expect(gateIndex).toBeGreaterThan(-1)
    const afterGate = src.slice(gateIndex, gateIndex + 400)
    expect(afterGate).toMatch(/aria-label='Group by'/)
  })
})
