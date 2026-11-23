/**
 * SDK Simulator reachable as a Build tab.
 * Source-asserted (dashboard jest is node-only, no RTL; the page imports
 * @dnd-kit through TileGrid so it can't be rendered here). Modeled on
 * page-composition.test.ts.
 *
 * Two things must hold at once, forever: (1) the Simulator tab is wired to
 * the REAL SdkSimulatorEmbedded component, not a stub or a copy, and (2)
 * that component's real-event warning survives verbatim.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const buildIndexSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
const simulatorSrc = readFileSync(
  join(__dirname, '..', '..', 'developer-zone', 'sdk-simulator', 'index.tsx'),
  'utf8'
)

describe('Build index.tsx — Simulator tab wiring', () => {
  it('imports SdkSimulatorEmbedded from the existing developer-zone feature (no rebuild)', () => {
    expect(buildIndexSrc).toMatch(
      /import\s*\{\s*SdkSimulatorEmbedded\s*\}\s*from\s*'@\/features\/developer-zone\/sdk-simulator'/
    )
  })

  it('renders exactly one Simulator tab, and it renders SdkSimulatorEmbedded', () => {
    const tabAt = buildIndexSrc.indexOf("<TabsContent value='simulator'>")
    expect(tabAt).toBeGreaterThan(-1)
    const tabContent = buildIndexSrc.slice(
      tabAt,
      buildIndexSrc.indexOf('</TabsContent>', tabAt)
    )
    expect(tabContent).toMatch(/<SdkSimulatorEmbedded\s*\/>/)
  })

  it('the tab registry lists Agents before Simulator (BUILD_TABS order)', () => {
    expect(buildIndexSrc).toMatch(
      /import\s*\{\s*BUILD_TABS,\s*resolveBuildTab\s*\}\s*from\s*'\.\/build-tabs'/
    )
  })

  it('the agents area (table, event stream, detail, tile grid, headless resolver mount) lives in the Agents tab; keys live on their own tab', () => {
    const agentsTabAt = buildIndexSrc.indexOf("<TabsContent value='agents'")
    const keysTabAt = buildIndexSrc.indexOf("<TabsContent value='keys'>")
    const simulatorTabAt = buildIndexSrc.indexOf(
      "<TabsContent value='simulator'>"
    )
    expect(agentsTabAt).toBeGreaterThan(-1)
    expect(keysTabAt).toBeGreaterThan(agentsTabAt)
    expect(simulatorTabAt).toBeGreaterThan(keysTabAt)
    const agentsTabContent = buildIndexSrc.slice(agentsTabAt, keysTabAt)
    for (const marker of [
      '<AgentsTable',
      '<EventStream',
      '<AgentDetail',
      '<TileGrid',
      '<DimensionedSection',
    ]) {
      expect(agentsTabContent).toMatch(marker)
    }
    expect(agentsTabContent).not.toMatch(/<ApiKeys/)
  })

  it('uses the same ?tab= URL-state idiom as Money (router.replace, scroll: false)', () => {
    expect(buildIndexSrc).toMatch(
      /resolveBuildTab\(searchParams\.get\('tab'\)\)/
    )
    expect(buildIndexSrc).toMatch(/router\.replace\(/)
    expect(buildIndexSrc).toMatch(/scroll:\s*false/)
  })
})

describe('sdk-simulator/index.tsx — embed adds a tab-safe entry point, changes nothing else', () => {
  it('exports SdkSimulatorEmbedded alongside the existing default export', () => {
    expect(simulatorSrc).toMatch(/export function SdkSimulatorEmbedded\(\)/)
    expect(simulatorSrc).toMatch(/export default function SdkSimulatorPage\(\)/)
  })

  it('SdkSimulatorEmbedded renders NO <Page> wrapper (the layout-context landmine)', () => {
    const at = simulatorSrc.indexOf('export function SdkSimulatorEmbedded()')
    expect(at).toBeGreaterThan(-1)
    const body = simulatorSrc.slice(at, simulatorSrc.indexOf('\n}', at))
    expect(body).not.toMatch(/<Page\b/)
  })

  it('SdkSimulatorEmbedded renders the same tool as the standalone route', () => {
    const at = simulatorSrc.indexOf('export function SdkSimulatorEmbedded()')
    const body = simulatorSrc.slice(at, simulatorSrc.indexOf('\n}', at))
    expect(body).toMatch(/<SdkSimulatorTool\s*\/>/)
  })

  it('the standalone route (SdkSimulatorPage) wraps the same tool in a Page', () => {
    const at = simulatorSrc.indexOf(
      'export default function SdkSimulatorPage()'
    )
    const body = simulatorSrc.slice(at, simulatorSrc.indexOf('\n}', at))
    expect(body).toMatch(/<SdkSimulatorTool\s*\/>/)
    expect(body).toMatch(/<Page\b/)
  })

  it('the real-event warning banner survives verbatim ("Live environment" + billing impact copy)', () => {
    expect(simulatorSrc).toMatch(/Live environment/)
    expect(simulatorSrc).toMatch(
      /Events sent from this simulator are real and will appear in your\s+usage data and billing\./
    )
  })

  it('the ingest call site (recordSdkUsage) is unchanged — one call, inside the shared tool', () => {
    expect(simulatorSrc.match(/recordSdkUsage\(/g)).toHaveLength(1)
  })
})
