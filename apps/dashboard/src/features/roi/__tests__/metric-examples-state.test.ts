/**
 * The state behind "See an example".
 *
 * Two rules this suite keeps: the read fires once per session, so every
 * answer has to land in a state that renders or the button never comes back;
 * and a refusal reads as a refusal rather than as advice to refresh.
 *
 * Node-only, no DB, no mocks. The dialog is a client component this slice
 * cannot render, so the wiring it holds is pinned against its source.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  METRIC_EXAMPLE_COPY,
  metricExample,
  type ReportMetricValue,
} from '../report-derivation'
import {
  METRIC_EXAMPLES_READ_FAILED,
  metricExampleLine,
  metricExamplesState,
  type MetricExamplesState,
} from '../metric-examples-state'
import { INITIATIVE_METRIC_META } from '../progress-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

const WINDOW = { startDate: '2026-08-19', endDate: '2026-09-18' }

const ALL_METRICS = Object.keys(INITIATIVE_METRIC_META) as InitiativeMetric[]

const READ: ReportMetricValue[] = ALL_METRICS.map((metric) => ({
  metric,
  value: 12.5,
  unavailable: null,
}))

const REFUSAL =
  "You don't have access to this report. Reading it takes the finance, admin, or owner role. Ask an owner on your team to change yours."

describe('every answer the read can give lands in a state that renders', () => {
  it('a successful read is ready, with all twelve values keyed by metric', () => {
    const state = metricExamplesState({
      ok: true,
      data: { window: WINDOW, metrics: READ },
    })
    expect(state.status).toBe('ready')
    if (state.status !== 'ready') return
    expect(Object.keys(state.byMetric).sort()).toEqual([...ALL_METRICS].sort())
    expect(state.window).toEqual(WINDOW)
  })

  it('a refused read is failed, and a failed read is not loading', () => {
    const state = metricExamplesState({ ok: false, error: REFUSAL })
    expect(state.status).toBe('failed')
  })

  it('no result of any kind leaves the state loading, because loading is the state that hides the button', () => {
    const outcomes: MetricExamplesState[] = [
      metricExamplesState({ ok: true, data: { window: WINDOW, metrics: [] } }),
      metricExamplesState({ ok: false, error: REFUSAL }),
      metricExamplesState({ ok: false, error: '' }),
      METRIC_EXAMPLES_READ_FAILED,
    ]
    for (const state of outcomes) {
      expect(state.status).not.toBe('loading')
    }
  })
})

describe('a refusal reads as a refusal, not as advice that cannot work', () => {
  it('the reader sees the sentence the action sent, on every metric', () => {
    const state = metricExamplesState({ ok: false, error: REFUSAL })
    for (const metric of ALL_METRICS) {
      expect(metricExampleLine(state, metric)).toBe(REFUSAL)
    }
  })

  it('a member without the money role is never told that refreshing fixes it', () => {
    const state = metricExamplesState({ ok: false, error: REFUSAL })
    expect(metricExampleLine(state, 'cost')).not.toBe(
      METRIC_EXAMPLE_COPY.unavailable
    )
    expect(metricExampleLine(state, 'cost')).not.toMatch(/refresh/i)
  })

  it('a read that failed for a reason worth retrying keeps its own sentence too', () => {
    const readFailed = "Couldn't load the report. Refresh to try again."
    const state = metricExamplesState({ ok: false, error: readFailed })
    expect(metricExampleLine(state, 'revenue')).toBe(readFailed)
  })

  it('a refusal with no sentence in it falls back to the generic line rather than rendering nothing', () => {
    for (const blank of ['', '   ']) {
      const state = metricExamplesState({ ok: false, error: blank })
      expect(metricExampleLine(state, 'cost')).toBe(
        METRIC_EXAMPLE_COPY.unavailable
      )
    }
  })

  it('a read that threw carries the generic line, because a thrown error has no sentence for a customer', () => {
    expect(metricExampleLine(METRIC_EXAMPLES_READ_FAILED, 'cost')).toBe(
      METRIC_EXAMPLE_COPY.unavailable
    )
  })
})

describe('a ready state renders the shared builder, number for number', () => {
  const state = metricExamplesState({
    ok: true,
    data: { window: WINDOW, metrics: READ },
  })

  it.each(ALL_METRICS)(
    '%s reads the line the report tile builds from the same entry',
    (metric) => {
      expect(metricExampleLine(state, metric)).toBe(
        metricExample({ metric, value: 12.5, unavailable: null }, WINDOW).line
      )
    }
  )

  it('a metric the read did not answer for says so, and invents no number', () => {
    const thin = metricExamplesState({
      ok: true,
      data: { window: WINDOW, metrics: [READ[0]] },
    })
    expect(metricExampleLine(thin, 'arr')).toBe(METRIC_EXAMPLE_COPY.unavailable)
  })

  it('the loading state shows no number either, so nothing appears before the read lands', () => {
    expect(metricExampleLine({ status: 'loading' }, 'cost')).toBe(
      METRIC_EXAMPLE_COPY.unavailable
    )
  })
})

describe('the dialog keeps the button reachable for the life of the page', () => {
  const dialogSrc = readFileSync(
    join(__dirname, '..', 'components', 'initiative-dialog.tsx'),
    'utf8'
  )
  const readStart = dialogSrc.lastIndexOf(
    'useEffect(',
    dialogSrc.indexOf('getRoiMetricExamples(')
  )
  const readEffect = dialogSrc.slice(
    readStart,
    dialogSrc.indexOf('}, [open])', readStart)
  )

  it('the effect that fires the read was found, so the pins below are pinning something', () => {
    expect(readStart).toBeGreaterThan(-1)
    expect(readEffect).toContain('getRoiMetricExamples(')
    expect(readEffect.length).toBeLessThan(1200)
  })

  it('closing the dialog mid-read never discards the answer: no cancellation flag and no cleanup on that effect', () => {
    expect(readEffect).not.toMatch(/cancelled/)
    expect(readEffect).not.toMatch(/return \(\) =>/)
  })

  it('the read is still fired once per session', () => {
    expect(dialogSrc.match(/getRoiMetricExamples\(/g)).toHaveLength(1)
    expect(dialogSrc).toMatch(/examplesRequested/)
  })

  it('nothing after the first render can put the dialog back into the state that hides the button', () => {
    expect(dialogSrc.match(/status: 'loading'/g)).toHaveLength(1)
    expect(dialogSrc).toMatch(/useState<MetricExamplesState>\(/)
  })

  it('the dialog builds neither the state nor the line itself', () => {
    expect(dialogSrc).toMatch(/metricExamplesState\(result\)/)
    expect(dialogSrc).toMatch(/metricExampleLine\(/)
    expect(dialogSrc).not.toMatch(/status: 'failed'/)
    expect(dialogSrc).not.toMatch(/status: 'ready'/)
  })
})
