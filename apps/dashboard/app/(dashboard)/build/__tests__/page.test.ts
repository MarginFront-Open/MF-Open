/**
 * The /build route wrapper. /build is deliberately view-ungated: any member
 * can view it. Writes stay assertBuildManager-gated
 * server-side. To gate viewing, flip the first assertion to require
 * requireRouteRoles(MANAGE_BUILD_ROLES), the money-page pattern.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const pageSrc = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('app/(dashboard)/build/page.tsx — thin ungated wrapper', () => {
  it('has NO route role gate', () => {
    expect(pageSrc).not.toMatch(/requireRouteRoles\s*\(/)
  })

  it('renders the feature module and nothing else', () => {
    expect(pageSrc).toMatch(/from '@\/features\/build'/)
  })

  it('stays classless — Tailwind scans src/** only, so classes here would silently not compile', () => {
    expect(pageSrc).not.toMatch(/className/)
  })
})
