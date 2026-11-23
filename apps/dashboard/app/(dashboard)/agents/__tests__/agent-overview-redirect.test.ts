import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * /agents/[agentId] server-redirects to /build?agent=[id], where Build's
 * drill-in detail renders the same identity, stat tiles, and earnings chart
 * through the shared agent-earnings module. The signals, pricing-plans, and
 * revenue-simulator subroutes render as pages. Source-assertion, not a render
 * test: `redirect` throws a Next.js control-flow signal this repo's
 * Node-only jest can't meaningfully execute, so the test asserts the route
 * calls it.
 */

const AGENTS_DIR = join(__dirname, '..')
const SRC_DIR = join(AGENTS_DIR, '..', '..', '..', 'src')

describe('/agents/[agentId] redirects to /build?agent=', () => {
  const src = readFileSync(join(AGENTS_DIR, '[agentId]', 'page.tsx'), 'utf8')

  it('imports redirect from next/navigation', () => {
    expect(src).toMatch(
      /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/
    )
  })

  it('awaits params and redirects to the Build drill-in for that agent', () => {
    expect(src).toMatch(/await params/)
    expect(src).toMatch(/redirect\(`\/build\?agent=\$\{agentId\}`\)/)
  })

  it('does not render an Overview inside AgentTabs', () => {
    expect(src).not.toMatch(/AgentTabs/)
    expect(src).not.toMatch(/AgentOverview/)
    expect(src).not.toMatch(/from '@\/features\/agents/)
  })

  it('there is no agents Overview.tsx component', () => {
    expect(
      existsSync(join(SRC_DIR, 'features', 'agents', 'Overview.tsx'))
    ).toBe(false)
  })

  it('the agent subroutes exist (signals, pricing-plans, revenue-simulator)', () => {
    const agentDir = join(AGENTS_DIR, '[agentId]')
    expect(existsSync(join(agentDir, 'signals', 'page.tsx'))).toBe(true)
    expect(existsSync(join(agentDir, 'pricing-plans', 'page.tsx'))).toBe(true)
    expect(existsSync(join(agentDir, 'revenue-simulator', 'page.tsx'))).toBe(
      true
    )
  })
})

describe('no path lands on an agent overview page', () => {
  const tabsSrc = readFileSync(
    join(SRC_DIR, 'features', 'agents', 'AgentTabs.tsx'),
    'utf8'
  )
  const wizardSrc = readFileSync(
    join(SRC_DIR, 'features', 'agents', 'MetricsWizard.tsx'),
    'utf8'
  )
  const pricingConfigureSrc = readFileSync(
    join(SRC_DIR, 'features', 'pricing-configure', 'index.tsx'),
    'utf8'
  )

  it('AgentTabs has no Overview tab, only Metrics, Pricing Plans and Revenue Simulator', () => {
    expect(tabsSrc).not.toMatch(/title:\s*'Overview'/)
    for (const title of ['Metrics', 'Pricing Plans', 'Revenue Simulator']) {
      expect(tabsSrc).toMatch(new RegExp(`title:\\s*'${title}'`))
    }
  })

  it("AgentTabs' agent-name crumb points at the Build drill-in, not the redirect", () => {
    expect(tabsSrc).toMatch(/href:\s*`\/build\?agent=\$\{agentId\}`/)
  })

  it('nothing routes to the bare /agents/[agentId] URL', () => {
    for (const src of [tabsSrc, wizardSrc, pricingConfigureSrc]) {
      expect(src).not.toMatch(/[`'"]\/agents\/\$\{agentId\}[`'"]/)
    }
  })

  it('MetricsWizard BACK and pricing-configure crumb go to the Build drill-in', () => {
    expect(wizardSrc).toMatch(/router\.push\(`\/build\?agent=\$\{agentId\}`\)/)
    expect(pricingConfigureSrc).toMatch(
      /href:\s*`\/build\?agent=\$\{agentId\}`/
    )
  })
})
