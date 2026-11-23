import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /finops-settings is a redirect: its two editors live on /finops as the
 * "Settings" tab. This route 307-redirects there. Source-assertion, not a
 * render test: `redirect` throws a Next.js control-flow signal this repo's
 * Node-only jest can't meaningfully execute, so the test asserts the route
 * calls it.
 */
describe('/finops-settings redirects to /finops?tab=settings', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('imports redirect from next/navigation', () => {
    expect(src).toMatch(
      /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/
    )
  })

  it("calls redirect('/finops?tab=settings') in the route component", () => {
    expect(src).toMatch(/redirect\('\/finops\?tab=settings'\)/)
  })

  it('does not render the FinOps Settings feature itself', () => {
    expect(src).not.toMatch(/<FinopsSettings\s*\/>/)
    expect(src).not.toMatch(/from '@\/features\/finops-settings'/)
  })
})
