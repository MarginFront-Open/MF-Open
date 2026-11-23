/**
 * Settings has no shared layout.tsx. Each route wraps ITSELF in <Settings>,
 * AFTER any requireRouteRoles() call, the same structural position as
 * app/(dashboard)/money/page.tsx. A 'use client' layout around the gated
 * routes starts streaming before requireRouteRoles() can redirect, and Next's
 * router crashes ("Rendered more hooks than during the previous render")
 * instead of serving the /403 page. Source-assertion, not a render test — this
 * repo's dashboard jest is node-only (no RTL), and Settings depends on
 * client-only hooks (usePathname, useCurrentOrganization) it can't render
 * (same constraint as settings-tabs.test.ts).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const DASHBOARD_ROOT = join(__dirname, '..', '..', '..', '..')
const SETTINGS_APP_DIR = join(DASHBOARD_ROOT, 'app', '(dashboard)', 'settings')

function readRoute(...segments: string[]): string {
  return readFileSync(join(SETTINGS_APP_DIR, ...segments), 'utf8')
}

describe('settings has no shared layout file', () => {
  it('has no settings/layout.tsx', () => {
    expect(existsSync(join(SETTINGS_APP_DIR, 'layout.tsx'))).toBe(false)
  })
})

describe('every settings route wraps itself in the Settings shell', () => {
  it.each([
    ['page.tsx'],
    ['profile', 'page.tsx'],
    ['team', 'page.tsx'],
    ['billing', 'page.tsx'],
    ['integrations', 'page.tsx'],
  ])('%s renders <Settings>...</Settings>', (...segments) => {
    const src = readRoute(...segments)
    expect(src).toMatch(/import Settings from '@\/features\/settings'/)
    expect(src).toMatch(/<Settings>[\s\S]*<\/Settings>/)
  })
})

describe('the three org-managed routes call requireRouteRoles(ORG_MANAGE_ROLES) BEFORE returning the Settings-wrapped feature', () => {
  it.each([['team'], ['billing'], ['integrations']])(
    '%s/page.tsx gates before it renders',
    (dir) => {
      const src = readRoute(dir, 'page.tsx')
      const gateIndex = src.indexOf('await requireRouteRoles(ORG_MANAGE_ROLES)')
      const settingsIndex = src.indexOf('<Settings>')
      expect(gateIndex).toBeGreaterThan(-1)
      expect(settingsIndex).toBeGreaterThan(gateIndex)
    }
  )

  it('the three gated routes import ORG_MANAGE_ROLES from @marginfront/db', () => {
    for (const dir of ['team', 'billing', 'integrations']) {
      const src = readRoute(dir, 'page.tsx')
      expect(src).toMatch(
        /import \{ ORG_MANAGE_ROLES \} from '@marginfront\/db'/
      )
    }
  })
})

describe('the two ungated routes carry no route-role gate', () => {
  it.each([['page.tsx'], ['profile', 'page.tsx']])(
    '%s has no requireRouteRoles call',
    (...segments) => {
      const src = readRoute(...segments)
      expect(src).not.toMatch(/requireRouteRoles/)
    }
  )
})
