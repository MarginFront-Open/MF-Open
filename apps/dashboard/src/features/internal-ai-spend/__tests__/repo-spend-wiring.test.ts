import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Source-assertion wiring (dashboard jest is node-only, no
 * RTL; same pattern as install-kit-wiring.test.ts). Locks three claims:
 * the Internal AI Spend page renders the repo-spend section, the
 * section reaches its data only through the server action (never Prisma,
 * never @marginfront/db in the client bundle), and the action forwards the
 * caller's session cookie to GET /control/spend/breakdown.
 */
const FEATURE = join(__dirname, '..')
const tabSrc = readFileSync(join(FEATURE, 'index.tsx'), 'utf8')
const sectionSrc = readFileSync(
  join(FEATURE, 'components', 'repo-spend-section.tsx'),
  'utf8'
)
const actionSrc = readFileSync(
  join(FEATURE, '..', '..', '..', 'app', 'actions', 'spend-controls.ts'),
  'utf8'
)

describe('internal-ai-spend/index.tsx — renders the repo-spend section', () => {
  it('imports RepoSpendSection from the feature component, not inline markup', () => {
    expect(tabSrc).toMatch(
      /import \{ RepoSpendSection \} from '\.\/components\/repo-spend-section'/
    )
  })

  it('renders it with no props', () => {
    expect(tabSrc).toMatch(/<RepoSpendSection \/>/)
  })
})

describe('repo-spend-section.tsx — consumes the spend breakdown through the action layer', () => {
  it('is a client component that calls the getSpendBreakdown server action', () => {
    expect(sectionSrc).toMatch(/^'use client'/)
    // Tolerates the multi-name import (getSpendBreakdown + getSpendBreakdownDrill).
    expect(sectionSrc).toMatch(
      /import \{[\s\S]*?getSpendBreakdown[\s\S]*?\} from '@\/app\/actions\/spend-controls'/
    )
  })

  it('never imports @marginfront/db or touches Prisma (client-bundle rule)', () => {
    expect(sectionSrc).not.toContain('@marginfront/db')
    expect(sectionSrc).not.toMatch(/prisma/i)
  })

  it('renders every string from the pinned repo-spend copy module (shared with the actions, so it stays in features/money)', () => {
    expect(sectionSrc).toMatch(/from '@\/features\/money\/repo-spend'/)
  })

  it('uses the shared TileFrame states and freshness label, not bespoke ones', () => {
    expect(sectionSrc).toMatch(/TileFrame/)
    expect(sectionSrc).toMatch(
      /import \{ freshnessLabel \} from '\.\.\/spend-controls-utils'/
    )
  })

  it('never claims a PR-level number it does not have', () => {
    expect(sectionSrc).not.toMatch(/cost per PR/i)
    expect(sectionSrc).not.toMatch(/per-PR/i)
  })
})

describe('repo-spend-section.tsx — title explainer tooltip', () => {
  it('uses the design-system tooltip, not a bespoke popover', () => {
    expect(sectionSrc).toMatch(
      /import \{ TooltipWrap \} from '@\/components\/ui\/info-tooltip'/
    )
  })

  it('feeds the tooltip the pinned explainer constants, not inline prose', () => {
    expect(sectionSrc).toContain('REPO_SPEND_EXPLAINER_TITLE')
    expect(sectionSrc).toContain('REPO_SPEND_EXPLAINER_HOW')
    expect(sectionSrc).toContain('REPO_SPEND_EXPLAINER_PR')
    expect(sectionSrc).toContain('REPO_SPEND_EXPLAINER_COVERAGE')
  })

  it('sits next to the section title', () => {
    const titleIndex = sectionSrc.indexOf('{REPO_SPEND_TITLE}')
    const tooltipIndex = sectionSrc.indexOf('<TooltipWrap')
    expect(titleIndex).toBeGreaterThan(-1)
    expect(tooltipIndex).toBeGreaterThan(-1)
    // Same title row: the tooltip opens right after the title text, well
    // before the data table further down the component.
    expect(tooltipIndex).toBeGreaterThan(titleIndex)
    expect(sectionSrc.slice(titleIndex, tooltipIndex).length).toBeLessThan(400)
  })

  it('triggers from a real button so keyboard focus can open it', () => {
    // lucide's Info svg never joins the tab order, and Radix only opens a
    // tooltip on hover or focus — a bare-icon trigger locks keyboard users out.
    const trigger = sectionSrc.slice(
      sectionSrc.indexOf('<TooltipWrap'),
      sectionSrc.indexOf('</TooltipWrap>')
    )
    expect(trigger).toMatch(/<button[\s\S]*?type='button'/)
    expect(trigger).toMatch(/aria-label=/)
    expect(trigger).toMatch(/focus-visible:/)
  })
})

