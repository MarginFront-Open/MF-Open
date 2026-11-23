import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Locks the five command-center routes into the sidebar so they can't
 * silently disappear in an edit.
 *
 * Source-assertion, not a render test: sidebar-data.ts is consumed by
 * app-sidebar.tsx/nav-group.tsx, which lean on client-only hooks
 * (useSidebar/useAuth) this repo's Node-only jest can't
 * render (same reason nav-visibility.test.ts tests the pure function instead
 * of <NavGroup>). readFileSync keeps this test render-free while still
 * failing the instant someone deletes a route or the group label.
 */
describe('sidebar-data — Command Center group', () => {
  const src = readFileSync(
    join(__dirname, '..', 'data', 'sidebar-data.ts'),
    'utf8'
  )

  it('has a "Command Center" nav group', () => {
    expect(src).toMatch(/title:\s*'Command Center'/)
  })

  it('links all five command-center routes', () => {
    for (const route of ['/money', '/finops', '/build', '/roi', '/mfiq']) {
      expect(src).toContain(`url: '${route}'`)
    }
  })

  it('gates Money/FinOps/ROI/MF IQ to finance/admin/owner, matching each route’s requireRouteRoles(MANAGE_MONEY_ROLES) guard', () => {
    // Slice the Command Center group out of the file so these assertions
    // can't accidentally pass by matching another group's requiredRoles.
    const groupStart = src.indexOf("title: 'Command Center'")
    const groupEnd = src.indexOf('// ---------- LEARN ----------')
    expect(groupStart).toBeGreaterThan(-1)
    expect(groupEnd).toBeGreaterThan(groupStart)
    const group = src.slice(groupStart, groupEnd)

    for (const route of ['/money', '/finops', '/roi', '/mfiq']) {
      const urlIndex = group.indexOf(`url: '${route}'`)
      expect(urlIndex).toBeGreaterThan(-1)
      // requiredRoles for this entry should appear before the next entry
      // starts (i.e. it's attached to THIS item, not a later one).
      const nextEntryIndex = group.indexOf('{', urlIndex + 1)
      const roleGateIndex = group.indexOf(
        "requiredRoles: ['finance', 'admin', 'owner']",
        urlIndex
      )
      expect(roleGateIndex).toBeGreaterThan(-1)
      if (nextEntryIndex !== -1) {
        expect(roleGateIndex).toBeLessThan(nextEntryIndex)
      }
    }
  })

  it('does not role-gate Build (route has no requireRouteRoles)', () => {
    const groupStart = src.indexOf("title: 'Command Center'")
    const groupEnd = src.indexOf('// ---------- LEARN ----------')
    const group = src.slice(groupStart, groupEnd)

    const buildUrlIndex = group.indexOf("url: '/build'")
    expect(buildUrlIndex).toBeGreaterThan(-1)
    const nextEntryIndex = group.indexOf('{', buildUrlIndex + 1)
    const buildEntry = group.slice(
      buildUrlIndex,
      nextEntryIndex === -1 ? undefined : nextEntryIndex
    )
    expect(buildEntry).not.toMatch(/requiredRoles/)
  })

  it('places the Command Center group before the slim Learn group', () => {
    const commandCenterIndex = src.indexOf("title: 'Command Center'")
    const learnGroupIndex = src.indexOf('// ---------- LEARN ----------')
    expect(commandCenterIndex).toBeGreaterThan(-1)
    expect(learnGroupIndex).toBeGreaterThan(-1)
    expect(commandCenterIndex).toBeLessThan(learnGroupIndex)
  })

  it('the slim Learn group offers only Getting Started + the operator docs link', () => {
    expect(src).toContain(`url: '/developer-zone/getting-started'`)
    expect(src).toContain('url: OPERATOR_DOCS_URL')
    expect(src).not.toContain('docs.marginfront.com')
  })

  // The Operate/FinOps/Monetize/Collect groups and the API Keys + SDK
  // Simulator entries are not in the sidebar. Some of those routes are
  // redirects (/agents → /build, /developer-zone/api-keys → /build?tab=keys);
  // none of them may appear as a sidebar url.
  it('omits the Home and Operate entries (routes stay reachable off-nav)', () => {
    expect(src).not.toContain('Home (legacy)')
    expect(src).not.toContain("title: 'Operate'")
    for (const route of [
      '/customers',
      '/agents',
      '/metrics-events',
      '/cost-management',
      '/month-end-close',
      '/finops-settings',
      '/subscriptions',
      '/invoices',
      '/developer-zone/api-keys',
      '/developer-zone/sdk-simulator',
    ]) {
      expect(src).not.toContain(`url: '${route}'`)
    }
  })
})

// Command Center item titles (/money is Unit Economics, /finops is AI
// Accounting), the Internal AI Spend entry, and the Learn group, which keeps
// any label from appearing twice.
describe('sidebar-data — Command Center titles + Internal AI Spend', () => {
  const src = readFileSync(
    join(__dirname, '..', 'data', 'sidebar-data.ts'),
    'utf8'
  )

  it('titles the /money and /finops items Unit Economics / AI Accounting', () => {
    expect(src).toMatch(/title:\s*'Unit Economics'/)
    expect(src).toMatch(/title:\s*'AI Accounting'/)
    expect(src).not.toMatch(/title:\s*'Money'/)
    expect(src).not.toMatch(/title:\s*'FinOps'/)
  })

  it('uses /money and /finops as the hrefs', () => {
    expect(src).toContain("url: '/money'")
    expect(src).toContain("url: '/finops'")
  })

  it("links Internal AI Spend to the real route '/internal-ai-spend'", () => {
    expect(src).toMatch(/title:\s*'Internal AI Spend'/)
    expect(src).toContain("url: '/internal-ai-spend'")
    // The spend-controls deep link stays out of the nav: a next.config.ts
    // redirect owns it.
    expect(src).not.toContain('/money?tab=spend-controls')
  })

  it('places Internal AI Spend after AI Accounting and before Build, with the Money role gate', () => {
    const accountingIndex = src.indexOf("title: 'AI Accounting'")
    const spendIndex = src.indexOf("title: 'Internal AI Spend'")
    const buildIndex = src.indexOf("title: 'Build'")
    expect(accountingIndex).toBeGreaterThan(-1)
    expect(spendIndex).toBeGreaterThan(accountingIndex)
    expect(buildIndex).toBeGreaterThan(spendIndex)

    const urlIndex = src.indexOf("url: '/internal-ai-spend'")
    const nextEntryIndex = src.indexOf('{', urlIndex)
    const roleGateIndex = src.indexOf(
      "requiredRoles: ['finance', 'admin', 'owner']",
      urlIndex
    )
    expect(roleGateIndex).toBeGreaterThan(-1)
    expect(roleGateIndex).toBeLessThan(nextEntryIndex)
  })

  it('the Unit Economics entry carries the Invoices & Overdue description (hover title)', () => {
    const start = src.indexOf("title: 'Unit Economics'")
    const end = src.indexOf("title: 'AI Accounting'")
    const entry = src.slice(start, end)
    expect(entry).toContain("description: 'Includes Invoices and Overdue'")
  })

  it('no label appears twice anywhere in the nav', () => {
    const groupTitles = [
      ...src.matchAll(/title:\s*'([^']+)',\s*\n\s*items:\s*\[/g),
    ].map((m) => m[1])
    expect(groupTitles).toEqual(['Command Center', 'Learn'])

    const allTitles = [...src.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1])
    const duplicates = allTitles.filter(
      (title, index) => allTitles.indexOf(title) !== index
    )
    expect(duplicates).toEqual([])
  })
})
