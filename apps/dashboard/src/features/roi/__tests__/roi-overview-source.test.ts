/**
 * The ROI read path is composition glue,
 * proven at the source level (jest is node-only; the 'use server' export
 * landmine is invisible to tsc/jest at runtime, so we grep for it — the
 * build-agents-overview-source.test.ts pattern). The composition is split:
 * roi-overview.ts is the thin action; the canon window reads live in
 * _shared/initiative-actuals.ts so the auto-baseline write path and the
 * /roi/[initiativeId] detail action read through the SAME code.
 * The DB-gated half (actuals parity + CRUD roundtrip) lives in
 * app/actions/__tests__/roi-{actuals-parity,crud-roundtrip}.integration.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const actionSrc = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'app', 'actions', 'roi-overview.ts'),
  'utf8'
)

const actualsSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    'actions',
    '_shared',
    'initiative-actuals.ts'
  ),
  'utf8'
)

const valuesSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    'actions',
    '_shared',
    'initiative-metric-values.ts'
  ),
  'utf8'
)

const derivationSrc = readFileSync(
  join(__dirname, '..', 'progress-derivation.ts'),
  'utf8'
)

describe('roi-overview.ts — a thin action over the shared composition', () => {
  it("is a 'use server' file", () => {
    expect(actionSrc.startsWith("'use server'")).toBe(true)
  })

  it('composes the SHIPPED CRUD read — imports getInitiatives from ./initiatives, never rebuilds its query', () => {
    expect(actionSrc).toMatch(
      /import\s*\{\s*getInitiatives\s*\}\s*from\s*'\.\/initiatives'/
    )
    // No direct db access at all: the guarded client would mean a second
    // initiatives query; the canon reads live behind the shared composition.
    expect(actionSrc).not.toMatch(/from\s*'@\/app\/lib\/db'/)
    expect(actionSrc).not.toMatch(/db\.initiatives/)
    expect(actionSrc).not.toMatch(/initiative_targets/)
    expect(actionSrc).not.toMatch(/new PrismaClient\(\)/)
  })

  it('builds every view through the ONE shared composition (initiative-actuals)', () => {
    expect(actionSrc).toMatch(
      /import\s*\{\s*buildInitiativeView\s*\}\s*from\s*'\.\/_shared\/initiative-actuals'/
    )
    expect(actionSrc).toMatch(/buildInitiativeView\(initiative, orgId, now\)/)
  })

  it('never imports or calls resolveMetrics — card actuals do not come from the resolver', () => {
    expect(actionSrc).not.toMatch(/resolveMetrics/)
  })

  it('bounds the actuals computation — ROI_MAX_ACTIVE_INITIATIVES = 24 with a loud error', () => {
    expect(actionSrc).toMatch(/ROI_MAX_ACTIVE_INITIATIVES = 24/)
    expect(actionSrc).toMatch(/active\.length > ROI_MAX_ACTIVE_INITIATIVES/)
  })

  it("scopes reads to the session's active org", () => {
    expect(actionSrc).toMatch(
      /const orgId = session\.session\.activeOrganizationId/
    )
  })

  it('formats no money — no .toFixed anywhere (display is canon-format, downstream)', () => {
    expect(actionSrc).not.toMatch(/\.toFixed\(/)
  })

  it('the target view carries baselineSource so the dialog can tell measured from typed', () => {
    expect(actionSrc).toMatch(
      /baselineSource: InitiativeBaselineSource \| null/
    )
  })
})

describe('initiative-actuals.ts — composes exactly the canon reads', () => {
  it('imports getCostBreakdown, getRevenueMetrics, getMrr, and ANALYTICS_MAX_ROWS from @marginfront/db', () => {
    expect(actualsSrc).toMatch(
      /import\s*\{[^}]*\bgetCostBreakdown\b[^}]*\bgetRevenueMetrics\b[^}]*\bgetMrr\b[^}]*\bANALYTICS_MAX_ROWS\b[^}]*\}\s*from\s*'@marginfront\/db'/s
    )
  })

  it('imports the pure derivation from @/features/roi/progress-derivation', () => {
    expect(actualsSrc).toMatch(
      /import\s*\{[^}]*\btargetProgress\b[^}]*\bderiveInitiativeHealth\b[^}]*\}\s*from\s*'@\/features\/roi\/progress-derivation'/s
    )
  })

  it('imports the pure partition helpers from the money feature (not re-derived)', () => {
    expect(actualsSrc).toMatch(
      /import\s*\{[^}]*\bbuildInternalCustomerMeta\b[^}]*\bsumCostByInternalPartition\b[^}]*\}\s*from\s*'@\/features\/money\/internal-partition'/s
    )
  })

  it('never imports or calls resolveMetrics, the per-event math, or getCostMetrics', () => {
    expect(actualsSrc).not.toMatch(/resolveMetrics/)
    expect(actualsSrc).not.toMatch(/earnedForEvent/)
    expect(actualsSrc).not.toMatch(/getCostMetrics\b/)
  })

  it('uses the shared db client and opens no PrismaClient of its own', () => {
    expect(actualsSrc).not.toMatch(/new PrismaClient\(/)
    expect(actualsSrc).toMatch(/from '@\/app\/lib\/db'/)
  })

  it('derives every window via parseWindowFilter — initiative dates are never raw-passthrough', () => {
    expect(actualsSrc).toMatch(
      /import\s*\{[^}]*\bparseWindowFilter\b[^}]*\}\s*from\s*'\.\/parse-window-filter'/
    )
    expect(actualsSrc).toMatch(/parseWindowFilter\(/)
    // new Date() touches an initiative date exactly once: the not-started
    // guard. Everything windowed goes through parseWindowFilter.
    expect(actualsSrc.match(/new Date\(initiative\./g)).toHaveLength(1)
    expect(actualsSrc).toMatch(/new Date\(initiative\.startDate\)/)
  })

  it('caps the journal-backed read at 92 days (the EARNED_SERIES_MAX_DAYS precedent)', () => {
    expect(actualsSrc).toMatch(
      /import\s*\{\s*getJournalExport\s*\}\s*from\s*'\.\.\/journal-export'/
    )
    expect(actualsSrc).toMatch(/ROI_UNMAPPED_WINDOW_MAX_DAYS = 92/)
    expect(actualsSrc).toMatch(
      /journalWindowDays <= ROI_UNMAPPED_WINDOW_MAX_DAYS/
    )
  })

  it('requests only the totals from the breakdown — pageSize 1, rollup off', () => {
    expect(actualsSrc).toMatch(/pageSize:\s*1/)
    expect(actualsSrc).toMatch(/includeOtherRollup:\s*false/)
  })

  it('getMrr is the POINT-IN-TIME snapshot — called org-wide with no window ({}), and only when the caller allows it', () => {
    expect(actualsSrc).toMatch(/getMrr\(prisma,\s*orgId,\s*\{\}\)/)
    expect(actualsSrc).toMatch(/opts\.includeMrrSnapshot/)
  })

  it('newCustomers is a clean windowed customer count, not money math', () => {
    expect(actualsSrc).toMatch(/prisma\.customers\.count\(/)
    expect(actualsSrc).toMatch(
      /createdAt:\s*\{\s*gte:\s*windowStart,\s*lte:\s*windowEnd\s*\}/
    )
  })

  it('internal/external cost comes from the isInternal partition of the customer breakdown', () => {
    expect(actualsSrc).toMatch(
      /getCostBreakdown\(prisma,\s*orgId,\s*window,\s*'customer'/
    )
    expect(actualsSrc).toMatch(/sumCostByInternalPartition\(/)
  })

  it('the partition reads a COMPLETE bucket set and guards truncation (→ null)', () => {
    expect(actualsSrc).toMatch(/pageSize:\s*ANALYTICS_MAX_ROWS/)
    expect(actualsSrc).toMatch(
      /customerBreakdown\.totalRowCount <= customerBreakdown\.rows\.length/
    )
  })

  it('does exactly one seat computation — none (new seats is left out, no seat-delta history)', () => {
    expect(actualsSrc).not.toMatch(/seatsCount/)
    expect(actualsSrc).not.toMatch(/subscription_change_logs/)
    expect(actualsSrc).not.toMatch(/newSeats/)
  })

  it('formats no money — no .toFixed anywhere', () => {
    expect(actualsSrc).not.toMatch(/\.toFixed\(/)
  })

  it('the auto-baseline derivation reads the mirrored window WITHOUT the mrr snapshot (a today-number is not a historical baseline)', () => {
    const computeStart = actualsSrc.indexOf(
      'export async function computeAutoBaselines'
    )
    expect(computeStart).toBeGreaterThan(-1)
    const computeBody = actualsSrc.slice(computeStart)
    expect(computeBody).toMatch(/baselineWindowFor\(/)
    expect(computeBody).toMatch(/AUTO_BASELINE_SUPPORTED/)
    expect(computeBody).toMatch(/includeMrrSnapshot:\s*false/)
    expect(computeBody).toMatch(/autoBaselineFromReads\(/)
  })
})

describe('initiative-metric-values.ts — one per-metric mapping for actuals AND baselines', () => {
  it('mrr/arr actuals come from the getMrr snapshot — reads.mrr.mrr / reads.mrr.arr', () => {
    expect(valuesSrc).toMatch(
      /case 'mrr':\s*\n\s*return reads\.mrr \? reads\.mrr\.mrr : null/
    )
    expect(valuesSrc).toMatch(
      /case 'arr':\s*\n\s*return reads\.mrr \? reads\.mrr\.arr : null/
    )
  })

  it('newCustomers / internal / external map from their dedicated reads', () => {
    expect(valuesSrc).toMatch(
      /case 'newCustomers':\s*\n\s*return reads\.newCustomers/
    )
    expect(valuesSrc).toMatch(
      /case 'internalCost':\s*\n\s*return reads\.partitionedCost \? reads\.partitionedCost\.internal : null/
    )
    expect(valuesSrc).toMatch(
      /case 'externalCost':\s*\n\s*return reads\.partitionedCost \? reads\.partitionedCost\.external : null/
    )
  })

  it('costPerTask routes through the canon helper, never an inline division', () => {
    expect(valuesSrc).toMatch(
      /import\s*\{\s*costPerTask\s*\}\s*from\s*'@marginfront\/db'/
    )
    expect(valuesSrc).not.toMatch(/cost\s*\/\s*eventCount/)
  })

  it('autoBaselineFromReads maps through actualForMetric — never a second derivation', () => {
    const fnStart = valuesSrc.indexOf('export function autoBaselineFromReads')
    expect(fnStart).toBeGreaterThan(-1)
    expect(valuesSrc.slice(fnStart)).toMatch(/actualForMetric\(metric, reads\)/)
  })
})

describe("roi-overview.ts — 'use server' export landmine (only async functions + type declarations)", () => {
  it('has no export const', () => {
    expect(actionSrc).not.toMatch(/export const /)
  })

  it('has no non-async export function', () => {
    expect(actionSrc).not.toMatch(/export function /)
  })

  it('has no re-export — the `export { X } from` / `export type { X } from` shape crashes every action in the page bundle at runtime', () => {
    expect(actionSrc).not.toMatch(/export\s+(type\s+)?\{[^}]*\}\s*from/)
    expect(actionSrc).not.toMatch(/export \*/)
  })

  it('has no default export', () => {
    expect(actionSrc).not.toMatch(/export default/)
  })

  it('exports the one action', () => {
    expect(actionSrc).toMatch(/export async function getRoiOverview/)
  })
})

