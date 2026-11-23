import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * RBAC posture for the Internal AI Spend route, source-asserted
 * (this unit suite has no DB or session; requireRouteRoles' own redirect
 * behavior is tested in app/lib/__tests__/require-route-roles.test.ts). Same pattern as the money route's page.test.ts.
 */
describe('Internal AI Spend route — RBAC gate', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('calls requireRouteRoles(MANAGE_MONEY_ROLES) before rendering <InternalAiSpend />', () => {
    const gateIndex = src.indexOf('requireRouteRoles(MANAGE_MONEY_ROLES)')
    const renderIndex = src.indexOf('<InternalAiSpend')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(renderIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeLessThan(renderIndex)
  })

  it('imports MANAGE_MONEY_ROLES from @marginfront/db and requireRouteRoles from the shared helper', () => {
    expect(src).toMatch(/MANAGE_MONEY_ROLES/)
    expect(src).toMatch(/from ['"]@marginfront\/db['"]/)
    expect(src).toMatch(/from ['"]@\/app\/lib\/require-route-roles['"]/)
  })
})
