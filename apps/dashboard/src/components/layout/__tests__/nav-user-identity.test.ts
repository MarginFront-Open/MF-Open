import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * The sidebar must never fall back to a hardcoded template demo identity
 * while the real session loads, or a live user could briefly see a stranger's
 * name/email in the sidebar footer. NavUser shows a loading skeleton instead
 * and sidebar-data.ts carries no static identity. This is a tree-wide source
 * assertion (not a render test: NavUser depends on client-only hooks this
 * repo's Node-only jest can't render, same reasoning as sidebar-data.test.ts)
 * that the template's demo username never appears.
 */

const SRC_DIR = join(__dirname, '..', '..', '..')

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

describe('no shadcn-template demo identity anywhere in src/', () => {
  const files = walkSourceFiles(SRC_DIR)

  it('found at least one source file to scan (sanity check on the walker)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('no file under src/ contains the string "satnaing"', () => {
    const offenders = files.filter((f) =>
      readFileSync(f, 'utf8').toLowerCase().includes('satnaing')
    )
    expect(offenders).toEqual([])
  })

  it('sidebar-data.ts exports no static `user` field', () => {
    const src = readFileSync(
      join(SRC_DIR, 'components', 'layout', 'data', 'sidebar-data.ts'),
      'utf8'
    )
    expect(src).not.toMatch(/^\s*user:\s*\{/m)
  })
})

describe('NavUser — no user prop, real identity or nothing', () => {
  const src = readFileSync(
    join(SRC_DIR, 'components', 'layout', 'nav-user.tsx'),
    'utf8'
  )

  it('takes no static `user` prop (identity comes only from useAuth())', () => {
    expect(src).not.toMatch(/function NavUser\(\s*\{\s*user\s*\}/)
  })

  it('renders a loading skeleton while the session is resolving instead of a fallback prop', () => {
    expect(src).toMatch(/isLoading \|\| !userData/)
    expect(src).toMatch(/<Skeleton/)
  })
})
