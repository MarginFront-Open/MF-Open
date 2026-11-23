import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /settings/profile must carry no template copy: no "This is how others
 * will see you on the site", no username-change cooldown (none exists
 * server-side; api-nest's UpdateUserDto only accepts name and persona),
 * and no "@mention other users" feature that doesn't exist in this product.
 * Source assertion, not a render test (dashboard jest is node-only, no RTL).
 */
describe('/settings/profile — no template copy', () => {
  const indexSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
  const formSrc = readFileSync(
    join(__dirname, '..', 'profile-form.tsx'),
    'utf8'
  )

  it('does not show the "how others will see you on the site" template line', () => {
    expect(indexSrc).not.toMatch(/how others will see you on the site/)
  })

  it('makes no username-change cooldown claim', () => {
    expect(formSrc).not.toMatch(/pseudonym/)
    expect(formSrc).not.toMatch(/once every 30 days/)
  })

  it('makes no @mention claim', () => {
    expect(formSrc).not.toMatch(/@mention/)
  })
})
