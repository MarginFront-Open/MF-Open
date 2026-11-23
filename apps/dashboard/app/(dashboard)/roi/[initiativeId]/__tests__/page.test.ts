import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * RBAC posture for the /roi/[initiativeId] detail route, source-asserted
 * (node-only jest, the ../../__tests__/page.test.ts pattern). Same gate as
 * /roi: the detail renders revenue/margin actuals, so it takes the exact
 * MANAGE_MONEY_ROLES gate its parent page takes.
 */
describe('ROI initiative detail route — RBAC gate', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('calls requireRouteRoles(MANAGE_MONEY_ROLES) before rendering the detail', () => {
    const gateIndex = src.indexOf('requireRouteRoles(MANAGE_MONEY_ROLES)')
    const renderIndex = src.indexOf('<InitiativeDetail')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(renderIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(renderIndex)
  })

  it('imports MANAGE_MONEY_ROLES from @marginfront/db and requireRouteRoles from the shared helper', () => {
    expect(src).toMatch(/MANAGE_MONEY_ROLES/)
    expect(src).toMatch(/from ['"]@marginfront\/db['"]/)
    expect(src).toMatch(/from ['"]@\/app\/lib\/require-route-roles['"]/)
  })

  it('awaits the async params and passes initiativeId through to the feature', () => {
    expect(src).toMatch(/params: Promise<\{ initiativeId: string \}>/)
    expect(src).toMatch(/const \{ initiativeId \} = await params/)
    expect(src).toMatch(/initiativeId=\{initiativeId\}/)
  })

  it('renders the feature module and nothing else', () => {
    expect(src).toMatch(/from '@\/features\/roi\/detail'/)
  })

  it('stays a thin server wrapper — no classes (Tailwind scans src/** only), no client directive', () => {
    expect(src).not.toMatch(/className/)
    expect(src).not.toMatch(/'use client'/)
  })
})
