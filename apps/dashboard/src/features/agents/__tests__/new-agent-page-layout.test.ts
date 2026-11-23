import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /agents/new renders inside the `Page` component like every other route, so
 * it gets the breadcrumb and header. Source-assertion, not a render
 * test — this repo's Node-only jest can't render client components with
 * hooks (useForm/useCreateAgent/useRouter), same constraint as the sibling
 * page-layout tests.
 */
describe('NewAgent renders through Page chrome', () => {
  const src = readFileSync(join(__dirname, '..', 'new-agent.tsx'), 'utf8')

  it('imports Page', () => {
    expect(src).toMatch(
      /import\s*\{\s*Page\s*\}\s*from\s*['"]@\/components\/layouts\/page['"]/
    )
  })

  it("wraps the return in <Page title='New Agent'>", () => {
    expect(src).toMatch(/<Page\s+title='New Agent'/)
  })

  it('sets a Home -> Build -> New Agent breadcrumb', () => {
    const breadcrumbIndex = src.indexOf('breadcrumb:')
    expect(breadcrumbIndex).toBeGreaterThan(-1)
    const breadcrumbBlock = src.slice(breadcrumbIndex, breadcrumbIndex + 300)
    expect(breadcrumbBlock).toMatch(/name:\s*'Home'/)
    expect(breadcrumbBlock).toMatch(/name:\s*'Build'/)
    expect(breadcrumbBlock).toMatch(/href:\s*'\/build'/)
    expect(breadcrumbBlock).toMatch(/name:\s*'New Agent'/)
  })

  it('has no in-body <h1>New Agent</h1> because Page owns the title', () => {
    expect(src).not.toMatch(/<h1[^>]*>\s*New Agent\s*<\/h1>/)
  })
})
