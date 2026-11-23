/**
 * ROI page-composition facts, source-asserted
 * (dashboard jest is node-only, no RTL). Modeled on build/finops
 * page-composition tests. Each assertion pins a contract a later refactor
 * could silently break: the no-catalog rule, the single
 * getRoiOverview data path, the amber at-risk
 * treatment, and the replace-all dialog contract (an edit that drops
 * baselineValue must be impossible).
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const FEATURE_DIR = join(__dirname, '..')

/** The span of the ONE `no-print` wrapper the page's screen
 * content lives inside, read by div depth rather than by a fixed offset. */
function noPrintSpan(src: string): { open: number; close: number } {
  const open = src.indexOf("<div className='no-print'>")
  expect(open).toBeGreaterThan(-1)
  let depth = 0
  const tags = /<div\b[^>]*>|<\/div>/g
  tags.lastIndex = open
  let match: RegExpExecArray | null
  while ((match = tags.exec(src))) {
    if (match[0] === '</div>') depth -= 1
    // `<div />` opens and closes in one tag; counting it as an opener leaves
    // the walker one level deep forever.
    else if (!match[0].endsWith('/>')) depth += 1
    if (depth === 0) return { open, close: match.index }
  }
  throw new Error('the no-print wrapper never closes')
}

const insideNoPrint = (src: string, needle: string) => {
  const at = src.indexOf(needle)
  expect(at).toBeGreaterThan(-1)
  const span = noPrintSpan(src)
  return at > span.open && at < span.close
}

const RESOLVE_METRICS_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bresolveMetrics\b[^}]*\}\s*from/
const RESOLVE_METRICS_CALL = /\bresolveMetrics\s*\(/

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
const cardSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'initiative-card.tsx'),
  'utf8'
)
const dialogSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'initiative-dialog.tsx'),
  'utf8'
)
const statusMapsSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'status-maps.ts'),
  'utf8'
)

/** Doc mentions are fine; imports/calls are not — ban checks run on code only. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every '@/app/actions/<module>' this file references, deduped. */
function actionModules(src: string): string[] {
  return [
    ...new Set(
      [...src.matchAll(/from '@\/app\/actions\/([^']+)'/g)].map((m) => m[1])
    ),
  ].sort()
}

/** [^}] and not [\s\S]: a lazy any-character pair bridges two separate
 * import statements, which would let INITIATIVE_METRIC_META move to another
 * module and keep this green. */
const METRIC_META_IMPORT =
  /import \{[^}]*?\bINITIATIVE_METRIC_META\b[^}]*?\} from '\.\.\/progress-derivation'/

/** The value of one JSX attribute, read by balanced braces rather than a
 * fixed offset, so a prettier reflow cannot silently widen these slices. */
const jsxAttribute = (src: string, attribute: string) => {
  const opener = `${attribute}={`
  const start = src.indexOf(opener)
  expect(start).toBeGreaterThan(-1)
  let cursor = start + opener.length
  let depth = 1
  while (depth > 0 && cursor < src.length) {
    const char = src[cursor]
    cursor += 1
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
  }
  expect(depth).toBe(0)
  return src.slice(start + opener.length, cursor - 1)
}

describe('single-data-path invariant — never the resolver', () => {
  it('has files to check (guards against a silently-empty suite)', () => {
    expect(featureFiles.length).toBeGreaterThan(0)
  })

  it.each(featureFiles.map((f) => f.slice(FEATURE_DIR.length + 1)))(
    '%s never imports or calls the metrics resolver',
    (relPath) => {
      const src = readFileSync(join(FEATURE_DIR, relPath), 'utf8')
      expect(src).not.toMatch(RESOLVE_METRICS_IMPORT)
      expect(src).not.toMatch(RESOLVE_METRICS_CALL)
    }
  )

  it.each(featureFiles.map((f) => f.slice(FEATURE_DIR.length + 1)))(
    '%s never touches the catalog/layout system (no TileGrid, no layout fetch)',
    (relPath) => {
      const src = stripComments(
        readFileSync(join(FEATURE_DIR, relPath), 'utf8')
      )
      for (const banned of [
        'TileGrid',
        'DimensionedSection',
        'getDashboardLayout',
        'saveDashboardLayout',
        'resetDashboardLayout',
        'layout-state',
      ]) {
        expect(src).not.toContain(banned)
      }
    }
  )
})

