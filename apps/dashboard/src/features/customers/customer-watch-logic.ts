/**
 * WHAT THIS FILE DOES: the pure logic behind the customer page's Alerts
 * section — form validation, the REST payload builder, and the
 * display sentence. It lives outside the section component because the page
 * it mounts on is @ts-nocheck: the compiler can't catch a UUID-vs-externalId
 * mix-up there, so node jest pins it HERE.
 * CONNECTS TO: components/customer-watch-section.tsx (the UI),
 * app/actions/customer-alerts.ts (the write path).
 */

import { formatCost } from '@/lib/canon-format'
import type {
  CustomerWatchView,
  CustomerWatchWriteInput,
} from '@/app/actions/customer-alerts'

export const WATCH_METRICS = ['cost', 'revenue'] as const
export const WATCH_WINDOW_MODES = ['month', 'rolling', 'custom'] as const

export const WATCH_WINDOW_LABELS: Record<string, string> = {
  month: 'This month',
  rolling: 'Last 30 days',
  custom: 'Custom range',
}

export interface WatchFormState {
  metric: string
  /** Raw input-box string; parsed and validated here. */
  threshold: string
  windowMode: string
  /** yyyy-mm-dd from <input type=date>; empty when unused. */
  customStartDate: string
  customEndDate: string
}

export const EMPTY_WATCH_FORM: WatchFormState = {
  metric: 'cost',
  threshold: '',
  windowMode: 'month',
  customStartDate: '',
  customEndDate: '',
}

/**
 * Client-side pre-validation with the same rules api-nest enforces, so most
 * mistakes read instantly instead of after a round trip (api-nest remains the
 * authority — its message wins if they ever disagree).
 */
export function validateWatchForm(form: WatchFormState): string | null {
  const threshold = Number(form.threshold)
  if (!form.threshold.trim() || !Number.isFinite(threshold) || threshold <= 0) {
    return 'Enter a dollar amount above zero for the tripwire.'
  }
  if (!WATCH_METRICS.includes(form.metric as (typeof WATCH_METRICS)[number])) {
    return 'Pick cost or revenue.'
  }
  if (
    !WATCH_WINDOW_MODES.includes(
      form.windowMode as (typeof WATCH_WINDOW_MODES)[number]
    )
  ) {
    return 'Pick a window.'
  }
  if (form.windowMode === 'custom') {
    if (!form.customStartDate || !form.customEndDate) {
      return 'A custom window needs both a start and an end date.'
    }
    if (form.customStartDate >= form.customEndDate) {
      return 'The start date must be before the end date.'
    }
  }
  return null
}

/**
 * The write payload. The identifier rule this file exists to pin: the watch
 * targets the INTERNAL customer UUID (the page's route param), NEVER
 * externalId — api-nest looks the customer up by (id, organizationId).
 * Custom dates convert yyyy-mm-dd to UTC instants (start of the first day,
 * END of the last day, so "to Aug 31" includes Aug 31 — matching what a
 * person means by an end date).
 */
export function buildWatchWriteInput(
  form: WatchFormState
): CustomerWatchWriteInput {
  const input: CustomerWatchWriteInput = {
    metric: form.metric,
    thresholdUsd: Number(form.threshold),
    windowMode: form.windowMode,
  }
  if (form.windowMode === 'custom') {
    input.customStartDate = `${form.customStartDate}T00:00:00.000Z`
    input.customEndDate = `${form.customEndDate}T23:59:59.999Z`
  }
  return input
}

/** "Email me when cost passes $500.00 (This month)" — one sentence per watch row. */
export function watchSentence(watch: CustomerWatchView): string {
  const window = WATCH_WINDOW_LABELS[watch.windowMode] ?? watch.windowMode
  return `Email when ${watch.metric} passes ${formatCost(watch.thresholdUsd)} (${window})`
}

/** "Aug 1, 2026 to Aug 31, 2026 (UTC)" for a custom-window row's second line. */
export function customRangeLine(watch: CustomerWatchView): string | null {
  if (
    watch.windowMode !== 'custom' ||
    !watch.customStartDate ||
    !watch.customEndDate
  ) {
    return null
  }
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  return `${fmt(watch.customStartDate)} to ${fmt(watch.customEndDate)} (UTC)`
}

/** Pre-fill the edit form from an existing watch (ISO dates back to yyyy-mm-dd). */
export function watchToForm(watch: CustomerWatchView): WatchFormState {
  return {
    metric: watch.metric,
    threshold: String(watch.thresholdUsd),
    windowMode: watch.windowMode,
    customStartDate: watch.customStartDate
      ? watch.customStartDate.slice(0, 10)
      : '',
    customEndDate: watch.customEndDate ? watch.customEndDate.slice(0, 10) : '',
  }
}
