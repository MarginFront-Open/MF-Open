import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * The /agents route redirects to /build, where the Build page lists agents.
 * /agents/[agentId]/signals, /pricing-plans, /revenue-simulator, and
 * /agents/new render as pages; the [agentId] overview redirects too
 * (agent-overview-redirect.test.ts).
 * Source-assertion, not a render test: `redirect` throws a Next.js
 * control-flow signal this repo's Node-only jest can't meaningfully execute,
 * so the test asserts the route calls it.
 */
describe('/agents redirects to /build', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('imports redirect from next/navigation', () => {
    expect(src).toMatch(
      /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/
    )
  })

  it("calls redirect('/build') in the route component", () => {
    expect(src).toMatch(/redirect\('\/build'\)/)
  })

  it('does not render an Agents list component', () => {
    expect(src).not.toMatch(/<Agents\s*\/>/)
    expect(src).not.toMatch(/from '@\/features\/agents'/)
  })

  it('there is no features/agents/index.tsx list component', () => {
    expect(
      existsSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          'src',
          'features',
          'agents',
          'index.tsx'
        )
      )
    ).toBe(false)
  })

  it('the /agents/[agentId]/* subtree exists', () => {
    const agentsDir = join(__dirname, '..')
    expect(existsSync(join(agentsDir, '[agentId]', 'page.tsx'))).toBe(true)
    expect(
      existsSync(join(agentsDir, '[agentId]', 'signals', 'page.tsx'))
    ).toBe(true)
    expect(
      existsSync(join(agentsDir, '[agentId]', 'pricing-plans', 'page.tsx'))
    ).toBe(true)
    expect(
      existsSync(join(agentsDir, '[agentId]', 'revenue-simulator', 'page.tsx'))
    ).toBe(true)
  })

  it('/agents/new exists', () => {
    expect(existsSync(join(__dirname, '..', 'new', 'page.tsx'))).toBe(true)
  })
})
