import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * "Add organization" routes to /quick-onboarding?new=true, which the server
 * guard (app/quick-onboarding/page.tsx) only lets an OWNER of the active org
 * through; everyone
 * else bounces to '/'. This is the COSMETIC half: hide the menu item for
 * non-owners so it doesn't dead-end them. Source-assertion, not a render
 * test — this repo's Node-only jest can't mount TeamSwitcher (it's inside
 * the sidebar's client tree, same constraint as sidebar-data.test.ts /
 * header-theme-switch.test.ts). The server guard, not this gate, is the
 * real enforcer.
 */
describe('TeamSwitcher — "Add organization" is owner-only (cosmetic gate)', () => {
  const src = readFileSync(join(__dirname, '..', 'team-switcher.tsx'), 'utf8')

  it('reads the viewer’s role from useAuth() (the same source require-route-roles.ts mirrors server-side)', () => {
    expect(src).toMatch(/const\s*\{[^}]*\buser\b[^}]*\}\s*=\s*useAuth\(\)/)
  })

  it("derives a canAddOrg flag gated on role === 'owner'", () => {
    expect(src).toMatch(/canAddOrg\s*=\s*user\?\.role\s*===\s*'owner'/)
  })

  it('wraps the "Add organization" DropdownMenuItem in the canAddOrg gate', () => {
    const addOrgIndex = src.indexOf('Add organization')
    expect(addOrgIndex).toBeGreaterThan(-1)
    const before = src.slice(0, addOrgIndex)
    // Nearest un-closed `{canAddOrg && (` ahead of the label, with no
    // `)}` closing it before the label appears — i.e. the label renders
    // INSIDE the gate, not after it.
    const gateIndex = before.lastIndexOf('{canAddOrg && (')
    expect(gateIndex).toBeGreaterThan(-1)
    const between = src.slice(gateIndex, addOrgIndex)
    expect(between).not.toMatch(/\)\}/)
  })
})
