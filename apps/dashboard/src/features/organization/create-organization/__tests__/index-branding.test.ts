import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * create-organization branding: no @ts-nocheck escape hatch and no
 * hardcoded brand assumptions. This is a source assertion, not a render
 * test: the page
 * pulls in react-hook-form + Better Auth's useCreateOrganization mutation,
 * same class of client-only dependency this repo's Node-only jest can't
 * render (see sidebar-data.test.ts's own note on the same constraint).
 */
describe('create-organization branding', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('does not opt out of type checking', () => {
    expect(src).not.toMatch(/@ts-nocheck/)
  })

  it('renders the shared Logo component (same one /sign-in uses via PremiumAuthLayout), not a raw <img> tag', () => {
    expect(src).toMatch(
      /import\s*\{\s*Logo\s*\}\s*from\s*'@\/components\/layout\/logo'/
    )
    expect(src).toMatch(/<Logo\b/)
    expect(src).not.toMatch(/<img\b/)
  })

  it('keeps the create-organization flow intact: submits, refreshes the user, then routes to /quick-onboarding', () => {
    expect(src).toMatch(/createOrganization\.mutateAsync/)
    expect(src).toMatch(/refreshUser\(\)/)
    expect(src).toMatch(/router\.push\('\/quick-onboarding'\)/)
  })
})
