/**
 * The initiative-dialog modal polish
 * (capped scrolling body, unclipped select text, the metric-driven
 * value affix). Dashboard jest is node-only, no RTL — source-assert, same
 * idiom as the sibling initiative-dialog tests.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { INITIATIVE_METRIC_META } from '../progress-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

const componentSrc = readFileSync(
  join(__dirname, '..', 'components', 'initiative-dialog.tsx'),
  'utf8'
)

describe('initiative-dialog.tsx — capped height + internal scroll', () => {
  it('DialogContent caps at 85vh and hides overflow, the same shape as FillVolumeDialog/MapModelDialog', () => {
    expect(componentSrc).toMatch(
      /<DialogContent className='[^']*flex max-h-\[85vh\] flex-col gap-4 overflow-hidden[^']*'>/
    )
  })

  it('the body — not the header or footer — owns the scroll, so the actions stay pinned on screen', () => {
    const headerIdx = componentSrc.indexOf('<DialogHeader>')
    const bodyIdx = componentSrc.indexOf(
      "<div className='flex flex-1 flex-col gap-3 overflow-y-auto pr-1'>"
    )
    const footerIdx = componentSrc.indexOf('<DialogFooter>')
    expect(headerIdx).toBeGreaterThan(-1)
    expect(bodyIdx).toBeGreaterThan(headerIdx)
    expect(footerIdx).toBeGreaterThan(bodyIdx)
  })

  it('the scrolling body is the ONE flex-1 region on DialogContent — header and footer stay a fixed size', () => {
    const contentStart = componentSrc.indexOf('<DialogContent')
    const contentBody = componentSrc.slice(
      contentStart,
      componentSrc.indexOf('</DialogContent>', contentStart)
    )
    // The Direction segmented buttons also use `flex-1` — match the exact
    // class string so this only counts the scroll-owning wrapper.
    expect(
      contentBody.match(
        /className='flex flex-1 flex-col gap-3 overflow-y-auto pr-1'/g
      )
    ).toHaveLength(1)
  })
})

describe('initiative-dialog.tsx — Metric select padding and line-height', () => {
  it('a dedicated SELECT_CLASS overrides padding + line-height on top of INPUT_CLASS (same override as date-range-selector.tsx)', () => {
    expect(componentSrc).toMatch(
      /const SELECT_CLASS = cn\(INPUT_CLASS, 'py-1 leading-none'\)/
    )
  })

  it('the Metric select uses SELECT_CLASS, not the plain INPUT_CLASS', () => {
    const selectIdx = componentSrc.indexOf('<select')
    const selectCloseTagIdx = componentSrc.indexOf('</select>', selectIdx)
    const selectElement = componentSrc.slice(selectIdx, selectCloseTagIdx)
    expect(selectIdx).toBeGreaterThan(-1)
    expect(selectElement).toMatch(/className=\{SELECT_CLASS\}/)
    expect(selectElement).not.toMatch(/className=\{INPUT_CLASS\}/)
  })

  it('every other plain input keeps INPUT_CLASS untouched — only the select needed the override', () => {
    expect(
      componentSrc.match(/className=\{INPUT_CLASS\}/g)?.length
    ).toBeGreaterThan(0)
  })
})

describe('initiative-dialog.tsx — target/starting-value unit affix', () => {
  const ALL_METRICS = Object.keys(INITIATIVE_METRIC_META) as InitiativeMetric[]

  // Golden mapping: a metric that changes format bucket must update this
  // table deliberately, so it can't silently drift from the meta that drives it.
  const EXPECTED_AFFIX: Record<
    InitiativeMetric,
    { prefix: string; suffix: string }
  > = {
    cost: { prefix: '$', suffix: '' },
    revenue: { prefix: '$', suffix: '' },
    margin: { prefix: '$', suffix: '' },
    marginPercent: { prefix: '', suffix: '%' },
    costPerTask: { prefix: '$', suffix: '' },
    eventCount: { prefix: '', suffix: '' },
    unmappedCount: { prefix: '', suffix: '' },
    mrr: { prefix: '$', suffix: '' },
    arr: { prefix: '$', suffix: '' },
    newCustomers: { prefix: '', suffix: '' },
    internalCost: { prefix: '$', suffix: '' },
    externalCost: { prefix: '$', suffix: '' },
  }

  it('covers every InitiativeMetric union member — same totality pattern as INITIATIVE_METRIC_META', () => {
    expect(Object.keys(EXPECTED_AFFIX).sort()).toEqual(ALL_METRICS.sort())
  })

  it.each(ALL_METRICS)(
    '%s: the affix matches its live INITIATIVE_METRIC_META format bucket',
    (metric) => {
      const { format } = INITIATIVE_METRIC_META[metric]
      const derived =
        format === 'cost'
          ? { prefix: '$', suffix: '' }
          : format === 'pct'
            ? { prefix: '', suffix: '%' }
            : { prefix: '', suffix: '' }
      expect(EXPECTED_AFFIX[metric]).toEqual(derived)
    }
  )

  it('metricAffix branches on the same three format buckets INITIATIVE_METRIC_META actually uses', () => {
    expect(componentSrc).toMatch(
      /if \(format === 'cost'\) return \{ prefix: '\$', suffix: '' \}/
    )
    expect(componentSrc).toMatch(
      /if \(format === 'pct'\) return \{ prefix: '', suffix: '%' \}/
    )
    expect(componentSrc).toMatch(/return \{ prefix: '', suffix: '' \}/)
  })

  it('both Target value and Starting value render through the same AffixedNumberInput, keyed off row.metric — no separate user choice', () => {
    const matches = componentSrc.match(
      /<AffixedNumberInput\s+metric=\{row\.metric\}/g
    )
    expect(matches).toHaveLength(2)
  })
})
