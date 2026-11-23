/**
 * The copy-builder single-source pin.
 * Every number a card renders comes from progress-derivation's builders
 * (goalSentence / goalProgressSentence / formatMetricValue / progressLabel); the
 * components format NOTHING themselves. Source-asserted because a refactor
 * that inlines a toFixed or a local formatCost would pass tsc and render
 * plausibly-wrong money. Runtime half: the view maps are total and
 * the amber rule is exclusive.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { progressLabel } from '../progress-derivation'
import type { InitiativeHealth } from '../progress-derivation'
import { HEALTH_PILLS, progressFillClass } from '../components/status-maps'

const FEATURE_DIR = join(__dirname, '..')

const indexSrc = readFileSync(join(FEATURE_DIR, 'index.tsx'), 'utf8')
const cardSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'initiative-card.tsx'),
  'utf8'
)
const dialogSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'initiative-dialog.tsx'),
  'utf8'
)
const detailSrc = readFileSync(join(FEATURE_DIR, 'detail.tsx'), 'utf8')
const reportSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'roi-report.tsx'),
  'utf8'
)
const withoutAiSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'without-ai.tsx'),
  'utf8'
)

describe('components never format numbers — the derivation is the only copy source', () => {
  // target-trend-chart.tsx is deliberately absent: an axis/tooltip formats
  // via canon-format by design (the timeseries-chart tile precedent).
  const componentSources: Array<[string, string]> = [
    ['index.tsx', indexSrc],
    ['components/initiative-card.tsx', cardSrc],
    ['components/initiative-dialog.tsx', dialogSrc],
    ['detail.tsx', detailSrc],
    // The report renders through report-derivation.ts builders
    // for the same reason the cards render through progress-derivation.ts.
    ['components/roi-report.tsx', reportSrc],
    // The Without AI paragraph is the one string a customer
    // quotes to their board, so it is built in exactly one place.
    ['components/without-ai.tsx', withoutAiSrc],
  ]

  it.each(componentSources)(
    '%s never imports canon-format or re-derives money strings',
    (_name, src) => {
      expect(src).not.toMatch(/@\/lib\/canon-format/)
      expect(src).not.toMatch(/\.toFixed\(/)
      expect(src).not.toMatch(/\bformatCost\s*\(/)
      expect(src).not.toMatch(/\bformatPct\s*\(/)
      expect(src).not.toMatch(/\.toLocaleString\(/)
    }
  )

  it('the card renders through the builders, imported from the derivation', () => {
    expect(cardSrc).toMatch(
      /import\s*\{\s*goalSentence,\s*goalProgressSentence,\s*displayProgressPct,\s*formatGoalWindow,\s*matterScopeLabel,\s*progressLabel,\s*\}\s*from '\.\.\/progress-derivation'/s
    )
    expect(cardSrc).toMatch(/goalSentence\(target\)/)
    expect(cardSrc).toMatch(/goalProgressSentence\(target, view\.elapsedPct\)/)
    expect(cardSrc).toMatch(/progressLabel\(shownPct\)/)
    expect(cardSrc).toMatch(/displayProgressPct\(target\)/)
    expect(cardSrc).toMatch(
      /formatGoalWindow\(view\.startDate, view\.endDate\)/
    )
  })

  it('the card never re-derives progress or health (no local math on the view)', () => {
    expect(cardSrc).not.toMatch(/targetProgress|deriveInitiativeHealth/)
    expect(cardSrc).not.toMatch(/Math\./)
  })
})

describe('progressLabel — the whole-percent card number', () => {
  it("null renders '—' (never an invented 0%)", () => {
    expect(progressLabel(null)).toBe('—')
  })

  it('rounds 92.857→93%, 56.19→56%, 75→75%', () => {
    expect(progressLabel(92.857142857)).toBe('93%')
    expect(progressLabel(56.19047619)).toBe('56%')
    expect(progressLabel(75)).toBe('75%')
  })

  it('met targets read 100%', () => {
    expect(progressLabel(100)).toBe('100%')
  })
})

describe('HEALTH_PILLS + progressFillClass — total and honest', () => {
  const ALL_HEALTHS: InitiativeHealth[] = [
    'on-track',
    'at-risk',
    'achieved',
    'not-started',
    'no-data',
    'archived',
  ]

  it('every health state has a pill with a non-empty label and chrome', () => {
    for (const health of ALL_HEALTHS) {
      expect(HEALTH_PILLS[health].label.length).toBeGreaterThan(0)
      expect(HEALTH_PILLS[health].className.length).toBeGreaterThan(0)
    }
  })

  it('carries the six approved labels exactly', () => {
    expect(ALL_HEALTHS.map((h) => HEALTH_PILLS[h].label)).toEqual([
      'On track',
      'At risk',
      'Achieved',
      'Not started',
      'No data yet',
      'Archived',
    ])
  })

  it('At risk is the ONLY amber pill', () => {
    for (const health of ALL_HEALTHS) {
      if (health === 'at-risk') {
        expect(HEALTH_PILLS[health].className).toContain('mf-amber')
      } else {
        expect(HEALTH_PILLS[health].className).not.toContain('mf-amber')
      }
    }
  })

  it('the progress fill is amber for at-risk ONLY — everything else takes the accent', () => {
    for (const health of ALL_HEALTHS) {
      expect(progressFillClass(health)).toBe(
        health === 'at-risk' ? 'bg-mf-amber' : 'bg-mf-accent'
      )
    }
  })
})
