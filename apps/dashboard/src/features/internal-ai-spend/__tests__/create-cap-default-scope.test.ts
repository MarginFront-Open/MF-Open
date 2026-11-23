import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Source-assertion (dashboard jest is node-only, no RTL).
 * The create-cap form must default to the whole-team ('org') scope, not 'dev'.
 * A 'dev' default can't be saved on a fresh org (no teammate is on the meter
 * yet), so the form would read as broken on a new account. The save gate only short-circuits to ok for 'org'
 * (ceilingCheck), which is why this default is what makes a new account savable.
 */
const tabSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

describe('create-cap form default scope', () => {
  it("defaults the 'Applies to' scope to whole-team ('org')", () => {
    expect(tabSrc).toMatch(/useState<CapScope>\('org'\)/)
  })

  it("does not default the create form to per-teammate ('dev')", () => {
    expect(tabSrc).not.toMatch(/useState<CapScope>\('dev'\)/)
  })

  it("still short-circuits the ceiling check for 'org' so the form saves", () => {
    // org caps carry no per-teammate ceiling, so ceilingCheck is ok:true and
    // the 'Set this cap' button is enabled with no teammate selected.
    expect(tabSrc).toMatch(
      /scope !== 'org'\s*\n?\s*\?\s*checkAmountAgainstCeiling/
    )
  })
})
