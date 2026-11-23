import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The pricing-configure page (@ts-nocheck, bespoke header) renders inside
 * `Page` chrome with a title and breadcrumb. The wrap is visual only: the
 * in-body content and @ts-nocheck stay as they are. Source-assertion, not a render test — this
 * repo's Node-only jest can't render this client component (usePricingState/
 * usePricingOperations hooks), same constraint as the sibling page-layout
 * tests.
 */
describe('PricingConfigure renders through Page chrome', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('keeps @ts-nocheck', () => {
    expect(src).toMatch(/^\/\/ @ts-nocheck/m)
  })

  it('imports Page', () => {
    expect(src).toMatch(
      /import\s*\{\s*Page\s*\}\s*from\s*['"]@\/components\/layouts\/page['"]/
    )
  })

  it("wraps the return in <Page title='Configure Pricing'>", () => {
    expect(src).toMatch(/<Page\s*\n\s*title='Configure Pricing'/)
  })

  it('sets a breadcrumb ending in Configure', () => {
    const breadcrumbIndex = src.indexOf('breadcrumb:')
    expect(breadcrumbIndex).toBeGreaterThan(-1)
    const breadcrumbBlock = src.slice(breadcrumbIndex, breadcrumbIndex + 400)
    expect(breadcrumbBlock).toMatch(/name:\s*'Home'/)
    expect(breadcrumbBlock).toMatch(/name:\s*'Configure'/)
  })

  it('renders the in-body header content', () => {
    expect(src).toMatch(/Configure pricing for \{agent\.name\}/)
    expect(src).toMatch(/pricingPlan\?\.name \|\| 'Pricing Configuration'/)
  })
})
