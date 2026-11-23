/**
 * The /roi/[initiativeId]
 * detail surface, source-asserted (node-only jest, no RTL). Pins: the ONE
 * data path (the detail action composes the same buildInitiativeView the
 * cards read), the canon series composition with its honest no-series
 * fallbacks, no-baseline handling, navigation from card AND kebab,
 * and the 'use server' export landmine on the detail action.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { baselineLabel } from '../progress-derivation'

const FEATURE_DIR = join(__dirname, '..')

const actionSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    'actions',
    'roi-initiative-detail.ts'
  ),
  'utf8'
)
const detailSrc = readFileSync(join(FEATURE_DIR, 'detail.tsx'), 'utf8')
const flatDetail = detailSrc.replace(/\s+/g, ' ')
const cardSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'initiative-card.tsx'),
  'utf8'
)
const chartSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'target-trend-chart.tsx'),
  'utf8'
)

describe('roi-initiative-detail.ts — one data path, canon series only', () => {
  it("is a 'use server' file with only async exports", () => {
    expect(actionSrc.startsWith("'use server'")).toBe(true)
    expect(actionSrc).not.toMatch(/export const /)
    expect(actionSrc).not.toMatch(/export function /)
    expect(actionSrc).not.toMatch(/export\s+(type\s+)?\{[^}]*\}\s*from/)
    expect(actionSrc).not.toMatch(/export default/)
    expect(actionSrc).toMatch(/export async function getInitiativeDetail/)
  })

  it('the headline view comes from the SAME buildInitiativeView the ROI cards use', () => {
    expect(actionSrc).toMatch(
      /import\s*\{\s*buildInitiativeView\s*\}\s*from\s*'\.\/_shared\/initiative-actuals'/
    )
    expect(actionSrc).toMatch(/buildInitiativeView\(initiative, orgId/)
  })

  it('composes the SHIPPED CRUD read and scopes to the session org — an out-of-org id is a plain not-found', () => {
    expect(actionSrc).toMatch(
      /import\s*\{\s*getInitiatives\s*\}\s*from\s*'\.\/initiatives'/
    )
    expect(actionSrc).toMatch(
      /const orgId = session\.session\.activeOrganizationId/
    )
    expect(actionSrc).toContain("This initiative doesn't exist or was deleted")
  })

  it('cost-family days come from getCostBreakdown, revenue-family days from whole-day getRevenueMetrics — never the resolver', () => {
    expect(actionSrc).toMatch(
      /import\s*\{[^}]*\bgetCostBreakdown\b[^}]*\bgetRevenueMetrics\b[^}]*\bcostPerTask\b[^}]*\}\s*from\s*'@marginfront\/db'/s
    )
    expect(actionSrc).not.toMatch(/resolveMetrics/)
    expect(actionSrc).not.toMatch(/earnedForEvent/)
  })

  it('bounds the revenue day-series at 92 days with bounded concurrency (the EARNED_SERIES_MAX_DAYS precedent)', () => {
    expect(actionSrc).toMatch(/DETAIL_SERIES_MAX_DAYS = 92/)
    expect(actionSrc).toMatch(/dayCount > DETAIL_SERIES_MAX_DAYS\) return null/)
    expect(actionSrc).toMatch(/REVENUE_SERIES_CONCURRENCY = 8/)
  })

  it('metrics with no honest history return null series — exhaustively, so a new metric is a compile error here', () => {
    expect(actionSrc).toMatch(
      /case 'unmappedCount':\s*\n\s*case 'mrr':\s*\n\s*case 'arr':\s*\n\s*case 'internalCost':\s*\n\s*case 'externalCost':\s*\n\s*return null/
    )
    expect(actionSrc).toMatch(/const exhaustive: never = metric/)
  })

  it('zero-event days carry NO costPerTask point, never a fabricated 0', () => {
    const fnStart = actionSrc.indexOf("case 'costPerTask':")
    expect(fnStart).toBeGreaterThan(-1)
    expect(actionSrc.slice(fnStart)).toMatch(/value === null\s*\n\s*\? \[\]/)
  })

  it('slices initiative dates to bare dates before parseWindowFilter, so the final day counts', () => {
    expect(actionSrc).toMatch(
      /startDate:\s*initiative\.startDate\.slice\(0,\s*10\)/
    )
    expect(actionSrc).toMatch(/initiative\.endDate\.slice\(0,\s*10\)/)
  })
})

describe('detail.tsx — renders every target type, no-baseline included', () => {
  it('fetches through getInitiativeDetail and nothing else — writes stay on the ROI page', () => {
    expect(detailSrc).toMatch(
      /import\s*\{[^}]*\bgetInitiativeDetail\b[^}]*\}\s*from\s*'@\/app\/actions\/roi-initiative-detail'/s
    )
    for (const write of [
      'createInitiative',
      'updateInitiative',
      'deleteInitiative',
      'setInitiativeTargets',
    ]) {
      expect(detailSrc).not.toContain(write)
    }
  })

  it('renders through the copy builders — goalSentence, goalProgressSentence, progressLabel, formatMetricValue', () => {
    expect(detailSrc).toMatch(/goalSentence\(target\)/)
    expect(detailSrc).toMatch(
      /goalProgressSentence\(target, view\.elapsedPct\)/
    )
    expect(detailSrc).toMatch(/progressLabel\(shownPct\)/)
    expect(detailSrc).toMatch(/displayProgressPct\(target\)/)
    expect(detailSrc).toMatch(
      /formatMetricValue\(target\.metric, target\.baseline\)/
    )
  })

  it('a no-baseline target gets an honest note instead of a blank (and mrr/arr name the no-history fact)', () => {
    expect(detailSrc).toMatch(/target\.baseline === null && \(/)
    expect(detailSrc).toMatch(/AUTO_BASELINE_SUPPORTED\[target\.metric\]/)
    expect(flatDetail).toContain(
      'No history exists to measure this one. Add a starting value on the edit screen if you know it.'
    )
    expect(flatDetail).toContain(
      "Not measured yet. Re-save this goal on the ROI page and we'll measure it from your data."
    )
  })

  it('a null series renders the honest no-chart note; an empty series names the empty window', () => {
    expect(flatDetail).toContain(
      'No day-by-day history exists for this metric, so there is no trend to chart.'
    )
    expect(flatDetail).toContain('Nothing recorded in this window yet.')
  })

  it('zero-target initiatives render a plain explanation, not a broken section', () => {
    expect(detailSrc).toMatch(/view\.targets\.length === 0 && \(/)
    expect(flatDetail).toContain('No target set yet.')
  })

  it('health, progress fill, and pills come from the shared status maps — never re-derived or hardcoded', () => {
    expect(detailSrc).toMatch(/HEALTH_PILLS\[view\.health\]/)
    expect(detailSrc).toMatch(/progressFillClass\(view\.health\)/)
    expect(detailSrc).not.toMatch(/bg-mf-amber|bg-mf-accent/)
    expect(detailSrc).not.toMatch(/targetProgress|deriveInitiativeHealth/)
  })

  it('offers the way back — a header link to /roi', () => {
    expect(detailSrc).toMatch(/href='\/roi'/)
    expect(flatDetail).toContain('Back to ROI')
  })

  it('surfaces fetch failure as ONE page-level error frame with the action message', () => {
    expect(detailSrc).toMatch(/state='error'/)
    expect(detailSrc).toMatch(/errorMessage=\{error\}/)
  })

  it('rendered copy carries no em dash outside the honest-null glyph', () => {
    const stripped = detailSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
      .replace(/(['"])—\1/g, '')
      .replace(/>\s*—\s*</g, '><')
    expect(stripped).not.toMatch(/—/)
  })
})

describe('navigation — card click AND kebab both reach the detail route', () => {
  it('the card root is a link-role element that pushes /roi/{id}', () => {
    expect(cardSrc).toMatch(/router\.push\(`\/roi\/\$\{view\.id\}`\)/)
    expect(cardSrc).toMatch(/role='link'/)
    expect(cardSrc).toMatch(/onClick=\{openDetail\}/)
    expect(cardSrc).toMatch(/onKeyDown/)
  })

  it("the kebab offers 'View details' as a read item before the write items", () => {
    expect(cardSrc).toContain('View details')
    const viewDetailsIndex = cardSrc.indexOf('View details')
    const editIndex = cardSrc.indexOf('Edit goal')
    expect(viewDetailsIndex).toBeGreaterThan(-1)
    expect(viewDetailsIndex).toBeLessThan(editIndex)
  })

  it('the kebab wrapper stops propagation so menu clicks never navigate', () => {
    expect(cardSrc).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/)
  })
})

describe('target-trend-chart.tsx — the repo recharts idiom, format-aware', () => {
  it('renders recharts marks with the mf series tokens (the timeseries-chart pattern)', () => {
    expect(chartSrc).toMatch(/from 'recharts'/)
    expect(chartSrc).toMatch(/MF_SERIES\.primary/)
    expect(chartSrc).toMatch(/formatDisplayDate/)
  })

  it('formats by the INITIATIVE_METRIC_META format, pct included, via canon-format', () => {
    expect(chartSrc).toMatch(
      /import\s*\{\s*formatCost,\s*formatPct\s*\}\s*from\s*'@\/lib\/canon-format'/
    )
    expect(chartSrc).toMatch(/case 'pct':\s*\n\s*return formatPct\(value\)/)
  })

  it('computes nothing — points arrive server-derived (no math on values)', () => {
    expect(chartSrc).not.toMatch(/reduce\(|Math\.|toFixed\(/)
  })
})

/**
 * One stored field, one name. The dialog, the detail page and the card all
 * label the stored starting value the same way, so a reader never wonders
 * whether the detail page shows a different number.
 */