describe('progress-derivation.ts — pure module, canon-format display only', () => {
  it('fetches nothing — no PrismaClient, no db import, no action value-imports', () => {
    expect(derivationSrc).not.toMatch(/PrismaClient/)
    expect(derivationSrc).not.toMatch(/from\s*'@\/app\/lib\/db'/)
    // Type-only imports from the 'use server' actions are fine (erased at
    // build); a VALUE import would drag the action into every consumer.
    expect(derivationSrc).not.toMatch(
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/actions/
    )
  })

  it('never touches the resolver or per-event earned math', () => {
    expect(derivationSrc).not.toMatch(/resolveMetrics/)
    expect(derivationSrc).not.toMatch(/earnedForEvent/)
  })

  it('formats via canon-format — imports formatCost/formatPct, no local .toFixed', () => {
    expect(derivationSrc).toMatch(
      /import\s*\{[^}]*\bformatCost\b[^}]*\bformatPct\b[^}]*\}\s*from\s*'@\/lib\/canon-format'/
    )
    expect(derivationSrc).not.toMatch(/\.toFixed\(/)
  })

  it('exports the pace-grace convention as a named const', () => {
    expect(derivationSrc).toMatch(/export const ROI_PACE_GRACE_PTS = 10/)
  })
})

// A stored midnight endDate passed
// verbatim to parseWindowFilter makes windowEnd the START of the final day,
// silently excluding that day's money. Slicing to bare dates makes the
// end-of-day branch fire. Both the usage and the parser behavior are pinned.
// The slicing lives in the shared composition (buildInitiativeView).
describe('initiative window final-day inclusion', () => {
  it('the shared composition slices BOTH initiative dates to bare YYYY-MM-DD before parseWindowFilter', () => {
    expect(actualsSrc).toMatch(
      /startDate:\s*initiative\.startDate\.slice\(0,\s*10\)/
    )
    expect(actualsSrc).toMatch(/initiative\.endDate\.slice\(0,\s*10\)/)
    expect(actualsSrc).not.toMatch(
      /startDate:\s*initiative\.startDate,\s*\n\s*endDate:\s*initiative\.endDate\s*\?\?/
    )
  })

  it('parseWindowFilter: a bare end date includes the whole final day; full-ISO midnight does not', () => {
    const {
      parseWindowFilter,
    } = require('../../../../app/actions/_shared/parse-window-filter')
    const stored = '2026-04-27T00:00:00.000Z'

    const sliced = parseWindowFilter({
      startDate: '2026-04-01',
      endDate: stored.slice(0, 10),
    })
    expect(sliced.windowEnd.toISOString()).toBe('2026-04-27T23:59:59.999Z')

    const verbatim = parseWindowFilter({
      startDate: '2026-04-01',
      endDate: stored,
    })
    expect(verbatim.windowEnd.toISOString()).toBe(stored)
  })
})
