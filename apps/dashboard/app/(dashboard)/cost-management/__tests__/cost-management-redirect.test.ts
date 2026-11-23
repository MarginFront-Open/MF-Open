import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /cost-management is a redirect: its three panels live on /finops as the
 * "Cost management" tab. This route 307-redirects there, forwarding the
 * ?startDate=&endDate= deep-link bounds verbatim. Source-assertion, not a
 * render test: `redirect` throws a Next.js control-flow signal this repo's
 * Node-only jest can't meaningfully execute, so the test asserts the route
 * calls it.
 */
describe('/cost-management redirects to /finops?tab=cost-management', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('imports redirect from next/navigation', () => {
    expect(src).toMatch(
      /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/
    )
  })

  it('redirects to the cost-management tab', () => {
    expect(src).toMatch(/tab:\s*'cost-management'/)
    expect(src).toMatch(/redirect\(`\/finops\?\$\{forwarded\.toString\(\)\}`\)/)
  })

  it('forwards the startDate/endDate deep-link params', () => {
    expect(src).toMatch(/forwarded\.set\('startDate', params\.startDate\)/)
    expect(src).toMatch(/forwarded\.set\('endDate', params\.endDate\)/)
  })

  it('does not render the Cost Management feature itself', () => {
    expect(src).not.toMatch(/<CostManagement/)
    expect(src).not.toMatch(/from '@\/features\/cost-management'/)
  })
})
