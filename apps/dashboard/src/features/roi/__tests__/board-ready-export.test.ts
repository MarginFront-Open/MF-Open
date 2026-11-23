/**
 * Board-ready export, source-asserted
 * (dashboard jest is node-only, no RTL). Pins the RIGHT-SIZE contract: browser
 * print only, no PDF/slide dependency, no new data fetch, no new math — every
 * number routes through the SAME copy builders the on-screen cards use
 * (progress-derivation.ts), so a print can never disagree with the page.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { goalProgressSentence, progressLabel } from '../progress-derivation'

const COMPONENT_PATH = join(
  __dirname,
  '..',
  'components',
  'board-ready-export.tsx'
)
const componentSrc = readFileSync(COMPONENT_PATH, 'utf8')

/** Doc mentions are fine; imports/calls are not — code-only bans run on this. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const codeOnly = stripComments(componentSrc)

describe('board-ready-export.tsx — no new dependency, no new fetch, no new math', () => {
  it('adds ZERO new package imports — only the shipped hook, action types, and sibling ROI modules', () => {
    const importSources = [...componentSrc.matchAll(/from\s+'([^']+)'/g)].map(
      (m) => m[1]
    )
    for (const source of importSources) {
      const isRelative = source.startsWith('.')
      const isKnownAlias =
        source === '@/hooks/use-auth' ||
        source === '@/app/actions/roi-overview' ||
        // The canon date formatter (sibling to canon-format.ts), the UTC-safe
        // display-date rule for the initiative window.
        source === '@/lib/canon-date'
      expect(isRelative || isKnownAlias).toBe(true)
    }
    // The export is a browser print, never a PDF or slide-deck library.
    for (const banned of ['pdf', 'jspdf', 'html2canvas', 'pptx', 'slides']) {
      expect(codeOnly.toLowerCase()).not.toContain(banned)
    }
  })

  it('fetches nothing — no PrismaClient, no fetch, no second getRoiOverview call', () => {
    expect(codeOnly).not.toMatch(/PrismaClient/)
    expect(codeOnly).not.toMatch(/\bfetch\(/)
    expect(codeOnly).not.toMatch(/getRoiOverview/)
  })

  it('never touches the metrics resolver or the catalog/layout system', () => {
    expect(componentSrc).not.toMatch(/resolveMetrics/)
    expect(componentSrc).not.toMatch(
      /TileGrid|DimensionedSection|getDashboardLayout/
    )
  })
})

describe('board-ready-export.tsx — every number goes through canon-format via the progress-derivation builders, never re-derived', () => {
  it('never imports canon-format directly and never calls .toFixed — reuses the derivation builders instead', () => {
    expect(componentSrc).not.toMatch(/@\/lib\/canon-format/)
    expect(componentSrc).not.toMatch(/\.toFixed\(/)
    expect(componentSrc).not.toMatch(/\bformatCost\s*\(/)
    expect(componentSrc).not.toMatch(/\bformatPct\s*\(/)
  })

  it('imports its copy builders from the shipped progress-derivation module', () => {
    expect(componentSrc).toMatch(
      /import\s*\{\s*goalSentence,\s*goalProgressSentence,\s*displayProgressPct,\s*formatGoalWindow,\s*matterScopeLabel,\s*progressLabel,?\s*\}\s*from\s*'\.\.\/progress-derivation'/
    )
  })

  it('every target row renders through goalSentence / goalProgressSentence / progressLabel — the exact strings the on-screen card shows', () => {
    expect(componentSrc).toMatch(/goalSentence\(target\)/)
    expect(componentSrc).toMatch(
      /goalProgressSentence\(target, view\.elapsedPct\)/
    )
    expect(componentSrc).toMatch(
      /progressLabel\(displayProgressPct\(target\)\)/
    )
  })

  it('health copy comes from the shipped HEALTH_PILLS map — never a hardcoded label', () => {
    expect(componentSrc).toMatch(
      /import\s*\{\s*HEALTH_PILLS\s*\}\s*from\s*'\.\/status-maps'/
    )
    expect(componentSrc).toMatch(/HEALTH_PILLS\[view\.health\]\.label/)
  })
})

describe('board-ready-export.tsx — print mechanics (browser print, no new dependency)', () => {
  it('the button triggers the browser print directly — no PDF library, no server render', () => {
    expect(componentSrc).toMatch(/export function openBoardReadyPrint\(\)/)
    expect(componentSrc).toMatch(/onClick=\{openBoardReadyPrint\}/)
  })

  // Every print path opens this print rather than calling the browser
  // itself. without-ai-screen.test.ts pins that end of it.
  it('holds the only window.print call in the file', () => {
    expect(codeOnly.match(/window\.print\(\)/g)).toHaveLength(1)
  })

  it('the button disables via a prop — the caller decides readiness, this component holds no fetch state', () => {
    const signature = componentSrc.slice(
      componentSrc.indexOf('export function BoardReadyExportButton'),
      componentSrc.indexOf(
        'return',
        componentSrc.indexOf('export function BoardReadyExportButton')
      )
    )
    expect(signature).toMatch(/disabled,/)
    expect(signature).toMatch(/disabled: boolean/)
    expect(signature).not.toMatch(/useState|useEffect/)
  })

  it("the printable is invisible on screen and shown only under @media print — the `hidden ... print:block` shape (the @media print block in src/index.css, InvoicePrintView's footer)", () => {
    expect(componentSrc).toMatch(/className='print-content hidden print:block'/)
  })

  it('marks each initiative section print-no-break so a card never splits across a page boundary', () => {
    expect(componentSrc).toMatch(/print-no-break/)
  })
})

describe('board-ready-export.tsx — initiative window dates go through canon-date', () => {
  // The builder lives in progress-derivation.ts so the goal card can render
  // the SAME dates line the paper does. The canon-date rule is tested beside
  // it, in progress-derivation.test.ts.
  it('renders the goal window through the one shared builder, formatting nothing itself', () => {
    expect(componentSrc).toMatch(
      /formatGoalWindow\(view\.startDate, view\.endDate\)/
    )
    expect(componentSrc).not.toMatch(/@\/lib\/canon-date/)
    // `new Date(startDate).toLocaleDateString(...)` parses a bare UTC date
    // as midnight UTC then renders in the viewer's local zone, one calendar
    // day early in any negative-offset zone.
    expect(codeOnly).not.toMatch(/new Date\(view\./)
  })
})

describe('board-ready-export.tsx — honest empty and null cases', () => {
  it('renders an honest empty state when there are no active initiatives — never a fabricated card', () => {
    expect(componentSrc).toContain('No goals tracked yet.')
  })

  it("renders an honest 'no target set' line for an initiative with zero targets — never an empty table", () => {
    expect(componentSrc).toContain('No target set.')
  })

  it('null actuals are NEVER special-cased here — the shared sentence and progressLabel already render them honestly (single source)', () => {
    // A local `=== null ? '—'` branch on `target.actual` would mean this file
    // re-derived the null rule instead of trusting the builders — ban it.
    expect(componentSrc).not.toMatch(/target\.actual\s*===\s*null/)
    expect(
      goalProgressSentence(
        {
          metric: 'revenue',
          direction: 'gte',
          targetValue: 41500,
          actual: null,
          baseline: 41048,
          progressPct: null,
          met: null,
        },
        26
      )
    ).toBe('No number for this window.')
    expect(progressLabel(null)).toBe('—')
  })
})

/**
 * The print LEADS with the report. Everything above holds: no extra fetch,
 * no money formatting of its own, no extra dependency. Page one says the
 * report first, and the paragraph on paper is the same paragraph on screen.
 */