describe('app/actions/spend-controls.ts — getSpendBreakdown forwards to GET /control/spend/breakdown', () => {
  const fnStart = actionSrc.indexOf('export async function getSpendBreakdown')
  const fnSlice = actionSrc.slice(fnStart)

  it('exists and targets GET /control/spend/breakdown', () => {
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnSlice).toContain('spend/breakdown')
    // The /control/ prefix lives in the shared forward helper.
    expect(
      actionSrc.slice(actionSrc.indexOf('function forwardControlRead'))
    ).toContain('/control/')
  })

  it('forwards the session cookie and never aggregates signal_events itself', () => {
    expect(actionSrc).toMatch(/forwardControlRead\(/)
    const readHelper = actionSrc.slice(
      actionSrc.indexOf('function forwardControlRead')
    )
    // The cookie rides through the shared header helper: the
    // forward hands cookieHeader to apiForwardHeaders, which sets Cookie.
    expect(readHelper).toContain('headers: apiForwardHeaders(cookieHeader)')
    const headerHelper = actionSrc.slice(
      actionSrc.indexOf('function apiForwardHeaders')
    )
    expect(headerHelper).toContain('Cookie: cookieHeader')
    // The breakdown math lives in ONE place (the API's spend service); the action is a
    // pass-through, so a second Prisma aggregation here could silently drift.
    const beforeNextExport =
      fnSlice.indexOf('export async function', 10) === -1
        ? fnSlice
        : fnSlice.slice(0, fnSlice.indexOf('export async function', 10))
    expect(beforeNextExport).not.toContain('prisma.')
  })

  it('validates dimension and period against the closed sets', () => {
    expect(fnSlice).toMatch(/SPEND_BREAKDOWN_DIMENSIONS/)
    expect(fnSlice).toMatch(/CAP_PERIODS/)
  })
})

const copySrc = readFileSync(
  join(FEATURE, '..', 'money', 'repo-spend.ts'),
  'utf8'
)

