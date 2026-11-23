import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * RBAC posture for the /roi route, source-asserted (this unit suite has no
 * DB or session; the real 403-redirect behavior needs a browser). ROI is
 * gated MANAGE_MONEY_ROLES because its cards render revenue/margin actuals,
 * the exact class the Money/FinOps routes gate. To make it ungated, flip the
 * first assertion (the Build page.test.ts pattern documents the ungated form).
 */
describe('ROI route — RBAC gate', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('calls requireRouteRoles(MANAGE_MONEY_ROLES) before rendering <Roi />', () => {
    const gateIndex = src.indexOf('requireRouteRoles(MANAGE_MONEY_ROLES)')
    const renderIndex = src.indexOf('<Roi')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(renderIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(renderIndex)
  })

  it('imports MANAGE_MONEY_ROLES from @marginfront/db and requireRouteRoles from the shared helper', () => {
    expect(src).toMatch(/MANAGE_MONEY_ROLES/)
    expect(src).toMatch(/from ['"]@marginfront\/db['"]/)
    expect(src).toMatch(/from ['"]@\/app\/lib\/require-route-roles['"]/)
  })

  it('renders the feature module and nothing else', () => {
    expect(src).toMatch(/from '@\/features\/roi'/)
  })

  it('stays a thin server wrapper — no classes (Tailwind scans src/** only), no client directive', () => {
    expect(src).not.toMatch(/className/)
    expect(src).not.toMatch(/'use client'/)
  })
})
