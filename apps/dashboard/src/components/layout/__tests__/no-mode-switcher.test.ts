import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * The sidebar has no dashboard-mode dropdown (ModeSwitcher) and no mode
 * gate: nav items are gated by role only. This pins that absence. It is a
 * source assertion, not a render test: these components lean on client-only
 * hooks (useSidebar/useAuth) this repo's Node-only jest can't render (same
 * reasoning as nav-user-identity.test.ts / nav-visibility.test.ts).
 */

const LAYOUT_DIR = join(__dirname, '..')
const SRC_DIR = join(LAYOUT_DIR, '..', '..')

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('the sidebar has no dashboard-mode switcher', () => {
  it('mode-switcher.tsx does not exist', () => {
    expect(existsSync(join(LAYOUT_DIR, 'mode-switcher.tsx'))).toBe(false)
  })

  it('explore-more-link.tsx does not exist', () => {
    expect(existsSync(join(LAYOUT_DIR, 'explore-more-link.tsx'))).toBe(false)
  })

  it('there is no dashboard-mode read hook', () => {
    expect(existsSync(join(SRC_DIR, 'hooks', 'use-dashboard-mode.ts'))).toBe(
      false
    )
  })

  it('app-sidebar.tsx does not render <ModeSwitcher>', () => {
    const src = readFileSync(join(LAYOUT_DIR, 'app-sidebar.tsx'), 'utf8')
    expect(src).not.toMatch(/ModeSwitcher/)
  })

  it('no source file under src/ imports a ModeSwitcher or explore-more-link', () => {
    const offenders = walkSourceFiles(SRC_DIR).filter((f) => {
      const contents = readFileSync(f, 'utf8')
      return (
        /from ['"].*mode-switcher['"]/.test(contents) ||
        /from ['"].*explore-more-link['"]/.test(contents)
      )
    })
    expect(offenders).toEqual([])
  })

  it('nav-group.tsx has no teaser branch', () => {
    const src = readFileSync(join(LAYOUT_DIR, 'nav-group.tsx'), 'utf8')
    expect(src).not.toMatch(/teaserConfig/)
    expect(src).not.toMatch(/useDashboardMode/)
  })

  it('types.ts carries no requiredModes or teaserConfig', () => {
    const src = readFileSync(join(LAYOUT_DIR, 'types.ts'), 'utf8')
    expect(src).not.toMatch(/requiredModes/)
    expect(src).not.toMatch(/teaserConfig/)
    // The role gate stays: it's load-bearing for Money/FinOps/ROI/MFIQ.
    expect(src).toMatch(/requiredRoles/)
  })
})
