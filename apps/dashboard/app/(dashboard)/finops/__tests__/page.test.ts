import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * RBAC posture for the /finops route, source-asserted (this unit suite has
 * no DB or session; the real 403-redirect behavior needs a browser). Same pattern as the Money
 * route's page.test.ts.
 */
describe('FinOps route — RBAC gate', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('calls requireRouteRoles(MANAGE_MONEY_ROLES) before rendering <Finops />', () => {
    const gateIndex = src.indexOf('requireRouteRoles(MANAGE_MONEY_ROLES)')
    const renderIndex = src.indexOf('<Finops')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(renderIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(renderIndex)
  })

  it('imports MANAGE_MONEY_ROLES from @marginfront/db and requireRouteRoles from the shared helper', () => {
    expect(src).toMatch(/MANAGE_MONEY_ROLES/)
    expect(src).toMatch(/from ['"]@marginfront\/db['"]/)
    expect(src).toMatch(/from ['"]@\/app\/lib\/require-route-roles['"]/)
  })

  it('stays a thin server wrapper — no mf-* classes (Tailwind scans src/** only)', () => {
    expect(src).not.toMatch(/\bmf-/)
    expect(src).not.toMatch(/'use client'/)
  })
})
