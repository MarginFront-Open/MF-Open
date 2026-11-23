import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The Settings tab bar: /settings/billing has a tab, and there is no
 * Preferences tab (theme lives in the header user menu).
 * Source-assertion, not a render test — Settings depends on
 * useCurrentOrganization/usePathname, client-only hooks this repo's
 * Node-only jest can't render (same constraint as sidebar-data.test.ts).
 */
describe('settings tab bar — Billing reachable, no Preferences tab', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('lists NO Preferences tab and the route redirects to /settings/profile', () => {
    expect(src).not.toMatch(/PREFERENCES/)
    expect(src).not.toMatch(/settings\/preferences/)
    const routeSrc = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'app',
        '(dashboard)',
        'settings',
        'preferences',
        'page.tsx'
      ),
      'utf8'
    )
    expect(routeSrc).toMatch(/redirect\('\/settings\/profile'\)/)
    expect(routeSrc).not.toMatch(/PreferencesSettings|appearance/i)
  })

  it('lists a Billing tab pointing at /settings/billing, gated by the existing BILLING permission', () => {
    const tabsBlock = src.slice(src.indexOf('const settingsTabs'))
    expect(tabsBlock).toMatch(
      /key:\s*'BILLING'[\s\S]*?href:\s*'\/settings\/billing'/
    )
  })

  it('lists the Profile, Team and Integrations tabs', () => {
    const tabsBlock = src.slice(src.indexOf('const settingsTabs'))
    for (const [key, href] of [
      ['PROFILE', '/settings/profile'],
      ['TEAM', '/settings/team'],
      ['INTEGRATIONS', '/settings/integrations'],
    ]) {
      expect(tabsBlock).toMatch(
        new RegExp(
          `key:\\s*'${key}'[\\s\\S]*?href:\\s*'${href.replace('/', '\\/')}'`
        )
      )
    }
  })

  it('org-management tabs (TEAM/BILLING/INTEGRATIONS) each have a real allow-list in SETTINGS_PERMISSIONS', () => {
    const permissionsSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'lib', 'permissions.ts'),
      'utf8'
    )
    for (const key of ['TEAM', 'BILLING', 'INTEGRATIONS']) {
      expect(permissionsSrc).toMatch(new RegExp(`${key}:\\s*\\{`))
    }
  })

  // PROFILE and PREFERENCES carry no allow-list. The tab filter treats a
  // missing key as "no restriction, always visible" (`permission ?
  // hasPermission(...) : true`), and every org member manages their own
  // profile and preferences regardless of role. An allow-list here would
  // silently hide the tab from whichever role it leaves out.
  it('PROFILE and PREFERENCES have NO entry in SETTINGS_PERMISSIONS (deliberately ungated for every role)', () => {
    const permissionsSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'lib', 'permissions.ts'),
      'utf8'
    )
    expect(permissionsSrc).not.toMatch(/PROFILE:\s*\{/)
    expect(permissionsSrc).not.toMatch(/PREFERENCES:\s*\{/)
  })
})
