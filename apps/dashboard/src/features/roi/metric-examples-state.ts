/**
 * The state behind "See an example" in the goal dialog.
 *
 * Outside the component so the node-only unit slice can exercise it; the
 * dialog only fires the read and hands the answer here.
 *
 * The invariant: every answer lands in a state that renders. 'loading' hides
 * the button and the read fires once per session, so a path that leaves the
 * state loading takes the button away for the life of the page.
 */

import {
  METRIC_EXAMPLE_COPY,
  metricExample,
  type ReportMetricValue,
  type ReportWindow,
} from './report-derivation'
import type { InitiativeMetric } from '@/app/actions/initiatives'

export type MetricExamplesState =
  | { status: 'loading' }
  | { status: 'failed'; line: string }
  | {
      status: 'ready'
      window: ReportWindow
      byMetric: Partial<Record<InitiativeMetric, ReportMetricValue>>
    }

/** The shape of getRoiMetricExamples' result, structurally: a lib module
 * must not import from a 'use server' file. */
export type MetricExamplesRead =
  | { ok: true; data: { window: ReportWindow; metrics: ReportMetricValue[] } }
  | { ok: false; error: string }

/** A thrown read has no sentence written for a customer, so it borrows one. */
export const METRIC_EXAMPLES_READ_FAILED: MetricExamplesState = {
  status: 'failed',
  line: METRIC_EXAMPLE_COPY.unavailable,
}

export function metricExamplesState(
  read: MetricExamplesRead
): MetricExamplesState {
  if (!read.ok) {
    // The action's own refusal, which says the role a member is missing.
    // The generic line tells them to refresh, which would never fix it.
    return read.error.trim() === ''
      ? METRIC_EXAMPLES_READ_FAILED
      : { status: 'failed', line: read.error }
  }
  return {
    status: 'ready',
    window: read.data.window,
    byMetric: Object.fromEntries(
      read.data.metrics.map((entry) => [entry.metric, entry])
    ),
  }
}

export function metricExampleLine(
  state: MetricExamplesState,
  metric: InitiativeMetric
): string {
  if (state.status === 'failed') return state.line
  if (state.status === 'loading') return metricExample(null, null).line
  return metricExample(state.byMetric[metric] ?? null, state.window).line
}
