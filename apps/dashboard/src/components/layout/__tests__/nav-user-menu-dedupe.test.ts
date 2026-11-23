import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The account menu (NavUser) has one Settings link and does not duplicate
 * the Settings page's own tab bar (no Billing or Integrations rows).
 * Settings' tab bar is the single correctly-gated settings surface. Source-assertion, not a render
 * test (NavUser depends on client-only hooks this repo's Node-only jest
 * can't render, same reasoning as nav-user-identity.test.ts).
 */
describe('NavUser — exactly one Settings link, no Billing/Integrations duplicates', () => {
  const src = readFileSync(join(__dirname, '..', 'nav-user.tsx'), 'utf8')

  it('has exactly one link into /settings', () => {
    const settingsLinks = src.match(/href='\/settings\/[a-z]+'/g) ?? []
    expect(settingsLinks).toEqual(["href='/settings/profile'"])
  })

  it('has no "Billing" row', () => {
    expect(src).not.toMatch(/Billing/)
  })

  it('has no "Integrations" row', () => {
    expect(src).not.toMatch(/Integrations/)
  })

  it('does not link to /settings/integrations', () => {
    expect(src).not.toMatch(/\/settings\/integrations/)
  })

  it('has Theme controls and Log out', () => {
    expect(src).toMatch(/Theme/)
    expect(src).toMatch(/Log out/)
  })
})
