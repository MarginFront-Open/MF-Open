/**
 * The Month dropdown and the two Custom date inputs share CONTROL_CLASS,
 * and without it their 12px label clips in half. @tailwindcss/forms injects 8px top/bottom padding on native
 * select/input[type=date], and the global `select { line-height: 1.5 }`
 * base rule (src/index.css) pushes the text's line box to 18px — inside
 * the h-7 (28px) control that only leaves a 10px content box, so Chromium
 * hard-clips the value. CONTROL_CLASS must carry its OWN explicit vertical
 * padding + line-height utilities to win over both lower-specificity rules.
 * Source-assertion, not a render test — this repo's Node-only jest can't
 * measure real box metrics.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(
  join(__dirname, '..', 'date-range-selector.tsx'),
  'utf8'
)

function extractControlClass(src: string): string {
  const match = src.match(/const CONTROL_CLASS =\s*\n?\s*'([^']+)'/)
  if (!match) {
    throw new Error(
      "Could not find `const CONTROL_CLASS = '...'` in date-range-selector.tsx"
    )
  }
  return match[1]
}

describe('DateRangeSelector — CONTROL_CLASS carries explicit vertical-centering utilities', () => {
  const controlClass = extractControlClass(SRC)

  it('sets an explicit py- padding utility (overrides @tailwindcss/forms 8px)', () => {
    expect(controlClass).toMatch(/(?:^|\s)py-\d+(?:\.\d+)?(?:\s|$)/)
  })

  it('sets an explicit leading- line-height utility (overrides the global select{line-height:1.5} base rule)', () => {
    expect(controlClass).toMatch(
      /(?:^|\s)leading-(?:none|\d+|\[[^\]]+\])(?:\s|$)/
    )
  })

  it('still fixes h-7 at the documented 28px height (the box math these utilities were sized against)', () => {
    expect(controlClass).toMatch(/(?:^|\s)h-7(?:\s|$)/)
  })

  it('both the Month <select> and the two Custom <input type="date"> use the shared CONTROL_CLASS (one fix covers all three)', () => {
    const controlUsages = SRC.match(/className=\{CONTROL_CLASS\}/g) ?? []
    expect(controlUsages.length).toBe(3)
  })
})