describe('board-ready-export.tsx — page one is the report, then the goals', () => {
  const at = (needle: string) => {
    const index = componentSrc.indexOf(needle)
    expect(index).toBeGreaterThan(-1)
    return index
  }

  it('takes the finished report as a prop — it builds none of it and fetches none of it', () => {
    expect(componentSrc).toMatch(/report: PrintReport \| null/)
    expect(codeOnly).not.toMatch(/buildPrintReport\(/)
    expect(codeOnly).not.toMatch(/getRoiReport/)
    expect(codeOnly).not.toMatch(/useEffect\(/)
    expect(codeOnly).not.toMatch(/useState\(/)
  })

  it('imports the report type from the pure derivation module, adding no package', () => {
    expect(componentSrc).toMatch(/from '\.\.\/report-derivation'/)
  })

  it('the report block is rendered before the per-initiative sections', () => {
    expect(at('report.datesLine')).toBeLessThan(at('initiatives.length === 0'))
    expect(at('report.leadSentence')).toBeLessThan(at('goalSentence(target)'))
    expect(at('report.metrics')).toBeLessThan(at('goalSentence(target)'))
    expect(at('report.withoutAi.paragraph')).toBeLessThan(
      at('goalSentence(target)')
    )
  })

  it('prints the dates, the agent table and the six headline metrics with their definitions', () => {
    expect(componentSrc).toMatch(/report\.datesLine/)
    expect(componentSrc).toMatch(/report\.agentsHeading/)
    expect(componentSrc).toMatch(/report\.leadSentence/)
    expect(componentSrc).toMatch(/report\.tableHeaders/)
    expect(componentSrc).toMatch(/report\.rows/)
    expect(componentSrc).toMatch(/row\.counted/)
    expect(componentSrc).toMatch(/report\.totals/)
    expect(componentSrc).toMatch(/report\.metricsHeading/)
    expect(componentSrc).toMatch(/tile\.definition/)
  })

  // Page one LEADS with the comparison. A director who reads the
  // first block reads the point of the page.
  it('prints the Without AI block FIRST, before the agent table and the metrics', () => {
    expect(at('report.withoutAi.heading')).toBeLessThan(
      at('report.agentsHeading')
    )
    expect(at('report.withoutAi.heading')).toBeLessThan(at('report.metrics'))
    expect(at('report.datesLine')).toBeLessThan(at('report.withoutAi.heading'))
  })

  it('prints the rows, the revenue note, the net line, the paragraph and the estimate stamp', () => {
    for (const field of [
      'report.withoutAi.heading',
      'report.withoutAi.cost',
      'report.withoutAi.revenue',
      'report.withoutAi.revenueNote',
      'report.withoutAi.netLine',
      'report.withoutAi.paragraph',
      'report.withoutAi.estimateLabel',
    ]) {
      expect(componentSrc).toContain(field)
    }
    expect(componentSrc).not.toMatch(/withoutUs/)
  })

  // Paper carries BOTH revenue columns, because paper has no
  // control to switch between them.
  it('prints Earned and Total revenue side by side, with no control to pick one', () => {
    expect(componentSrc).toMatch(/\{row\.earned\}/)
    expect(componentSrc).toMatch(/\{row\.revenue\}/)
    expect(componentSrc).toMatch(/report\.totals\.earned/)
    expect(componentSrc).toMatch(/report\.totals\.revenue/)
    expect(componentSrc).not.toMatch(/REVENUE_BASIS_OPTIONS/)
  })

  it('leads page one with the net sentence, the same one the screen leads with', () => {
    expect(at('report.withoutAi.netLine')).toBeLessThan(
      at('report.withoutAi.cost')
    )
  })

  it('prints the usage-event definition and the proxy-gap sentence in full', () => {
    expect(componentSrc).toMatch(/report\.usageEventDefinition/)
    expect(componentSrc).toMatch(/report\.proxyGap/)
  })

  // Paper goes to directors who never saw the screen, so the
  // one sentence saying we cannot answer "how many hours did this save" has
  // to be on it.
  it('prints the hours disclaimer, right after the proxy-gap paragraph', () => {
    expect(componentSrc).toMatch(/report\.hoursNote/)
    expect(componentSrc.indexOf('report.hoursNote')).toBeGreaterThan(
      componentSrc.indexOf('report.proxyGap')
    )
  })

  // Both honesty lines sit under the comparison, so page one
  // carries them next to the estimate they qualify.
  it('keeps both honesty lines on page one, under the comparison', () => {
    expect(at('report.withoutAi.estimateLabel')).toBeLessThan(
      at('report.proxyGap')
    )
    expect(at('report.hoursNote')).toBeLessThan(at('report.agentsHeading'))
  })

  it('holds no prose of its own for the report block — every string is a field', () => {
    const withoutComments = componentSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
    const prose = (withoutComments.match(/>[^<>{}]+</g) ?? [])
      .map((fragment) => fragment.slice(1, -1).trim())
      .filter((fragment) => /^[A-Za-z][A-Za-z ,.'-]{3,}$/.test(fragment))
    // The two empty-state lines and the print header are the only literals
    // this file holds; the report block adds none.
    expect(prose.sort()).toEqual(
      [
        'Goal',
        'No goals tracked yet.',
        'No target set.',
        'Progress',
        'ROI report',
        'Where it stands',
      ].sort()
    )
  })

  it('a print with no report still renders the goal tables rather than an empty page', () => {
    expect(componentSrc).toMatch(/report &&/)
  })
})
