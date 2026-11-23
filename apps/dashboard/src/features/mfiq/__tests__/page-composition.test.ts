/**
 * MF IQ page-composition facts, source-
 * asserted (dashboard jest is node-only, no RTL). Each assertion pins a
 * contract a later refactor could silently break:
 *
 *   - single-data-path: getMfiqStatus is the page's ONLY action import and
 *     ONLY fetch — no resolver, no writes, no layout persistence.
 *   - bespoke posture: no TileGrid, no DimensionedSection, no
 *     useSearchParams, editable={false}.
 *   - derivation-only rendering: every rule chip, fix, rec, and alert item
 *     arrives pre-composed from deriveIqScore — the components decide and
 *     format nothing, and the page adds no hrefs of its own (the hrefs are
 *     pinned behaviorally in iq-derivation.test.ts).
 *   - honesty: a null score is passed through verbatim (never coalesced to
 *     a number) and surfaces the unknown-count line.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const FEATURE_DIR = join(__dirname, '..')

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

const featureFiles = walkTsFiles(FEATURE_DIR)
const indexSrc = readFileSync(join(FEATURE_DIR, 'index.tsx'), 'utf8')
const rulesListSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'rules-list.tsx'),
  'utf8'
)

describe('single-data-path invariant', () => {
  it.each(featureFiles.map((f) => f.slice(FEATURE_DIR.length + 1)))(
    '%s never references the metrics resolver',
    (relPath) => {
      const src = readFileSync(join(FEATURE_DIR, relPath), 'utf8')
      expect(src).not.toMatch(/resolveMetrics/)
    }
  )

  // The "Customer alerts" card adds
  // customer-alert-notifications, which owns the notification feed read + the
  // mark-read write, its own failure domain beside getMfiqStatus. The list is
  // NOT open to arbitrary actions.
  const ACTION_ALLOW_LIST = [
    '@/app/actions/mfiq-status',
    '@/app/actions/customer-alert-notifications',
  ]

  it('imports ONLY its two sanctioned actions feature-wide — mfiq-status and customer-alert-notifications', () => {
    for (const file of featureFiles) {
      const src = readFileSync(file, 'utf8')
      const actionImports = src.match(/@\/app\/actions\/[\w-]+/g) ?? []
      for (const specifier of actionImports) {
        expect(ACTION_ALLOW_LIST).toContain(specifier)
      }
    }
  })

  it('index.tsx calls getMfiqStatus exactly once', () => {
    expect(indexSrc.split('getMfiqStatus(').length - 1).toBe(1)
  })

  it('never touches layout persistence', () => {
    for (const file of featureFiles) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/dashboard-layouts/)
    }
  })
})

describe('index.tsx — bespoke four-card posture', () => {
  it('renders NO TileGrid and NO DimensionedSection', () => {
    expect(indexSrc).not.toMatch(/TileGrid/)
    expect(indexSrc).not.toMatch(/DimensionedSection/)
  })

  it('has no URL-coupled state — no useSearchParams, no Suspense', () => {
    expect(indexSrc).not.toMatch(/useSearchParams/)
    expect(indexSrc).not.toMatch(/Suspense/)
  })

  it('passes editable={false} to PageShell (matches PAGE_META.mfiq — no edit affordance)', () => {
    expect(indexSrc).toMatch(/editable=\{false\}/)
  })

  it("ships the visible badge literal 'Rules-based. $0 in tokens.'", () => {
    expect(indexSrc).toMatch(/badge='Rules-based\. \$0 in tokens\.'/)
  })

  it('subtitle comes from the derivation, never a hardcoded string', () => {
    expect(indexSrc).toMatch(/subtitle=\{derived\?\.subtitle\}/)
    expect(indexSrc).not.toMatch(/Score last updated/)
  })
})

describe('index.tsx — everything renders from deriveIqScore', () => {
  it('passes rules, fixes, recommendations, and needs-attention verbatim from the derivation', () => {
    expect(indexSrc).toMatch(/rules=\{derived\?\.rules \?\? \[\]\}/)
    expect(indexSrc).toMatch(/fixes=\{derived\?\.fixes\}/)
    expect(indexSrc).toMatch(/items=\{derived\?\.recommendations \?\? \[\]\}/)
    expect(indexSrc).toMatch(/items=\{derived\?\.needsAttention \?\? \[\]\}/)
  })

  it('adds no hrefs of its own — every link arrives inside a derived item', () => {
    expect(indexSrc).not.toMatch(/href=/)
  })

  it('composes no alert/rec copy inline (no severity literals outside the derivation)', () => {
    expect(indexSrc).not.toMatch(/severity:/)
  })
})

describe('index.tsx — null-score honesty', () => {
  it('passes score through verbatim — null is never coalesced to a number', () => {
    expect(indexSrc).toMatch(/value=\{derived \? derived\.score : null\}/)
    expect(indexSrc).not.toMatch(/score \?\? \d/)
  })

  it('surfaces the unknown-count honesty line in the gauge label slot', () => {
    expect(indexSrc).toMatch(/unknownCount/)
    expect(indexSrc).toMatch(/no data/)
  })

  it('renders a page-level error state from the action message — a failed compose is never an empty 10/10', () => {
    expect(indexSrc).toMatch(/setState\('error'\)/)
    expect(indexSrc).toMatch(/result\.error \?\? MFIQ_ERROR/)
  })

  it('guards the mount fetch against a cancelled unmount (the FinOps pattern)', () => {
    expect(indexSrc).toMatch(/let cancelled = false/)
    expect(indexSrc).toMatch(/cancelled = true/)
  })
})

describe('rules-list.tsx — chips from derivation only', () => {
  it('styles chips through a TOTAL Record over IqRuleStatus (new status = compile error)', () => {
    expect(rulesListSrc).toMatch(/Record<IqRuleStatus/)
  })

  it('pins the four chip labels exactly: Pass, Review, Fail, No data', () => {
    expect(rulesListSrc).toMatch(/label: 'Pass'/)
    expect(rulesListSrc).toMatch(/label: 'Review'/)
    expect(rulesListSrc).toMatch(/label: 'Fail'/)
    expect(rulesListSrc).toMatch(/label: 'No data'/)
  })

  it('re-derives nothing — no scoring import, no money formatting, no status arithmetic', () => {
    expect(rulesListSrc).not.toMatch(/deriveIqScore/)
    expect(rulesListSrc).not.toMatch(/IQ_RULE_POINTS/)
    expect(rulesListSrc).not.toMatch(/formatCost|formatPct/)
    expect(rulesListSrc).not.toMatch(/\.toFixed\(/)
  })
})