describe('index.tsx — PageShell posture', () => {
  it('passes editable={false} — the Edit-layout button must never render on /roi', () => {
    expect(indexSrc).toMatch(/editable=\{false\}/)
  })

  it("passes the ROI date-range config with page='roi'", () => {
    expect(indexSrc).toMatch(/const PAGE = 'roi' as const/)
    expect(indexSrc).toMatch(/dateRange=\{PAGE_DATE_RANGE\[PAGE\]\}/)
    expect(indexSrc).toMatch(/page=\{PAGE\}/)
  })

  // The REPORT above the goals reads the page range, while every goal CARD
  // still measures its own stored window. report-page-composition.test.ts
  // owns that contract.
  it('the goal cards still take no window argument — each owns its stored dates', () => {
    expect(indexSrc).toMatch(/<InitiativeCard\s+view=\{view\}/)
    expect(indexSrc).not.toMatch(/<InitiativeCard[^>]*period=/)
    expect(indexSrc).toMatch(/getRoiOverview\(\)/)
  })

  // The JSON link sits up in the band: it answers for every tab. Print
  // report's own definition sits beside its button.
  it('headerExtras holds Show me around, Print report, its hover and Get this as data, and nothing else', () => {
    const block = jsxAttribute(indexSrc, 'headerExtras')
    expect(block).toMatch(/<BoardReadyExportButton/)
    expect(block).toMatch(/<ReportJsonLink/)
    expect(block).toMatch(/ROI_TOOLTIPS\.printReport\.description/)
    // The tour's reopen control. It is FIRST because a repeated help
    // mechanism has to sit in the same place relative to the rest of the page
    // on every page that has one (WCAG 3.2.6), and this slot is the one any
    // other page would use.
    expect(block.match(/<[A-Z][A-Za-z]*/g)).toEqual([
      '<ShowMeAround',
      '<BoardReadyExportButton',
      '<InfoTooltip',
      '<ReportJsonLink',
    ])
  })

  it('both band controls sit above the tabs, so every tab can reach them', () => {
    const tabs = indexSrc.indexOf('<Tabs ')
    expect(tabs).toBeGreaterThan(-1)
    expect(indexSrc.indexOf('headerExtras=')).toBeLessThan(tabs)
    expect(indexSrc.indexOf('REPORT_COPY.dateHelper')).toBeLessThan(tabs)
    expect(indexSrc.indexOf('REPORT_COPY.howThisPageWorksLabel')).toBeLessThan(
      tabs
    )
  })

  // Open on both renders, so React has nothing to reconcile. State seeded from
  // storage makes them disagree, and React 19 discards the server markup for it.
  it('the disclosure renders open unconditionally, with no state read from storage', () => {
    const tag = indexSrc.slice(
      indexSrc.indexOf('<details'),
      indexSrc.indexOf('<summary')
    )
    expect(tag).toMatch(/\n\s*open\n/)
    expect(tag).not.toMatch(/open=\{/)
    expect(indexSrc).not.toMatch(/useState\([^)]*HOW_THIS_PAGE_WORKS/)
    expect(indexSrc).not.toMatch(/useState\([^)]*howThisPageWorks/i)
  })

  it('the remembered state is applied inside a mount effect, never during a render', () => {
    const read = indexSrc.indexOf('storage.getItem(HOW_THIS_PAGE_WORKS_KEY)')
    expect(read).toBeGreaterThan(-1)
    // The nearest effect opens before the read and closes after it.
    const opens = indexSrc.lastIndexOf('useEffect(() => {', read)
    expect(opens).toBeGreaterThan(-1)
    expect(indexSrc.indexOf('}, [])', opens)).toBeGreaterThan(read)
  })

  it('the disclosure writes its state only when the reader toggles it', () => {
    const writes = indexSrc.match(/storage\.setItem\(HOW_THIS_PAGE_WORKS_KEY/g)
    expect(writes).toHaveLength(1)
    // ...and that one write is inside the toggle handler, not a render path.
    const handler = indexSrc.slice(indexSrc.indexOf('const handleHowToggle'))
    expect(handler.slice(0, handler.indexOf('}, [])'))).toContain(
      'storage.setItem(HOW_THIS_PAGE_WORKS_KEY'
    )
  })

  it('renders the subtitle with singular grammar at 1', () => {
    expect(indexSrc).toContain("'1 goal tracked'")
    expect(indexSrc).toContain('goals tracked')
  })
})

describe('index.tsx — cards render from getRoiOverview, the ONE data path', () => {
  it('imports getRoiOverview from the roi-overview action', () => {
    expect(indexSrc).toMatch(
      /import\s*\{[^}]*\bgetRoiOverview\b[^}]*\}\s*from\s*'@\/app\/actions\/roi-overview'/s
    )
  })

  it('references only read actions — writes live in the card/dialog', () => {
    // roi-report (the report above the goals), org-roi-assumptions and
    // getting-started-status are hoisted to the page so a print from another
    // tab still has page one and the guided tour reads the same fact as the
    // nudge (two components asking is two round trips that can answer
    // differently). All are reads; nothing on this page writes.
    expect(actionModules(indexSrc)).toEqual([
      'getting-started-status',
      'initiatives',
      'org-roi-assumptions',
      'roi-overview',
      'roi-report',
    ])
  })

  it('feeds each card a view from the overview and refreshes via onChanged', () => {
    expect(indexSrc).toMatch(/<InitiativeCard/)
    expect(indexSrc).toMatch(/view=\{view\}/)
    expect(indexSrc).toMatch(/onChanged=\{handleChanged\}/)
  })

  it('surfaces fetch failure as ONE page-level error card with the action message', () => {
    expect(indexSrc).toMatch(/state='error'/)
    expect(indexSrc).toMatch(/errorMessage=\{overviewError\}/)
  })
})

