/**
 * Breadcrumbs render from the global layout
 * context (src/context/layout-context.tsx) and only change when something
 * calls updateOptions(). The Page wrapper does this in a mount effect; the
 * 5 command pages (Money/ROI/MF IQ/FinOps/Build) use PageShell instead, so
 * PageShell must write the context too, or navigating between them leaves
 * the breadcrumb frozen on whichever page loaded first. Source-assertion,
 * not a render test — this repo's Node-only jest has no RTL.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(__dirname, '..', 'page-shell.tsx'), 'utf8')

describe('PageShell — writes breadcrumbs into the layout context on every render', () => {
  it('imports useLayout from the layout context', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*useLayout\s*\}\s*from\s*'@\/context\/layout-context'/
    )
  })

  it('calls updateOptions(...) inside a useEffect (not at render time)', () => {
    const effectMatch = SRC.match(
      /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?updateOptions\([\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\)/
    )
    expect(effectMatch).not.toBeNull()
  })

  it('keys the effect on the title prop, so it re-fires on every navigation between command pages', () => {
    const effectMatch = SRC.match(
      /useEffect\([\s\S]*?\}\s*,\s*(\[[^\]]*\])\s*\)/
    )
    expect(effectMatch).not.toBeNull()
    expect(effectMatch![1]).toMatch(/\btitle\b/)
  })

  it('writes pageTitle alongside breadcrumbs, same as Page, so nothing reads stale pageTitle state', () => {
    expect(SRC).toMatch(/pageTitle:\s*title/)
  })

  it('breadcrumb items use the layout-context shape ({title, href, isCurrent}), not {name, href}', () => {
    expect(SRC).toMatch(/breadcrumbs:\s*\[/)
    expect(SRC).not.toMatch(/\{\s*name:\s*['"]Home['"]/)
  })
})