describe('repo-spend-section.tsx — branch drill-down', () => {
  it('calls the getSpendBreakdownDrill server action, not a client aggregation', () => {
    expect(sectionSrc).toMatch(
      /import \{[\s\S]*?getSpendBreakdownDrill[\s\S]*?\} from '@\/app\/actions\/spend-controls'/
    )
    expect(sectionSrc).toMatch(/getSpendBreakdownDrill\(/)
  })

  it('offers the expand control only in branch mode, never for repo rows', () => {
    // The drill is gated on the branch dimension AND a real (non-null) key, so
    // repo rows and the "No branch recorded" bucket never grow a toggle.
    expect(sectionSrc).toMatch(/dimension === 'branch' &&\s*row\.key !== null/)
    expect(sectionSrc).toContain('expandable')
  })

  it('drives the toggle from a real, labeled button (keyboard-openable)', () => {
    expect(sectionSrc).toMatch(/aria-expanded=/)
    expect(sectionSrc).toContain('DRILL_EXPAND_LABEL')
    expect(sectionSrc).toContain('DRILL_COLLAPSE_LABEL')
  })

  it('renders commit, member, and cost from the action result', () => {
    expect(sectionSrc).toContain('commitCellText(row.commitSha)')
    expect(sectionSrc).toContain('{row.member}')
    expect(sectionSrc).toContain('spendCellText(row.spentUsd)')
    expect(sectionSrc).toContain('DRILL_COLUMN_HEADERS')
  })

  it('reuses the shared TileFrame for the drill loading and error states', () => {
    const drillBlock = sectionSrc.slice(
      sectionSrc.indexOf('function DrillRows')
    )
    expect(drillBlock).toMatch(/<TileFrame/)
    expect(drillBlock).toContain('DRILL_ERROR_LINE')
  })

  it('shows the two honesty caveats under the drill', () => {
    expect(sectionSrc).toContain('DRILL_CAVEAT_NOTE')
  })

  it('never imports @marginfront/db or touches Prisma from the drill code either', () => {
    expect(sectionSrc).not.toContain('@marginfront/db')
    expect(sectionSrc).not.toMatch(/prisma/i)
  })
})

describe('repo-spend.ts — pinned drill copy carries the honesty caveats', () => {
  it('the caveat note names the checked-out parent commit', () => {
    expect(copySrc).toMatch(/parent of the commit it produced/)
  })

  it('the caveat note says commits only show when the meter captured git', () => {
    expect(copySrc).toMatch(/captured git/)
  })

  it('keeps the drill copy em-dash-free', () => {
    // Scope to the drill copy block only.
    const start = copySrc.indexOf('Branch drill copy')
    const end = copySrc.indexOf('── Pure mapping')
    const drillCopy = copySrc.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(drillCopy).not.toContain('—')
  })
})

describe('app/actions/spend-controls.ts — getSpendBreakdownDrill forwards to the breakdown drill endpoint', () => {
  const fnStart = actionSrc.indexOf(
    'export async function getSpendBreakdownDrill'
  )
  const fnSlice = actionSrc.slice(fnStart)

  it('exists and targets GET /control/spend/breakdown/drill', () => {
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnSlice).toContain('spend/breakdown/drill')
    expect(fnSlice).toMatch(/forwardControlRead\(/)
  })

  it('validates the period against the closed set and never aggregates itself', () => {
    expect(fnSlice).toMatch(/CAP_PERIODS/)
    const beforeNextExport =
      fnSlice.indexOf('export async function', 10) === -1
        ? fnSlice
        : fnSlice.slice(0, fnSlice.indexOf('export async function', 10))
    expect(beforeNextExport).not.toContain('prisma.')
  })
})

describe('repo-spend-section.tsx — the repo-missing helper', () => {
  it('reads its copy from the pinned repo-help module, not inline prose', () => {
    expect(sectionSrc).toMatch(/from '\.\.\/repo-help'/)
  })

  it('renders once between the table and the freshness line, with no dimension branch around it (so By repo and By branch both get it)', () => {
    const tableEnd = sectionSrc.indexOf('</table>')
    const freshness = sectionSrc.indexOf('{freshnessLabel(')
    expect(tableEnd).toBeGreaterThan(-1)
    expect(freshness).toBeGreaterThan(tableEnd)
    const shared = sectionSrc.slice(tableEnd, freshness)
    expect(shared.split('{REPO_HELP_TOGGLE}').length - 1).toBe(1)
    expect(shared).toContain('{REPO_HELP_PROMPT}')
    // The drill gate is the file's only dimension conditional and it lives
    // inside the table body; nothing between the table and the freshness
    // line may key on the dimension, or one tab would lose the helper. The
    // bare word is what is banned: a ternary, a lookup or a helper call on
    // the dimension would all slip past an `=== ` match.
    expect(shared).not.toMatch(/\bdimension\b/)
  })

  it('wires the Copy button to the clipboard handler', () => {
    expect(sectionSrc).toContain('onClick={handleCopyPrompt}')
  })

  it('opens from a real disclosure button tied to the panel it controls', () => {
    expect(sectionSrc).toContain("aria-controls='repo-help-panel'")
    expect(sectionSrc).toContain("id='repo-help-panel'")
    expect(sectionSrc).toMatch(/aria-expanded=\{helpOpen\}/)
  })

  it('copies the prompt through the clipboard API, guarded so a browser without one cannot throw', () => {
    expect(sectionSrc).toContain(
      'navigator.clipboard.writeText(REPO_HELP_PROMPT)'
    )
    expect(sectionSrc).toContain('navigator.clipboard?.writeText')
    expect(sectionSrc).toMatch(/\} catch \{/)
  })

  it('the no-key row says what it holds, for whichever dimension is showing', () => {
    expect(sectionSrc).toContain('NO_KEY_LABELS[dimension]')
    expect(sectionSrc).toContain('NO_KEY_ROW_NOTES[dimension]')
  })
})
