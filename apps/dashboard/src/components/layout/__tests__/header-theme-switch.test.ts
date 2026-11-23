import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The header carries the light/dark toggle, not only /settings/preferences.
 * Source-assertion, not a render test (dashboard
 * jest is node-only, no RTL — same reason sidebar-data.test.ts reads the
 * file instead of mounting <AppSidebar>): header.tsx is consumed inside
 * DashboardClientLayout's client tree, which this repo's Node-only jest
 * can't render.
 */
describe('header.tsx — surfaces the theme toggle', () => {
  const src = readFileSync(join(__dirname, '..', 'header.tsx'), 'utf8')

  it('imports the existing ThemeSwitch component (does not reinvent one)', () => {
    expect(src).toMatch(
      /import\s*\{\s*ThemeSwitch\s*\}\s*from\s*'@\/components\/theme-switch'/
    )
  })

  it('renders <ThemeSwitch /> in the header', () => {
    expect(src).toMatch(/<ThemeSwitch\s*\/>/)
  })
})
