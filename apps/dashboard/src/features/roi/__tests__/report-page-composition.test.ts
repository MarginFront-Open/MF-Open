/**
 * How the report is wired onto the ROI page, source-asserted
 * (dashboard jest is node-only, no React Testing Library).
 *
 * Each assertion pins a contract a later refactor could silently break:
 *   - the report renders ABOVE the goal cards, so the page answers its
 *     question before anything else,
 *   - the page reads its window from the URL inside a Suspense boundary, the
 *     way the Build page does, or the prerender fails,
 *   - the report component formats NOTHING itself,
 *   - the goal cards, their dialog and their actions are untouched.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { REPORT_COPY, ROI_TOOLTIPS } from '../report-derivation'

const FEATURE_DIR = join(__dirname, '..')
const DASHBOARD_ROOT = join(__dirname, '..', '..', '..', '..')

const indexSrc = readFileSync(join(FEATURE_DIR, 'index.tsx'), 'utf8')
const reportSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'roi-report.tsx'),
  'utf8'
)
const derivationSrc = readFileSync(
  join(FEATURE_DIR, 'report-derivation.ts'),
  'utf8'
)
const detailSrc = readFileSync(join(FEATURE_DIR, 'detail.tsx'), 'utf8')
const dialogSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'initiative-dialog.tsx'),
  'utf8'
)
const actionSrc = readFileSync(
  join(DASHBOARD_ROOT, 'app', 'actions', 'roi-report.ts'),
  'utf8'
)
const layoutsSrc = readFileSync(
  join(
    DASHBOARD_ROOT,
    'src',
    'features',
    'dashboard-shell',
    'default-layouts.ts'
  ),
  'utf8'
)

const flat = (src: string) => src.replace(/\s+/g, ' ')

const indexOf = (src: string, needle: string) => {
  const at = src.indexOf(needle)
  expect(at).toBeGreaterThan(-1)
  return at
}

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

describe('the page date selector is on for /roi, and off for one initiative', () => {
  it('PAGE_DATE_RANGE.roi offers all three modes and defaults to the last 30 days', () => {
    expect(flat(layoutsSrc)).toContain(
      "roi: { modes: ['month', 'rolling', 'custom'], default: { mode: 'rolling' },"
    )
  })

  it('the detail page keeps an empty config — a control there would change nothing', () => {
    expect(layoutsSrc).toMatch(
      /export const ROI_DETAIL_DATE_RANGE: DateRangeConfig = \{\s*modes: \[\],\s*default: null,?\s*\}/
    )
    expect(detailSrc).toMatch(/dateRange=\{ROI_DETAIL_DATE_RANGE\}/)
    expect(detailSrc).not.toMatch(/dateRange=\{PAGE_DATE_RANGE\[PAGE\]\}/)
  })
})

describe('index.tsx — the window comes from the URL, inside a Suspense boundary', () => {
  it('reads the same params the Build page reads, through the shipped pure mappers', () => {
    expect(indexSrc).toMatch(
      /import\s*\{\s*selectionFromParams,\s*selectionToPeriod,?\s*\}\s*from '@\/features\/dashboard-shell\/date-range'/
    )
    expect(indexSrc).toMatch(/useSearchParams\(\)/)
    expect(indexSrc).toMatch(/selectionFromParams\(/)
    expect(indexSrc).toMatch(/selectionToPeriod\(selection\)/)
  })

  it('wraps the searchParams reader in Suspense — useSearchParams needs a boundary during prerender', () => {
    expect(indexSrc).toMatch(/import \{[^}]*\bSuspense\b[^}]*\} from 'react'/s)
    expect(flat(indexSrc)).toMatch(
      /export default function Roi\(\) \{.*<Suspense fallback=\{null\}> <RoiInner \/> <\/Suspense>/
    )
  })

  it('the default selection falls back to rolling, the page config default', () => {
    expect(indexSrc).toMatch(/\{ mode: 'rolling' as const \}/)
  })

  it('renders the helper that tells the reader which numbers these dates govern', () => {
    expect(flat(indexSrc)).toContain('{REPORT_COPY.dateHelper}')
  })

  // The panel is a courtesy, so it opens once and then remembers. Nothing
  // load-bearing lives inside it: every line is also true somewhere else.
  it("'How this page works' is a native disclosure that remembers being closed", () => {
    expect(indexSrc).toMatch(/<details/)
    expect(indexSrc).toMatch(/REPORT_COPY\.howThisPageWorks\.map\(/)
    expect(indexSrc).toMatch(/import \{ storage \} from '@\/lib\/storage'/)
    expect(indexSrc).toMatch(/storage\.getItem\(HOW_THIS_PAGE_WORKS_KEY\)/)
    expect(indexSrc).toMatch(/storage\.setItem\(HOW_THIS_PAGE_WORKS_KEY/)
  })
})

describe('index.tsx — the tabs answer the reader questions in order', () => {
  it('the Summary panel comes before Finished work, which comes before Goals', () => {
    const summary = indexOf(indexSrc, "<TabsContent value='summary'>")
    const finished = indexOf(indexSrc, "<TabsContent value='finished'>")
    const goals = indexOf(indexSrc, "<TabsContent value='goals'")
    expect(summary).toBeLessThan(finished)
    expect(finished).toBeLessThan(goals)
  })

  it('the report section is the Summary panel, and the goal cards are the Goals panel', () => {
    const summary = indexOf(indexSrc, "<TabsContent value='summary'>")
    const finished = indexOf(indexSrc, "<TabsContent value='finished'>")
    const goals = indexOf(indexSrc, "<TabsContent value='goals'")
    expect(indexOf(indexSrc, '<RoiReportSection')).toBeGreaterThan(summary)
    expect(indexOf(indexSrc, '<RoiReportSection')).toBeLessThan(finished)
    expect(indexOf(indexSrc, '<FinishedWork')).toBeGreaterThan(finished)
    expect(indexOf(indexSrc, '<FinishedWork')).toBeLessThan(goals)
    expect(indexOf(indexSrc, '<InitiativeCard')).toBeGreaterThan(goals)
  })

  // The page uses one word for the object, goal, so no glossary line defines
  // a second word.
  it('the goals panel leads with its heading, no glossary line', () => {
    expect(flat(indexSrc)).not.toContain('is a money goal with a window')
    expect(indexSrc.indexOf('REPORT_COPY.goalsHeading')).toBeGreaterThan(
      indexOf(indexSrc, "<TabsContent value='goals'")
    )
  })

  it('reads the tab from the URL through the one resolver, defaulting to Summary', () => {
    expect(indexSrc).toMatch(
      /import \{ ROI_TABS, resolveRoiTab \} from '\.\/roi-tabs'/
    )
    expect(indexSrc).toMatch(/resolveRoiTab\(searchParams\.get\('tab'\)\)/)
  })

  // A handler that rebuilt the query from the tab alone
  // would drop the dates, the count and the agent selection on every click.
  it('the tab handler copies the whole param set, so a tab change keeps the dates', () => {
    const handler = indexSrc.slice(
      indexOf(indexSrc, 'const handleTabChange'),
      indexOf(indexSrc, 'const handleReportInputsChange')
    )
    expect(handler).toMatch(/new URLSearchParams\(searchParams\)/)
    expect(handler).toMatch(/params\.set\('tab', tab\)/)
    expect(handler).not.toMatch(/startDate|endDate|range/)
  })

  // The mirror of the rule above: nextUrlParams deletes every window-scoped
  // param on a date change, so 'tab' listed there would reset the reader to
  // Summary every time they moved the dates.
  it("'tab' is NOT window-scoped — a date change keeps the tab", () => {
    expect(flat(layoutsSrc)).toContain("windowScopedParams: ['units']")
    const roiConfig = layoutsSrc.slice(
      indexOf(layoutsSrc, '  roi: {'),
      indexOf(layoutsSrc, '  mfiq:')
    )
    expect(roiConfig).not.toContain("'tab'")
  })

  it('calls the report action, the overview action and the stored numbers, and nothing else', () => {
    const modules = [
      ...new Set(
        [...indexSrc.matchAll(/from '@\/app\/actions\/([^']+)'/g)].map(
          (m) => m[1]
        )
      ),
    ].sort()
    expect(modules).toEqual([
      // The first-event read is hoisted out of GettingStartedNudge: the
      // guided tour picks its plan from the same fact, and one page may not
      // ask the same question twice.
      'getting-started-status',
      'initiatives',
      'org-roi-assumptions',
      'roi-overview',
      'roi-report',
    ])
  })
})

describe('the printed page carries the report, and none of the screen', () => {
  it('every screen element sits inside the ONE no-print wrapper', () => {
    // A screen helper that says which tab these dates govern would print onto
    // a page that has no tabs and no date selector on it.
    const wrapper = indexOf(indexSrc, "<div className='no-print'>")
    for (const onScreen of [
      'REPORT_COPY.dateHelper',
      'REPORT_COPY.howThisPageWorksLabel',
      '<Tabs ',
      'REPORT_COPY.goalsHeading',
      '<RoiReportSection',
    ]) {
      expect(indexOf(indexSrc, onScreen)).toBeGreaterThan(wrapper)
    }
    expect(indexOf(indexSrc, '<BoardReadyExportView')).toBeGreaterThan(
      indexOf(indexSrc, '</Tabs>')
    )
  })

  it('the print view still renders the goal tables from the same activeViews', () => {
    expect(indexSrc).toMatch(
      /<BoardReadyExportView\s+initiatives=\{activeViews\}/
    )
  })

  it('the print also receives the report, already built by the pure composer', () => {
    expect(indexSrc).toMatch(/report=\{printReport\}/)
    expect(indexSrc).toMatch(/buildPrintReport\(/)
  })
})

describe('the report component formats nothing — the derivation is the only copy source', () => {
  it.each([
    ['components/roi-report.tsx', reportSrc],
    ['index.tsx', indexSrc],
  ])('%s never imports canon-format or re-derives money strings', (_n, src) => {
    expect(src).not.toMatch(/@\/lib\/canon-format/)
    expect(src).not.toMatch(/@\/lib\/canon-date/)
    expect(src).not.toMatch(/\.toFixed\(/)
    expect(src).not.toMatch(/\bformatCost\s*\(/)
    expect(src).not.toMatch(/\bformatPct\s*\(/)
    expect(src).not.toMatch(/\.toLocaleString\(/)
  })

  it('the report renders through the derivation builders, imported from the pure module', () => {
    expect(reportSrc).toMatch(/from '\.\.\/report-derivation'/)
    for (const builder of [
      'reportLeadSentence',
      'reportEmptySentence',
      'reportAgentRowCells',
      'reportTotalsCells',
      'reportMetricTile',
      'REPORT_COPY',
    ]) {
      expect(reportSrc).toMatch(new RegExp(`\\b${builder}\\b`))
    }
  })

  it('the report holds no inline prose — every visible string comes from REPORT_COPY or a builder', () => {
    // A JSX text node is prose when it is words and sentence punctuation and
    // nothing else; anything carrying code punctuation is an arrow, a generic
    // or a ternary that happens to sit between a > and a <.
    const withoutComments = reportSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
    const proseNodes = (withoutComments.match(/>[^<>{}]+</g) ?? [])
      .map((fragment) => fragment.slice(1, -1).trim())
      .filter((fragment) => /^[A-Za-z][A-Za-z ,.'-]{3,}$/.test(fragment))
    expect(proseNodes).toEqual([])
  })
})

describe('vocabulary — the report surfaces carry none of the banned vertical words', () => {
  const BANNED = /\b(matter|matters|legal|law|firm|case|cases)\b/i

  function displayCopy(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
    const quoted = code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []
    const jsxText = code.match(/>[^<>{}]+</g) ?? []
    return [...quoted, ...jsxText]
      .map((fragment) => fragment.slice(1, -1).trim())
      .filter((fragment) => fragment.length > 0)
  }

  it.each([
    ['src/features/roi/report-derivation.ts', derivationSrc],
    ['src/features/roi/components/roi-report.tsx', reportSrc],
    ['app/actions/roi-report.ts', actionSrc],
  ])('%s has no banned word in any string it carries', (_n, src) => {
    expect(displayCopy(src).filter((f) => BANNED.test(f))).toEqual([])
  })
})

describe('roi-report.ts — one snapshot, one gate, one result shape', () => {
  it('gates on the money roles and reports 401 versus 403, the shipped export-route rule', () => {
    expect(actionSrc).toMatch(/assertMoneyManager\(\)/)
    expect(actionSrc).toMatch(/gate\.error === 'Not authenticated'/)
    expect(actionSrc).toMatch(/status: 401, error: NOT_SIGNED_IN/)
    expect(actionSrc).toMatch(/status: 403, error: NOT_ALLOWED/)
    // EVERY exported action refuses through the one helper, so no two of
    // them can drift — count the gates against the actions rather than a
    // number that a fifth action would silently outgrow.
    const exported = actionSrc.match(/export async function \w+\(/g) ?? []
    expect(exported.length).toBeGreaterThanOrEqual(4)
    expect(actionSrc.match(/return gateFailure\(gate\)/g)).toHaveLength(
      exported.length
    )
  })

  it('returns the { ok, status } shape both the page and a later route can read', () => {
    expect(actionSrc).toMatch(/\|\s*\{ ok: true; status: 200; data: T \}/)
    expect(actionSrc).toMatch(
      /\|\s*\{ ok: false; status: 400 \| 401 \| 403 \| 500; error: string \}/
    )
  })

  it('every read in one call shares ONE resolved window, handed down as full ISO', () => {
    // Bare dates would widen the second read: the default "last 30 days"
    // resolves to now-minus-30-at-this-hour, and re-parsing its date part
    // starts that day at midnight. Revenue over 30.6 days against cost over
    // 30 is a Margin tile that does not equal Revenue minus Cost on screen.
    expect(actionSrc).toMatch(/function resolveWindow\(/)
    expect(actionSrc).toMatch(/startDate: windowStart\.toISOString\(\),/)
    expect(actionSrc).toMatch(/endDate: windowEnd\.toISOString\(\),/)
    // One parse, in the helper — nothing else in the file re-resolves dates.
    expect(actionSrc.match(/parseWindowFilter\(/g)).toHaveLength(1)
    // Every metric read takes the resolved instants, never the caller's period.
    let at = actionSrc.indexOf('readMetricsWindow(')
    let calls = 0
    while (at !== -1) {
      expect(actionSrc.slice(at, at + 200)).toContain('resolvedPeriod')
      calls += 1
      at = actionSrc.indexOf('readMetricsWindow(', at + 1)
    }
    // The headline revenue read is ONE getRevenueMetrics call, so
    // readMetricsWindow is left to the six metrics behind the disclosure.
    expect(calls).toBe(1)
    expect(actionSrc.match(/getRevenueMetrics\(/g)).toHaveLength(1)
    expect(
      actionSrc.slice(
        indexOf(actionSrc, 'getRevenueMetrics('),
        indexOf(actionSrc, 'getRevenueMetrics(') + 120
      )
    ).toContain('window')
  })

  it('too many agents for the table is the caller asking for too much, not a 500', () => {
    const refusal = actionSrc.slice(
      indexOf(actionSrc, 'totalRowCount > ANALYTICS_MAX_ROWS'),
      indexOf(actionSrc, 'Narrow the date range.')
    )
    expect(refusal).toContain('status: 400')
    expect(refusal).not.toContain('status: 500')
  })

  it('reads data in the org the gate validated', () => {
    expect(actionSrc).toMatch(/const orgId = gate\.orgId/)
  })

  it('reads cost ONCE — the tiles and the agent rows come from the same snapshot', () => {
    expect(actionSrc.match(/getCostBreakdown\(/g)).toHaveLength(1)
    expect(actionSrc).toMatch(/'agent'/)
    // The six headline metrics are mapped from that same breakdown's totals
    // plus one revenue read; asking readMetricsWindow for cost would open a
    // SECOND breakdown transaction and the two figures could disagree.
    expect(actionSrc).toMatch(/ONE COST READ/)
  })

  // The Revenue tile, the table's Total revenue total and the
  // comparison's Revenue row are the same dollars on one screen, so they come
  // from ONE getRevenueMetrics snapshot. Two reads on an org ingesting live
  // could disagree, and a reader would have no way to tell which was right.
  it('reads revenue ONCE — the tile, the column and the comparison share one snapshot', () => {
    expect(actionSrc).toMatch(/ONE REVENUE READ/)
    expect(actionSrc.match(/getRevenueMetrics\(/g)).toHaveLength(1)
    // Code only: the comments explain why getAgentEarned is NOT called, and
    // that explanation is the thing worth keeping.
    const codeOnly = actionSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
    expect(codeOnly).not.toMatch(/getAgentEarned/)
    const headline = actionSrc.slice(
      indexOf(actionSrc, 'async function readHeadlineReport('),
      indexOf(actionSrc, 'async function readSecondaryMetrics(')
    )
    expect(headline).not.toMatch(/readMetricsWindow\(/)
    expect(headline).toMatch(/revenue: revenueMetrics\.revenue/)
    // The per-agent split of that ONE snapshot: both columns are derived from
    // the same bySubscription rows, in one pure place the tests can hold.
    expect(headline).toMatch(
      /composeReportAgentRows\(\s*agents,\s*usageEventRows,\s*revenueMetrics\.bySubscription/
    )
    const compose = derivationSrc.slice(
      indexOf(derivationSrc, 'export function composeReportAgentRows('),
      indexOf(derivationSrc, 'const SUBSCRIPTION_SCOPED_METRICS')
    )
    expect(compose).toMatch(/usageOnlyAgentRevenue\(bySubscription\)/)
    expect(compose).toMatch(
      /totalRevenueByAgent\(bySubscription, liveAgentIds\)/
    )
  })

  it('the default load never fires the journal read or the unbounded customer read', () => {
    const firstAction = actionSrc.slice(
      indexOf(actionSrc, 'export async function getRoiReport('),
      indexOf(actionSrc, 'export async function getRoiReportSecondaryMetrics(')
    )
    for (const lazy of [
      'unmappedCount',
      'internalCost',
      'externalCost',
      'newCustomers',
      "'mrr'",
      "'arr'",
    ]) {
      expect(firstAction).not.toContain(lazy)
    }
  })

  it('the second action carries exactly the other six metrics', () => {
    expect(actionSrc).toMatch(/SECONDARY_METRICS/)
    expect(actionSrc).toMatch(
      /export async function getRoiReportSecondaryMetrics\(/
    )
  })

  it('refuses loudly past the row cap rather than silently truncating the table', () => {
    expect(actionSrc).toMatch(/ANALYTICS_MAX_ROWS/)
    expect(actionSrc).toMatch(/totalRowCount > ANALYTICS_MAX_ROWS/)
  })

  it('echoes the canon totals instead of re-summing the rows', () => {
    expect(actionSrc).toMatch(/costBreakdown\.totals\.eventCount/)
    expect(actionSrc).toMatch(/costBreakdown\.totals\.cost/)
    expect(actionSrc).not.toMatch(/\.reduce\(/)
  })

  it('reuses the shipped pure row join rather than a second one', () => {
    expect(derivationSrc).toMatch(
      /import \{[^}]*\bderiveAgentRows\b[^}]*\} from '@\/features\/build\/agents-derivation'/s
    )
    const codeOnly = actionSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
    expect(codeOnly).not.toMatch(/\bderiveAgentRows\(/)
  })

  // The catch-all has to know about money the
  // usage-only rows never carry, or the column stops adding up to its total.
  it('hands the row join the agents that carry revenue with no usage behind it', () => {
    const compose = derivationSrc.slice(
      indexOf(derivationSrc, 'export function composeReportAgentRows('),
      indexOf(derivationSrc, 'const SUBSCRIPTION_SCOPED_METRICS')
    )
    expect(compose).toMatch(/bySubscription\.map\(\(row\) => row\.agentId\)/)
  })
})

describe('the goals half of the page reads the shared registry', () => {
  it('the dialog renders the per-metric sentence from the shared registry', () => {
    expect(dialogSrc).toMatch(
      /import \{[^}]*\bMETRIC_DESCRIPTIONS\b[^}]*\} from '\.\.\/report-derivation'/s
    )
    expect(dialogSrc).toMatch(/\{METRIC_DESCRIPTIONS\[row\.metric\]\}/)
    expect(dialogSrc).not.toMatch(/const METRIC_DESCRIPTIONS/)
  })

  it('the report action never writes, and never reads an initiative row', () => {
    expect(actionSrc).not.toMatch(/\.create\(|\.update\(|\.delete\(|deleteMany/)
    expect(actionSrc).not.toMatch(/prisma\.initiative/)
    expect(actionSrc).not.toMatch(/getInitiatives|buildInitiativeView/)
  })

  it('the page still fetches the goal cards through getRoiOverview exactly once', () => {
    expect(indexSrc.match(/getRoiOverview\(\)/g)).toHaveLength(1)
  })
})

describe('the report refuses in plain English, and like a read', () => {
  const refusals = () =>
    actionSrc.slice(
      indexOf(actionSrc, 'const READ_FAILED'),
      indexOf(actionSrc, 'The window every read in one call must share')
    )

  it('the read failure describes no database and no query', () => {
    expect(refusals()).not.toMatch(/\bdatabase\b/i)
    expect(refusals()).not.toMatch(/\bquer(y|ies)\b/i)
    expect(refusals()).toMatch(/Refresh to try again/)
  })

  it('a 403 on a read-only report never accuses the reader of changing records', () => {
    expect(actionSrc).toMatch(/const NOT_ALLOWED\s*=/)
    expect(actionSrc).not.toMatch(/change billing/)
    expect(refusals()).toMatch(/don't have access to this report/)
  })
})

describe('the disclosure answers for the window already on screen', () => {
  it('the action hands back the instants it resolved, not only the display dates', () => {
    expect(actionSrc).toMatch(
      /resolvedPeriod: \{ startDate: string; endDate: string \}/
    )
    expect(actionSrc).toMatch(/window: displayWindow,\s*resolvedPeriod,/)
  })

  it('the component fetches the lazy metrics with THOSE instants, never a raw period', () => {
    // A rolling range resolves its own "now" per call. Re-resolving it when
    // the reader clicks the disclosure answers for a window shifted off the
    // one the Cost tile above it was read for, and Internal + External cost
    // stop adding up to Cost.
    expect(reportSrc).toMatch(/report\?\.resolvedPeriod\.startDate/)
    expect(reportSrc).toMatch(/report\?\.resolvedPeriod\.endDate/)
    expect(reportSrc).toMatch(
      /getRoiReportSecondaryMetrics\(\{\s*startDate: resolvedStart,\s*endDate: resolvedEnd,\s*\}\)/
    )
    // The raw page period is not a prop of the report at all, so the
    // second call cannot reach for it by accident.
    expect(reportSrc).not.toMatch(/period: \{ startDate\?: string/)
    expect(indexSrc).not.toMatch(/period=\{period\}/)
  })

  it('the disclosure shows a loading frame while the six lazy reads are in flight', () => {
    const disclosure = reportSrc.slice(
      indexOf(reportSrc, 'REPORT_COPY.showEveryMetric'),
      indexOf(reportSrc, 'REPORT_COPY.proxyGap')
    )
    expect(disclosure).toMatch(/<TileFrame state='loading'/)
    expect(disclosure).not.toMatch(/\) : null\}/)
  })
})

describe('the agent table names every agent it has activity for', () => {
  it('the inventory read is scoped to the ids with activity, not a capped slice of the roster', () => {
    // A roster read capped at N ordered by name puts every active agent past
    // #N into the row labelled 'Deleted agents', under a sentence that
    // asserts the row is deleted agents.
    expect(actionSrc).toMatch(
      /import \{[^}]*\bagentIdsWithActivity\b[^}]*\} from '@\/features\/build\/agents-derivation'/s
    )
    expect(actionSrc).toMatch(/id: \{ in: activeAgentIds \}/)
    expect(actionSrc).not.toMatch(/AGENTS_INVENTORY_MAX/)
    expect(actionSrc).not.toMatch(/orderBy: \{ name: 'asc' \}/)
  })

  it('the activity reads come first, so the id list the roster read takes is bounded', () => {
    expect(indexOf(actionSrc, 'getCostBreakdown(')).toBeLessThan(
      indexOf(actionSrc, 'prisma.agents.findMany(')
    )
    expect(
      indexOf(actionSrc, 'totalRowCount > ANALYTICS_MAX_ROWS')
    ).toBeLessThan(indexOf(actionSrc, 'prisma.agents.findMany('))
  })

  it('skips the roster read entirely when the window has no activity', () => {
    expect(actionSrc).toMatch(/activeAgentIds\.length === 0/)
  })
})

describe('the two revenue numbers on one screen each say what they cover', () => {
  // It lives in the Earned column's own hover: the
  // sentence answers a question about that column and nothing else. Same
  // constant, so the screen and the print still read the same words.
  it('the Earned column hover carries the scope line, from the one copy source', () => {
    expect(ROI_TOOLTIPS.agentEarned.description).toBe(
      REPORT_COPY.earnedScopeHelper
    )
    expect(flat(reportSrc)).toContain('Earned: ROI_TOOLTIPS.agentEarned')
    expect(flat(reportSrc)).not.toContain('{REPORT_COPY.earnedScopeHelper}')
  })
})

/**
 * The two surfaces added after the page: the goal dialog's
 * examples and the JSON read. Both go through the SAME reads the report
 * already does, which is the only thing that makes "the number in the dialog
 * is the number on the tile" true by construction rather than by review.
 */
