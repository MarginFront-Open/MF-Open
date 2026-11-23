/**
 * Two source-asserted contracts:
 *
 *   1. Shell safety: page-shell.tsx is a CLIENT component with zero
 *      auth logic — RBAC stays in the server page.tsx above it
 *      (requireRouteRoles).
 *   2. Single-call invariant: dimensioned-section.tsx is
 *      the ONLY shell file that references resolveMetrics;
 *      tiles/* stay props-pure, with no resolveMetrics reference and no
 *      app/actions import at all.
 *
 * The "exactly one call" assertion below skips if dimensioned-section.tsx
 * is missing; the tree-wide "nobody else references resolveMetrics" checks
 * run unconditionally and do not depend on the file existing.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const SHELL_DIR = join(__dirname, '..')
const TILES_DIR = join(SHELL_DIR, 'tiles')
const DIMENSIONED_SECTION_PATH = join(SHELL_DIR, 'dimensioned-section.tsx')

// ── page-shell.tsx never touches auth ──────────────────────────────

describe('page-shell.tsx — auth-free by construction', () => {
  const src = readFileSync(join(SHELL_DIR, 'page-shell.tsx'), 'utf8')
  const importLines = src
    .split('\n')
    .filter((line) => line.trim().startsWith('import'))

  it('imports no auth module (@/app/lib/auth* or require-route-roles)', () => {
    for (const line of importLines) {
      expect(line).not.toMatch(/require-route-roles/)
      expect(line).not.toMatch(/['"]@\/app\/lib\/auth/)
    }
  })

  it('never calls an RBAC guard directly (requireRouteRoles/assertMoneyManager/assertBuildManager)', () => {
    expect(src).not.toMatch(/requireRouteRoles\s*\(/)
    expect(src).not.toMatch(/assertMoneyManager|assertBuildManager/)
  })
})

// ── single-call invariant ───────────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

// Matches an actual import-of or call-to resolveMetrics — deliberately NOT
// a bare substring check, because date-range.ts and catalog-preview.tsx
// legitimately MENTION "resolveMetrics" in doc comments / preview copy
// without importing or calling it.
const RESOLVE_METRICS_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bresolveMetrics\b[^}]*\}\s*from/
const RESOLVE_METRICS_CALL = /\bresolveMetrics\s*\(/

describe('single-call invariant — resolveMetrics stays behind one call site', () => {
  const dimensionedSectionExists = existsSync(DIMENSIONED_SECTION_PATH)
  const otherFiles = walkTsFiles(SHELL_DIR).filter(
    (f) => f !== DIMENSIONED_SECTION_PATH
  )

  it.each(otherFiles.map((f) => relative(SHELL_DIR, f)))(
    '%s does not import or call resolveMetrics',
    (relPath) => {
      const src = readFileSync(join(SHELL_DIR, relPath), 'utf8')
      expect(src).not.toMatch(RESOLVE_METRICS_IMPORT)
      expect(src).not.toMatch(RESOLVE_METRICS_CALL)
    }
  )

  if (dimensionedSectionExists) {
    it('dimensioned-section.tsx makes exactly ONE resolveMetrics call', () => {
      const src = readFileSync(DIMENSIONED_SECTION_PATH, 'utf8')
      // The component takes an injectable `resolve = resolveMetrics` default
      // param (its own doc comment: "what makes the single-call invariant
      // unit-testable" — tests/preview swap in a fixture function of the
      // same shape). The real call site is therefore `resolve(...)`, not a
      // literal `resolveMetrics(...)` — count BOTH spellings so the check
      // holds whether a future edit calls the import directly or via the
      // injected alias, and still fails if either spelling appears twice.
      const directCalls = src.match(/\bresolveMetrics\s*\(/g) ?? []
      const injectedCalls = src.match(/\bresolve\s*\(/g) ?? []
      expect(directCalls.length + injectedCalls.length).toBe(1)
    })
  } else {
    it.skip('dimensioned-section.tsx makes exactly ONE resolveMetrics call (skipped: file not present)', () => {})
  }
})

describe('tiles/* — props-pure, no data fetching', () => {
  const tileFiles = readdirSync(TILES_DIR).filter((f) => /\.(ts|tsx)$/.test(f))

  it.each(tileFiles)(
    '%s references neither resolveMetrics nor app/actions',
    (file) => {
      const src = readFileSync(join(TILES_DIR, file), 'utf8')
      expect(src).not.toMatch(/resolveMetrics/)
      expect(src).not.toMatch(/app\/actions/)
    }
  )
})