describe('detail.tsx — the stored starting value has one name', () => {
  // The name comes from baselineLabel, which keeps "Starting value" for a
  // level metric and says "Last window" on a running total, where the stored
  // number is the previous window's figure rather than this window's origin.
  it('the Stat label comes from the one builder that names the field', () => {
    expect(baselineLabel('marginPercent', '2026-11-30')).toBe('Starting value')
    expect(detailSrc).toMatch(
      /label=\{baselineLabel\(target\.metric, view\.endDate\)\}/
    )
    expect(detailSrc).not.toContain('Starting point')
  })

  it('speaks in the same contracted voice as the rest of the surface', () => {
    expect(flatDetail).toContain(
      "Not measured yet. Re-save this goal on the ROI page and we'll measure it from your data."
    )
    expect(detailSrc).not.toMatch(/and we will measure it from your data/)
  })
})

/**
 * The same field, one screen earlier. The goal page calls the stored figure
 * "Last window" on a running total with dates, so the dialog a customer types
 * it into has to use the same name, or they type a number under one name and
 * find it under another the moment they save.
 */
describe('the dialog and the goal page name the field from one source', () => {
  const dialogSrc = readFileSync(
    join(FEATURE_DIR, 'components', 'initiative-dialog.tsx'),
    'utf8'
  )

  it('both surfaces read baselineLabel out of progress-derivation', () => {
    expect(dialogSrc).toMatch(
      /import\s*\{[^}]*\bbaselineLabel\b[^}]*\}\s*from\s*'\.\.\/progress-derivation'/s
    )
    expect(detailSrc).toMatch(
      /import\s*\{[^}]*\bbaselineLabel\b[^}]*\}\s*from\s*'\.\/progress-derivation'/s
    )
  })

  it('the dialog names the field off the metric AND the end date it is saving', () => {
    expect(dialogSrc).toMatch(
      /baselineLabel\(\s*row\.metric,\s*endDate === '' \? null : endDate\s*\)/
    )
  })

  it('neither name is typed out anywhere the customer reads', () => {
    const rendered = dialogSrc.slice(dialogSrc.indexOf('\n\n  return ('))
    expect(rendered).not.toMatch(/starting value/i)
    expect(rendered).not.toMatch(/last window/i)
  })

  // The label is the field's one name. Helper copy that named it again is a
  // second place for the two surfaces to drift apart, so it points instead.
  it('the helper copy under the field names it no second way', () => {
    const helperStart = dialogSrc.indexOf('function baselineHelperCopy')
    const helperEnd = dialogSrc.indexOf('\n}', helperStart)
    const helper = dialogSrc.slice(helperStart, helperEnd)
    expect(helperStart).toBeGreaterThan(-1)
    expect(helper).not.toMatch(/starting value/i)
    expect(helper).not.toMatch(/last window/i)
  })
})
