import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * "Manage team & members" routes to
 * /settings/team, an owner/admin-only surface. Gate it here the same
 * cosmetic way the "Add organization" item is gated: hide the
 * menu item for a plain member so it doesn't dead-end them. Source-assertion,
 * not a render test — this repo's Node-only jest can't mount TeamSwitcher
 * (same constraint as the sibling Add-organization gate test).
 */
describe('TeamSwitcher — "Manage team & members" is owner/admin-only (cosmetic gate)', () => {
  const src = readFileSync(join(__dirname, '..', 'team-switcher.tsx'), 'utf8')

  it("derives a canManageTeam flag gated on role === 'owner' or 'admin'", () => {
    expect(src).toMatch(
      /canManageTeam\s*=\s*user\?\.role\s*===\s*'owner'\s*\|\|\s*user\?\.role\s*===\s*'admin'/
    )
  })

  it('wraps the "Manage team & members" DropdownMenuItem in the canManageTeam gate', () => {
    const manageTeamIndex = src.indexOf('Manage team & members')
    expect(manageTeamIndex).toBeGreaterThan(-1)
    const before = src.slice(0, manageTeamIndex)
    const gateIndex = before.lastIndexOf('{canManageTeam && (')
    expect(gateIndex).toBeGreaterThan(-1)
    const between = src.slice(gateIndex, manageTeamIndex)
    expect(between).not.toMatch(/\)\}/)
  })
})