describe('roi-report.ts — the examples and the JSON reuse the report reads', () => {
  it('the two window reads are named helpers, so a third caller cannot write a third version of them', () => {
    expect(actionSrc).toMatch(/async function readHeadlineReport\(/)
    expect(actionSrc).toMatch(/async function readSecondaryMetrics\(/)
  })

  it('the examples action composes those same two helpers and nothing else', () => {
    const examples = actionSrc.slice(
      indexOf(actionSrc, 'export async function getRoiMetricExamples('),
      indexOf(actionSrc, 'export async function getRoiReportJson(')
    )
    expect(examples).toMatch(/readHeadlineReport\(/)
    expect(examples).toMatch(/readSecondaryMetrics\(/)
    expect(examples).not.toMatch(/getCostBreakdown\(/)
    expect(examples).not.toMatch(/readMetricsWindow\(/)
    expect(examples).toMatch(/assertMoneyManager\(\)/)
  })

  it('the examples action answers for all twelve metrics in ONE call, so the dialog never fetches twice', () => {
    const examples = actionSrc.slice(
      indexOf(actionSrc, 'export async function getRoiMetricExamples('),
      indexOf(actionSrc, 'export async function getRoiReportJson(')
    )
    expect(examples).toMatch(/HEADLINE_METRICS|headline\.metrics/)
    expect(examples).toMatch(/secondary/)
  })

  it('the JSON action builds its body with the pure builder, never inline', () => {
    const json = actionSrc.slice(
      indexOf(actionSrc, 'export async function getRoiReportJson(')
    )
    expect(json).toMatch(/buildRoiReportJson\(/)
    expect(json).toMatch(/assertMoneyManager\(\)/)
    expect(json).toMatch(/getOrgRoiAssumptions\(\)/)
    expect(json).not.toMatch(/formatCost|toFixed/)
  })

  it('the JSON action reads the customer-entered window inputs off the query string through the shipped parsers', () => {
    expect(actionSrc).toMatch(
      /import \{[^}]*\bparseUnitsParam\b[^}]*\} from '@\/features\/roi\/report-derivation'/s
    )
    expect(actionSrc).toMatch(/parseAgentsParam\(/)
    // The count is read back only
    // when the caller pinned the window, so the same rule guards both doors.
    expect(actionSrc).toMatch(/parseUnitsParam\(params\.units, params\)/)
    expect(actionSrc).toMatch(/windowIsAnchored\(params\)/)
    expect(actionSrc).not.toMatch(/parseBeforeTotalParam/)
  })
})

describe('index.tsx — the print and the screen read one copy of the stored numbers', () => {
  it('the page owns the before-AI fields, so the print cannot render a different set', () => {
    expect(indexSrc).toMatch(/useState<RoiAssumptions \| null>\(null\)/)
    expect(indexSrc).toMatch(/assumptions=\{assumptions\}/)
    expect(indexSrc).toMatch(/onAssumptionsChange=\{setAssumptions\}/)
  })

  it('the report component does not hold that state itself', () => {
    expect(reportSrc).not.toMatch(/useState<RoiAssumptions \| null>/)
  })

  it('the printed block is built from the same report, metrics and inputs the screen renders', () => {
    const build = reportSrc.indexOf('buildWithoutAi({')
    expect(build).toBeGreaterThan(-1)
    const composer = indexSrc.slice(
      indexOf(indexSrc, 'buildPrintReport('),
      indexOf(indexSrc, 'buildPrintReport(') + 400
    )
    expect(composer).toMatch(/assumptions/)
    expect(composer).toMatch(/reportInputs/)
    // The print pro-rates a monthly estimate, so it needs the instants the
    // reads ran on, not the display dates.
    expect(composer).toMatch(/resolvedPeriod: report\.resolvedPeriod/)
  })
})

/**
 * GET /api/roi/report must be reachable from the page, not only by URL.
 * The header carries it, pointed at the window on screen so the JSON answers for what the reader
 * is looking at rather than the default last-30-days.
 */
describe('index.tsx — the JSON read is reachable from the page', () => {
  // It sits in the band, because the data it opens answers for all three
  // tabs.
  it('sits in the band, beside Print report, reachable from every tab', () => {
    expect(indexSrc).toMatch(/function ReportJsonLink\(/)
    // The label and the hover come from one record, so the link cannot be
    // renamed without renaming what its definition calls it.
    expect(indexSrc).toContain('ROI_TOOLTIPS.getThisAsData.title')
    expect(ROI_TOOLTIPS.getThisAsData.title).toBe('Get this as data')
    expect(reportSrc).not.toMatch(/dataLink/)
    const header = jsxAttribute(indexSrc, 'headerExtras')
    expect(header).toContain('BoardReadyExportButton')
    expect(header).toContain('ReportJsonLink')
  })

  it('points at the route, in a new tab, with no referrer', () => {
    expect(indexSrc).toContain("'/api/roi/report'")
    expect(indexSrc).toMatch(/target='_blank'/)
    expect(indexSrc).toMatch(/rel='noreferrer'/)
  })

  it('carries the window on screen, under the route names (start/end, not startDate/endDate)', () => {
    const start = indexSrc.indexOf('function ReportJsonLink(')
    const body = indexSrc.slice(start, indexSrc.indexOf('\n}\n', start))
    for (const key of ['start', 'end', 'units', 'agents']) {
      expect(body).toContain(`'${key}'`)
    }
    expect(body).not.toContain("'startDate'")
    expect(body).not.toContain("'endDate'")
    expect(body).not.toContain("'beforeTotal'")
  })

  it('omits a param the page has no value for rather than sending an empty one', () => {
    const start = indexSrc.indexOf('function ReportJsonLink(')
    const body = indexSrc.slice(start, indexSrc.indexOf('\n}\n', start))
    expect(body).toMatch(/if \(value\)|value !== null|!= null/)
  })
})

/**
 * The JSON route's 401 body carries a real sentence, not the gate's own two
 * words, 'Not authenticated'. The 403 has a sentence built for the read too,
 * because the gate's refusal describes a WRITE, the wrong accusation for a
 * read.
 */
describe('roi-report.ts — a signed-out reader gets a sentence, not the raw gate string', () => {
  const start = actionSrc.indexOf('function gateFailure(')
  const gateFailure = actionSrc.slice(start, actionSrc.indexOf('\n}\n', start))

  it('the anchor exists — gateFailure has not moved or been renamed', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('names its own 401 sentence and never passes gate.error through', () => {
    expect(actionSrc).toContain(
      '"You\'re signed out. Sign in again to read this report."'
    )
    expect(gateFailure).toMatch(/status: 401, error: NOT_SIGNED_IN/)
    expect(gateFailure).not.toMatch(/error: gate\.error/)
  })

  it('keeps the 403 sentence it already had, so the two refusals stay distinct', () => {
    expect(gateFailure).toMatch(/status: 403, error: NOT_ALLOWED/)
  })
})

/**
 * Product rule: keep BOTH Earned and Total revenue and let
 * the reader toggle. The pick lives in the page link so a shared link opens on
 * the column the sender was reading, and it is NOT window-scoped, so changing
 * the dates or the tab keeps it.
 */
describe('the Earned / Total revenue control', () => {
  it('is built from the shared segmented control, not a fourth button style', () => {
    expect(reportSrc).toMatch(
      /import \{[^}]*\bSegmentedControl\b[^}]*\} from '@\/features\/dashboard-shell\/segmented-control'/s
    )
    expect(reportSrc).toMatch(/<SegmentedControl/)
    // The date control is the style being reused, so it reads the same module.
    const selectorSrc = readFileSync(
      join(
        DASHBOARD_ROOT,
        'src',
        'features',
        'dashboard-shell',
        'date-range-selector.tsx'
      ),
      'utf8'
    )
    expect(selectorSrc).toMatch(/<SegmentedControl/)
  })

  it('names its two choices from the one copy source, never inline', () => {
    expect(reportSrc).toMatch(/REVENUE_BASIS_OPTIONS/)
  })

  it('writes the pick to the page link, and reads it back from there', () => {
    expect(indexSrc).toMatch(
      /resolveRevenueBasis\(searchParams\.get\('revenue'\)\)/
    )
    expect(indexSrc).toMatch(/params\.set\('revenue', /)
    // The whole param set travels, the way a tab click already does: a column
    // change must not drop the dates, the count or the agent selection.
    expect(indexSrc).toMatch(/new URLSearchParams\(searchParams\)/)
  })

  it('reaches the table AND the print, so paper follows the screen', () => {
    expect(indexSrc).toMatch(/revenueBasis=\{revenueBasis\}/)
    expect(indexSrc).toMatch(/revenueBasis,/)
  })

  it('the column hovers cover both labels, so a switched column is never bare', () => {
    expect(flat(reportSrc)).toContain(
      "'Total revenue': ROI_TOOLTIPS.agentRevenue"
    )
    expect(flat(reportSrc)).toContain('Earned: ROI_TOOLTIPS.agentEarned')
    expect(ROI_TOOLTIPS.revenueBasis.description.length).toBeGreaterThan(0)
  })
})
