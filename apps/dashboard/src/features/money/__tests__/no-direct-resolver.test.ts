import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * ResolveMetrics stays behind
 * DimensionedSection's one call site. Money's own files must never import
 * or call it directly; the ONLY way data reaches this page is through
 * <DimensionedSection>'s renderKpiRow render-prop. Mirrors dashboard-shell's
 * own shell-safety.test.ts pattern, scoped to this dir.
 */
const FEATURE_DIR = join(__dirname, '..')
const RESOLVE_METRICS_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bresolveMetrics\b[^}]*\}\s*from/
const RESOLVE_METRICS_CALL = /\bresolveMetrics\s*\(/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('src/features/money/** — no direct resolveMetrics reference', () => {
  const files = walk(FEATURE_DIR)

  it('has at least one file to check (guards against a silently-empty suite)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files.map((f) => f.replace(FEATURE_DIR, '')))('%s', (relPath) => {
    const src = readFileSync(join(FEATURE_DIR, relPath.slice(1)), 'utf8')
    expect(src).not.toMatch(RESOLVE_METRICS_IMPORT)
    expect(src).not.toMatch(RESOLVE_METRICS_CALL)
  })
})
