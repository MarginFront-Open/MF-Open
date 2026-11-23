/**
 * "See an example", for every metric in the dropdown.
 *
 * The rule this suite exists to keep: a customer who clicks the button sees
 * THEIR number when we have one, and a line that says out loud it is not
 * theirs when we don't. A plausible number with no label on it is the one
 * outcome worse than saying nothing, so the labelled prefix is pinned in
 * source rather than left to a reviewer's eye.
 *
 * Node-only, no DB, no mocks — pure functions in, exact strings out.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { formatCost, formatPct } from '@/lib/canon-format'
import { formatDisplayDate } from '@/lib/canon-date'
import {
  ILLUSTRATIVE_METRICS,
  METRIC_EXAMPLE_COPY,
  METRIC_EXAMPLE_NOTES,
  METRIC_DESCRIPTIONS,
  REPORT_COPY,
  metricExample,
  reportMetricTile,
  type ReportMetricValue,
} from '../report-derivation'
import { INITIATIVE_METRIC_META } from '../progress-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

const WINDOW = { startDate: '2026-08-19', endDate: '2026-09-18' }
const START = formatDisplayDate(WINDOW.startDate)
const END = formatDisplayDate(WINDOW.endDate)

const ALL_METRICS = Object.keys(INITIATIVE_METRIC_META) as InitiativeMetric[]

const value = (
  metric: InitiativeMetric,
  v: number | null
): ReportMetricValue => ({ metric, value: v, unavailable: null })

describe('every metric in the dropdown has an example, and the union is total', () => {
  it('the illustrative fixture and the notes both cover every metric, so a new metric without an example is a compile error', () => {
    expect(Object.keys(ILLUSTRATIVE_METRICS).sort()).toEqual(
      [...ALL_METRICS].sort()
    )
    expect(Object.keys(METRIC_EXAMPLE_NOTES).sort()).toEqual(
      [...ALL_METRICS].sort()
    )
    expect(ALL_METRICS).toHaveLength(12)
  })

  it.each(ALL_METRICS)(
    '%s builds a real line that names the dates, the number and where it came from',
    (metric) => {
      const example = metricExample(value(metric, 12.5), WINDOW)
      expect(example.kind).toBe('real')
      expect(example.line).toContain(START)
      expect(example.line).toContain(END)
      expect(example.line).toContain(METRIC_EXAMPLE_NOTES[metric])
      expect(example.line).not.toContain(METRIC_EXAMPLE_COPY.illustrativePrefix)
    }
  )

  it.each(ALL_METRICS)(
    '%s builds an illustrative line that opens with the label and carries no date claim',
    (metric) => {
      const example = metricExample(value(metric, null), WINDOW)
      expect(example.kind).toBe('illustrative')
      expect(
        example.line.startsWith(METRIC_EXAMPLE_COPY.illustrativePrefix)
      ).toBe(true)
      expect(example.line).not.toContain(START)
      expect(example.line).not.toContain(END)
      expect(example.line).toContain(METRIC_EXAMPLE_NOTES[metric])
    }
  )
})

describe('the numbers in both lines are produced by the shipped formatters, never typed in', () => {
  const EXPECTED_FORMAT: Record<InitiativeMetric, (n: number) => string> = {
    cost: formatCost,
    revenue: formatCost,
    margin: formatCost,
    marginPercent: (n) => formatPct(n),
    costPerTask: formatCost,
    eventCount: (n) => n.toLocaleString(),
    unmappedCount: (n) => n.toLocaleString(),
    mrr: formatCost,
    arr: formatCost,
    newCustomers: (n) => n.toLocaleString(),
    internalCost: formatCost,
    externalCost: formatCost,
  }

  it('the expected-format table covers the same union the registry does', () => {
    expect(Object.keys(EXPECTED_FORMAT).sort()).toEqual([...ALL_METRICS].sort())
  })

  it.each(ALL_METRICS)(
    '%s renders its real value in its own format bucket',
    (metric) => {
      const raw = metric === 'marginPercent' ? 63.25 : 1240.5
      const example = metricExample(value(metric, raw), WINDOW)
      expect(example.line).toContain(EXPECTED_FORMAT[metric](raw))
    }
  )

  it.each(ALL_METRICS)(
    '%s renders its illustrative value in its own format bucket',
    (metric) => {
      const example = metricExample(value(metric, null), WINDOW)
      expect(example.line).toContain(
        EXPECTED_FORMAT[metric](ILLUSTRATIVE_METRICS[metric])
      )
    }
  )

  it('a sub-dollar rate keeps the four decimals the canon formatter gives it, so the design copy cannot drift from the product', () => {
    const example = metricExample(value('costPerTask', 0.2685), WINDOW)
    expect(example.line).toContain('$0.2685')
    expect(example.line).not.toContain('$0.27')
  })
})

describe('one illustrative organization, internally consistent', () => {
  it('margin is revenue minus cost', () => {
    expect(ILLUSTRATIVE_METRICS.margin).toBeCloseTo(
      ILLUSTRATIVE_METRICS.revenue - ILLUSTRATIVE_METRICS.cost,
      10
    )
  })

  it('net margin is margin over revenue', () => {
    expect(ILLUSTRATIVE_METRICS.marginPercent).toBeCloseTo(
      (ILLUSTRATIVE_METRICS.margin / ILLUSTRATIVE_METRICS.revenue) * 100,
      10
    )
  })

  it('cost per usage event is cost over usage events', () => {
    expect(ILLUSTRATIVE_METRICS.costPerTask).toBeCloseTo(
      ILLUSTRATIVE_METRICS.cost / ILLUSTRATIVE_METRICS.eventCount,
      10
    )
  })

  it('a year of recurring revenue is twelve months of it', () => {
    expect(ILLUSTRATIVE_METRICS.arr).toBeCloseTo(
      ILLUSTRATIVE_METRICS.mrr * 12,
      10
    )
  })

  it('internal and external cost add up to the cost', () => {
    expect(
      ILLUSTRATIVE_METRICS.internalCost + ILLUSTRATIVE_METRICS.externalCost
    ).toBeCloseTo(ILLUSTRATIVE_METRICS.cost, 10)
  })

  it('every fixture number is positive, so no example teaches the reader a loss is normal', () => {
    for (const metric of ALL_METRICS) {
      expect(ILLUSTRATIVE_METRICS[metric]).toBeGreaterThan(0)
    }
  })
})

describe('the read that failed says so and shows no number at all', () => {
  it('a missing entry is the unavailable line, not an illustrative one', () => {
    const example = metricExample(null, WINDOW)
    expect(example.kind).toBe('unavailable')
    expect(example.line).toBe(METRIC_EXAMPLE_COPY.unavailable)
  })

  it('a missing window is the unavailable line too, because a date-free example is a claim we cannot back', () => {
    expect(metricExample(value('cost', 12), null).kind).toBe('unavailable')
  })

  it('the unavailable copy carries no digit, so nothing on it can be read as a measurement', () => {
    expect(METRIC_EXAMPLE_COPY.unavailable).not.toMatch(/\d/)
  })

  it('a metric the window is too wide to read says why, and does not fall back to a fixture', () => {
    const example = metricExample(
      {
        metric: 'unmappedCount',
        value: null,
        unavailable: { reason: 'window-too-wide', capDays: 92 },
      },
      WINDOW
    )
    expect(example.kind).toBe('unavailable')
    expect(example.line).toBe(REPORT_COPY.unmappedOverWindowCap(92))
    expect(example.line).not.toContain(METRIC_EXAMPLE_COPY.illustrativePrefix)
  })
})

describe('the example agrees with the definition the reader already has', () => {
  it('the two metrics read as of today say so in both places', () => {
    for (const metric of ['mrr', 'arr'] as const) {
      expect(METRIC_DESCRIPTIONS[metric]).toContain('as of today')
      expect(METRIC_EXAMPLE_NOTES[metric]).toContain('as of today')
    }
  })

  it('no example note calls a usage-event count a task', () => {
    for (const metric of ALL_METRICS) {
      expect(METRIC_EXAMPLE_NOTES[metric]).not.toMatch(/\btasks?\b/i)
    }
  })

  it('no example note carries the banned vertical vocabulary', () => {
    const REPLACED = /\b(matter|matters|legal|law|firm|firms|case|cases)\b/i
    for (const metric of ALL_METRICS) {
      expect(METRIC_EXAMPLE_NOTES[metric]).not.toMatch(REPLACED)
    }
    expect(METRIC_EXAMPLE_COPY.unavailable).not.toMatch(REPLACED)
    expect(METRIC_EXAMPLE_COPY.buttonLabel).not.toMatch(REPLACED)
  })

  it('no example copy carries an em dash or the word "just"', () => {
    for (const text of [
      ...Object.values(METRIC_EXAMPLE_NOTES),
      ...Object.values(METRIC_EXAMPLE_COPY),
    ]) {
      expect(text).not.toContain('—')
      expect(text).not.toMatch(/\bjust\b/i)
    }
  })
})

describe('the tile and the dialog show the SAME line for the same window', () => {
  it('the report tile carries the example the dialog builds, number for number', () => {
    const entry = value('cost', 5012.4)
    const tile = reportMetricTile(entry, { window: WINDOW })
    expect(tile.example).toEqual(metricExample(entry, WINDOW))
  })

  it.each(ALL_METRICS)(
    '%s: a tile built from one read and a dialog line built from the same read are identical',
    (metric) => {
      const entry = value(metric, 91.5)
      expect(reportMetricTile(entry, { window: WINDOW }).example.line).toBe(
        metricExample(entry, WINDOW).line
      )
    }
  )

  it('the tile example moves when the read moves — a tile pinned to a constant would fail this', () => {
    const a = reportMetricTile(value('cost', 10), { window: WINDOW }).example
    const b = reportMetricTile(value('cost', 20), { window: WINDOW }).example
    expect(a.line).not.toBe(b.line)
    expect(b.line).toContain(formatCost(20))
  })

  it('a tile with no window still refuses to invent one', () => {
    expect(reportMetricTile(value('cost', 10), {}).example.kind).toBe(
      'unavailable'
    )
  })
})

describe('both surfaces read the one builder and format nothing themselves', () => {
  const FEATURE_DIR = join(__dirname, '..')
  const dialogSrc = readFileSync(
    join(FEATURE_DIR, 'components', 'initiative-dialog.tsx'),
    'utf8'
  )
  const reportSrc = readFileSync(
    join(FEATURE_DIR, 'components', 'roi-report.tsx'),
    'utf8'
  )

  it('the dialog renders the example line from the shared builder', () => {
    expect(dialogSrc).toMatch(/\bmetricExampleLine\(/)
    expect(dialogSrc).toMatch(/METRIC_EXAMPLE_COPY\.buttonLabel/)
    const stateSrc = readFileSync(
      join(FEATURE_DIR, 'metric-examples-state.ts'),
      'utf8'
    )
    expect(stateSrc).toMatch(/\bmetricExample\(/)
  })

  it('the dialog formats no money of its own, so its number cannot drift from the tile', () => {
    expect(dialogSrc).not.toMatch(/@\/lib\/canon-format/)
    expect(dialogSrc).not.toMatch(/\bformatCost\s*\(/)
    expect(dialogSrc).not.toMatch(/\bformatPct\s*\(/)
    expect(dialogSrc).not.toMatch(/\.toFixed\(/)
  })

  it('the dialog asks for the examples ONCE per opening and caches them for the session', () => {
    expect(dialogSrc).toMatch(/getRoiMetricExamples\(/)
    expect(dialogSrc.match(/getRoiMetricExamples\(/g)).toHaveLength(1)
    expect(dialogSrc).toMatch(/examplesRequested/)
  })

  it('opening a different goal closes any example the last one had open', () => {
    expect(dialogSrc).toMatch(/setExampleRows\(\[\]\)/)
  })

  it('the dialog adds no second scrolling region and no second disclosure', () => {
    const contentStart = dialogSrc.indexOf('<DialogContent')
    const contentBody = dialogSrc.slice(
      contentStart,
      dialogSrc.indexOf('</DialogContent>', contentStart)
    )
    expect(
      contentBody.match(
        /className='flex flex-1 flex-col gap-3 overflow-y-auto pr-1'/g
      )
    ).toHaveLength(1)
    expect(dialogSrc.match(/<details/g)).toHaveLength(1)
    expect(dialogSrc.match(/<summary/g)).toHaveLength(1)
  })

  it('the report tile renders the example through the tile builder, not a second call', () => {
    expect(reportSrc).toMatch(/tile\.example\.line/)
    expect(reportSrc).toMatch(/METRIC_EXAMPLE_COPY\.buttonLabel/)
  })
})