describe('index.tsx — add-card + archived toggle', () => {
  it('renders the add-card ALWAYS', () => {
    expect(indexSrc).toContain('＋ New goal')
  })

  it('shows the rich empty-state copy only at zero initiatives', () => {
    expect(indexSrc).toMatch(/initiatives\.length === 0 && \(/)
    expect(indexSrc).toContain('Track your first goal')
    expect(indexSrc).toMatch(/track\s+progress against your real numbers/)
  })

  // The page uses one word, "goal", so there is no glossary line to define
  // "initiative": the empty-state card carries the plain explanation, where a
  // first-time reader is.
  it('the page explains itself where a first-time reader is, with no glossary line', () => {
    const flat = indexSrc.replace(/\s+/g, ' ')
    expect(flat).toContain(
      'Name a goal, pick a metric like cost or revenue, and set a target.'
    )
    expect(flat).not.toContain('is a money goal with a window')
  })

  // One rule, pinned as a pair: the note only earns its removal because each
  // card carries the dates itself. Paper has no grid, so the print keeps it.
  it('the own-window note is off the screen and still on the paper', () => {
    expect(indexSrc).not.toContain('REPORT_COPY.goalsOwnWindowNote')
    const printSrc = readFileSync(
      join(FEATURE_DIR, 'components', 'board-ready-export.tsx'),
      'utf8'
    )
    expect(printSrc).toContain('REPORT_COPY.goalsOwnWindowNote')
  })

  it('every goal card carries the dates it measures, off the shared builder', () => {
    const cardSrc = readFileSync(
      join(FEATURE_DIR, 'components', 'initiative-card.tsx'),
      'utf8'
    )
    expect(cardSrc).toMatch(
      /formatGoalWindow\(view\.startDate, view\.endDate\)/
    )
    // The same builder the print calls, not a second date format that can drift.
    expect(cardSrc).toMatch(
      /import\s*\{[\s\S]*?formatGoalWindow[\s\S]*?\}\s*from\s*'\.\.\/progress-derivation'/
    )
  })

  it('archived cards sit behind the Show-archived toggle', () => {
    expect(indexSrc).toMatch(/showArchived &&/)
    expect(indexSrc).toContain('Show archived (')
    expect(indexSrc).toContain('Hide archived')
  })
})

describe('board-ready export', () => {
  it('imports both the button and the print-only view from the same component module', () => {
    expect(indexSrc).toMatch(
      /import\s*\{\s*BoardReadyExportButton,\s*BoardReadyExportView,?\s*\}\s*from\s*'\.\/components\/board-ready-export'/
    )
  })

  // This print has a second door (Print report, at the end of the
  // Without AI block). Both ride one flag; print-readiness.test.ts owns
  // the rest of that contract.
  it('the export button disables until the overview has actually loaded — never prints stale/empty state on a slow load', () => {
    expect(indexSrc).toMatch(/const goalsRead = overviewState === 'ready'/)
    expect(indexSrc).toMatch(
      /<BoardReadyExportButton[\s\S]{0,80}disabled=\{!goalsRead\}/
    )
  })

  it('the printable reuses activeViews — the SAME array the live cards render, no second fetch/derivation', () => {
    expect(indexSrc).toMatch(
      /<BoardReadyExportView\s+initiatives=\{activeViews\}/
    )
  })

  it('ONE `no-print` wrapper holds the screen — exactly one of {tabs, printable} renders on paper', () => {
    expect(indexSrc.match(/no-print/g)).toHaveLength(1)
    expect(insideNoPrint(indexSrc, '<Tabs ')).toBe(true)
    expect(insideNoPrint(indexSrc, '<InitiativeCard')).toBe(true)
  })

  // Radix unmounts the panel a reader is not on. A printable inside the Tabs
  // root would print only the tab that happened to be open, and a print from
  // Goals would come out with no comparison on page one.
  it('the printable renders OUTSIDE the Tabs root, and outside the wrapper', () => {
    expect(insideNoPrint(indexSrc, '<BoardReadyExportView')).toBe(false)
    expect(indexSrc.indexOf('</Tabs>')).toBeLessThan(
      indexSrc.indexOf('<BoardReadyExportView')
    )
  })

  it('never fetches or derives anything new for the export — no second getRoiOverview call, no resolver, no new math helper', () => {
    expect(indexSrc.match(/getRoiOverview\(\)/g)).toHaveLength(1)
  })
})

describe('initiative-card.tsx — writes reuse the shipped gated actions', () => {
  it('imports updateInitiative and deleteInitiative from @/app/actions/initiatives', () => {
    expect(cardSrc).toMatch(
      /import\s*\{\s*updateInitiative,\s*deleteInitiative\s*\}\s*from\s*'@\/app\/actions\/initiatives'/
    )
  })

  it('references only the initiatives module (plus the type-only view import)', () => {
    expect(actionModules(cardSrc)).toEqual(['initiatives', 'roi-overview'])
    expect(cardSrc).toMatch(
      /import type \{ RoiInitiativeView \} from '@\/app\/actions\/roi-overview'/
    )
  })

  it('never creates or sets targets — those flows belong to the dialog', () => {
    for (const name of ['createInitiative', 'setInitiativeTargets']) {
      expect(cardSrc).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('wires failure toasts with the action error verbatim on BOTH write handlers', () => {
    expect(cardSrc.match(/variant: 'destructive'/g)?.length).toBe(2)
    expect(cardSrc.match(/description: result\.error/g)?.length).toBe(2)
  })

  it('delete confirm carries the usage-data-untouched honesty line', () => {
    expect(cardSrc).toMatch(/Your usage data is untouched/)
  })

  it('archive is reversible from the UI — the kebab offers Unarchive for archived cards', () => {
    expect(cardSrc).toContain("'Unarchive goal' : 'Archive goal'")
  })
})

describe('amber at-risk treatment (a fuller bar cannot read as better)', () => {
  it('status-maps: fill is amber for at-risk and the accent for EVERYTHING else', () => {
    expect(statusMapsSrc).toMatch(
      /health === 'at-risk' \? 'bg-mf-amber' : 'bg-mf-accent'/
    )
  })

  it('the card takes its fill from progressFillClass(view.health) — never a hardcoded color', () => {
    expect(cardSrc).toMatch(/progressFillClass\(view\.health\)/)
    expect(cardSrc).not.toMatch(/bg-mf-amber|bg-mf-accent/)
  })

  it('null progress renders an empty track (width 0), the honest M2 form', () => {
    expect(cardSrc).toMatch(/\$\{shownPct \?\? 0\}%/)
  })
})

describe('initiative-dialog.tsx — the replace-all contract', () => {
  it('references only the initiatives module for writes + preview (plus the matter list and the type-only view import)', () => {
    // Two more action modules, both read-only: matters, for the scope
    // select's options, and roi-report, for the one call behind "See an
    // example". Writes live in initiatives alone.
    expect(actionModules(dialogSrc)).toEqual([
      'initiatives',
      'matters',
      'roi-overview',
      'roi-report',
    ])
    expect(dialogSrc).toMatch(
      /import\s*\{\s*createInitiative,\s*previewAutoBaselines,\s*setInitiativeTargets,\s*updateInitiative,/
    )
  })

  it('edit mode pre-fills EVERY existing target row — never just the first', () => {
    expect(dialogSrc).toMatch(/initiative\.targets\.map\(/)
    expect(dialogSrc).not.toMatch(/initiative\.targets\[0\]/)
  })

  it('prefill round-trips baselineValue AND baselineSource from the view (fields a refactor could drop)', () => {
    expect(dialogSrc).toMatch(
      /baselineValue: t\.baseline === null \? '' : String\(t\.baseline\)/
    )
    expect(dialogSrc).toMatch(/storedBaseline: t\.baseline/)
    expect(dialogSrc).toMatch(/storedSource: t\.baselineSource/)
  })

  it('the submit payload carries baselineValue AND baselineSource on EVERY row, unconditionally', () => {
    const payloadStart = dialogSrc.indexOf('const targetsPayload = rows.map')
    expect(payloadStart).toBeGreaterThan(-1)
    const payload = dialogSrc.slice(
      payloadStart,
      dialogSrc.indexOf('setPending(true)', payloadStart)
    )
    expect(payload).toMatch(/metric: row\.metric/)
    expect(payload).toMatch(/targetValue: Number\(row\.targetValue\)/)
    expect(payload).toMatch(/baselineValue: baseline\.baselineValue/)
    expect(payload).toMatch(/baselineSource: baseline\.baselineSource/)
    expect(payload).toMatch(/direction: row\.direction/)
    // resolveBaselineSubmission's return type carries both fields always —
    // and no conditional spread can drop them from the literal.
    expect(payload).toMatch(/resolveBaselineSubmission\(\{/)
    expect(payload).not.toContain('...(')
  })

  it('BOTH branches submit the full desired state via setInitiativeTargets(…, targetsPayload)', () => {
    expect(dialogSrc).toMatch(
      /setInitiativeTargets\(\s*initiative\.id,\s*targetsPayload\s*\)/
    )
    expect(dialogSrc).toMatch(
      /setInitiativeTargets\(\s*created\.data\.id,\s*targetsPayload\s*\)/
    )
  })

  it("dates are <input type='date'> bare YYYY-MM-DD, prefilled by slicing the ISO strings", () => {
    const dateInputs = stripComments(dialogSrc).match(/type='date'/g)
    expect(dateInputs).toHaveLength(2)
    expect(dialogSrc).toMatch(/initiative\.startDate\.slice\(0, 10\)/)
    expect(dialogSrc).toMatch(/initiative\.endDate\.slice\(0, 10\)/)
  })

  it('metric options come from INITIATIVE_METRIC_META — the total label map', () => {
    expect(dialogSrc).toMatch(METRIC_META_IMPORT)
    expect(dialogSrc).toMatch(/Object\.keys\(INITIATIVE_METRIC_META\)/)
  })

  it('that pin really is one import statement, not two that happen to line up', () => {
    expect(
      METRIC_META_IMPORT.test(
        "import { INITIATIVE_METRIC_META, SCOPE_HELPER_COPY } from '../progress-derivation'"
      )
    ).toBe(true)
    expect(
      METRIC_META_IMPORT.test(
        "import { INITIATIVE_METRIC_META } from '@/lib/elsewhere'\nimport { SCOPE_HELPER_COPY } from '../progress-derivation'"
      )
    ).toBe(false)
  })

  it('an unmapped-GL goal defaults to lte/target-0 (UI default)', () => {
    expect(dialogSrc).toMatch(/metric === 'unmappedCount'/)
    expect(dialogSrc).toMatch(
      /direction: 'lte',\s*\n\s*targetValue: row\.targetValue === '' \? '0' : row\.targetValue/
    )
  })

  it('the starting value is a quiet override behind a disclosure', () => {
    expect(dialogSrc).toMatch(/row\.baselineOpen \? 'Hide' : 'Adjust'/)
    expect(dialogSrc).not.toMatch(
      /Starting value \(optional, used to show % progress\)/
    )
  })

  it('surfaces every action failure verbatim (toast + inline), never closing over it', () => {
    expect(dialogSrc).toMatch(/variant: 'destructive'/)
    expect(dialogSrc).toMatch(/description: message/)
    expect(dialogSrc).toMatch(/setFormError\(message\)/)
  })
})
