/**
 * Client-safe types, copy, and pure mapping for the repo/branch spend
 * section. Mirrors spend-controls-utils.ts: no React, no
 * `@marginfront/db` (a 'use client' import of that package drags Prisma into
 * the browser bundle). The wire shape mirrors the API's
 * GET /control/spend/breakdown response; the honest-null contract carries
 * through untouched — null spend is absence, never a coerced 0.
 */

import { csvCell } from '@/app/api/export/journal/csv'
import { formatCost } from '@/lib/canon-format'
import type { CapPeriod } from './spend-controls-types'

export const SPEND_BREAKDOWN_DIMENSIONS = ['repo', 'branch'] as const
export type SpendBreakdownDimension =
  (typeof SPEND_BREAKDOWN_DIMENSIONS)[number]

export interface SpendBreakdownBucket {
  /** null = no priced usage in this bucket (honest absence, never $0). */
  spentUsd: number | null
  eventCount: number
  unpricedEventCount: number
}

export interface SpendBreakdownRow extends SpendBreakdownBucket {
  /** 'owner/repo' for the repo dimension; 'owner/repo#branch' for branch. */
  key: string
}

/** The API's GET /control/spend/breakdown response, verbatim. */
export interface SpendBreakdownData {
  dimension: SpendBreakdownDimension
  period: CapPeriod
  window: { start: string; end: string }
  asOf: string
  totals: SpendBreakdownBucket
  rows: SpendBreakdownRow[]
  noMetadata: SpendBreakdownBucket
  /** Percent of events carrying the repo/branch keys; null on an empty window. */
  coveragePercent: number | null
}

/** What the server action hands the section. */
export interface SpendBreakdownResult {
  breakdown: SpendBreakdownData
}

/** One (commit, teammate) line inside a branch drill. commitSha is
 * null when the meter didn't capture a commit for that work; member is the
 * teammate's email (signal_events.customerExternalId). */
export interface SpendBreakdownDrillRow {
  commitSha: string | null
  member: string
  spentUsd: number | null
  eventCount: number
  unpricedEventCount: number
}

/** The API's GET /control/spend/breakdown/drill response, verbatim. `totals` MUST
 * equal the drilled branch's own row in GET /control/spend/breakdown (same
 * events, same filter), which is the drill's core accuracy guarantee. */
export interface SpendBreakdownDrillData {
  branchKey: string
  period: CapPeriod
  window: { start: string; end: string }
  asOf: string
  rows: SpendBreakdownDrillRow[]
  totals: SpendBreakdownBucket
}

/** What the drill server action hands the section. */
export interface SpendBreakdownDrillResult {
  drill: SpendBreakdownDrillData
}

// ── Copy (every visible string lives here so the copy-style gate covers it) ────────

export const REPO_SPEND_TITLE = 'Where the AI spend went'

export const REPO_SPEND_INTRO =
  "Your team's internal AI spend, grouped by the git repo or branch you " +
  'were working in.'

export const REPO_SPEND_EXPLAINER_TITLE = 'How these numbers work'

export const REPO_SPEND_EXPLAINER_HOW =
  "The meter on each teammate's machine records their AI spend and " +
  'stamps the git repo and branch they were working in. The server prices ' +
  'each event it has a rate for and keeps this internal spend separate ' +
  'from your customer billing.'

export const REPO_SPEND_EXPLAINER_PR =
  "A pull request is opened from a branch, so a branch's spend is the " +
  "closest stand-in for that pull request's cost. Treat it as a rough " +
  'figure, not an exact number: it runs low when work happened before the ' +
  'branch was created (that lands under whichever branch was checked out, ' +
  'usually main), and it runs high when one branch carried several pull ' +
  'requests.'

export const REPO_SPEND_EXPLAINER_COVERAGE =
  'The coverage line says how many coding events carried that stamp. ' +
  'Events without one sit in the "No repo recorded" (or "No branch ' +
  'recorded") row: sessions the meter sent but ' +
  "couldn't place, such as a folder outside any checkout or a " +
  'checkout with no origin remote, plus usage from before repo ' +
  'tracking existed. A repo a teammate keeps off the meter never ' +
  'appears here at all.'

export const REPO_SPEND_PERIOD_NOTE =
  'Periods run on UTC (universal) time, the same clock your spend caps use.'

export const REPO_SPEND_ERROR_LINE =
  "We couldn't load the spend breakdown. Refresh to try again."

export const EMPTY_NO_ACTIVITY =
  'No internal AI spend recorded for this period yet.'

export const EXPORT_CSV_LABEL = 'Download CSV'

export const NO_KEY_LABELS: Record<SpendBreakdownDimension, string> = {
  repo: 'No repo recorded',
  branch: 'No branch recorded',
}

export const NO_KEY_ROW_NOTES: Record<SpendBreakdownDimension, string> = {
  repo: "Sessions the meter sent but couldn't place in a repo, plus usage from before repo tracking existed. A repo kept off the meter never appears here.",
  branch:
    "Sessions the meter sent but couldn't read a branch from (a detached HEAD, or no repo at all), plus usage from before repo tracking existed.",
}

export interface DimensionChoice {
  id: SpendBreakdownDimension
  label: string
  columnHeader: string
}

export const DIMENSION_CHOICES: readonly DimensionChoice[] = [
  { id: 'repo', label: 'By repo', columnHeader: 'Repo' },
  { id: 'branch', label: 'By branch', columnHeader: 'Branch' },
]

export interface PeriodChoice {
  id: CapPeriod
  label: string
}

export const PERIOD_CHOICES: readonly PeriodChoice[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
]

export const BREAKDOWN_COLUMN_HEADERS = {
  spend: 'Spend',
  share: 'Share of spend',
  events: 'Events',
} as const

// ── Branch drill copy ────────────────────────────────────────────

export const DRILL_COLUMN_HEADERS = {
  commit: 'Commit',
  member: 'Teammate',
  cost: 'Cost',
} as const

/** Rendered when the meter didn't capture a commit for that work. */
export const NO_COMMIT_RECORDED = 'No commit recorded'

export const DRILL_EXPAND_LABEL = 'Show commits and teammates for this branch'

export const DRILL_COLLAPSE_LABEL = 'Hide commits and teammates for this branch'

export const DRILL_ERROR_LINE =
  "We couldn't load this branch's detail. Collapse and expand it to try again."

export const DRILL_EMPTY_LINE =
  'No commit-level spend recorded for this branch yet.'

/** The two honesty caveats that ride under every branch drill: cost is grouped
 * by the checked-out (parent) commit, and commits only appear when the meter
 * captured git for the session. No em dashes, contractions on. */
export const DRILL_CAVEAT_NOTE =
  'Cost is grouped by the commit that was checked out while the work ' +
  'happened, usually the parent of the commit it produced. Commits only ' +
  'show up for sessions where the meter captured git.'

// ── Pure mapping ─────────────────────────────────────────────────────────────

export interface BranchKeyParts {
  repo: string | null
  branch: string
}

/** Branch keys are composite 'owner/repo#branch' (the API keys them that way so
 * 'main' in two repos stays two rows). Split on the FIRST '#': a normalized
 * 'owner/repo' never contains '#', but a branch name can. */
export function splitBranchKey(key: string): BranchKeyParts {
  const hashIndex = key.indexOf('#')
  if (hashIndex === -1) return { repo: null, branch: key }
  return { repo: key.slice(0, hashIndex), branch: key.slice(hashIndex + 1) }
}

export function spendCellText(spentUsd: number | null): string {
  return spentUsd === null ? 'No priced spend yet' : formatCost(spentUsd)
}

/** Short commit sha for a drill row, or the honest "No commit recorded" when
 * the meter captured no commit (never a blank cell or a fake zero-sha). */
export function commitCellText(commitSha: string | null): string {
  if (!commitSha) return NO_COMMIT_RECORDED
  return commitSha.slice(0, 7)
}

/** Share of the period's priced spend; '' whenever either side is unpriced
 * (an empty cell is honest absence — a dash glyph or 0% would be a claim). */
export function shareCellText(
  spentUsd: number | null,
  totalPricedUsd: number | null
): string {
  if (spentUsd === null || totalPricedUsd === null || totalPricedUsd <= 0) {
    return ''
  }
  return `${((spentUsd / totalPricedUsd) * 100).toFixed(1)}%`
}

export interface DisplayRow {
  key: string | null
  label: string
  /** The repo a branch row belongs to; null on repo rows and the no-key row. */
  repoContext: string | null
  spentUsd: number | null
  spendText: string
  shareText: string
  events: number
  unpricedEvents: number
}

export interface BreakdownRows {
  rows: DisplayRow[]
  /** The honest bucket for events with no repo/branch recorded, rendered
   * pinned below the sortable rows; null when the bucket is empty. */
  noKeyRow: DisplayRow | null
}

export function buildBreakdownRows(data: SpendBreakdownData): BreakdownRows {
  const total = data.totals.spentUsd
  const toDisplay = (
    key: string | null,
    label: string,
    repoContext: string | null,
    bucket: SpendBreakdownBucket
  ): DisplayRow => ({
    key,
    label,
    repoContext,
    spentUsd: bucket.spentUsd,
    spendText: spendCellText(bucket.spentUsd),
    shareText: shareCellText(bucket.spentUsd, total),
    events: bucket.eventCount,
    unpricedEvents: bucket.unpricedEventCount,
  })

  const rows = data.rows.map((row) => {
    if (data.dimension === 'branch') {
      const parts = splitBranchKey(row.key)
      return toDisplay(row.key, parts.branch, parts.repo, row)
    }
    return toDisplay(row.key, row.key, null, row)
  })

  const noKeyRow =
    data.noMetadata.eventCount > 0
      ? toDisplay(null, NO_KEY_LABELS[data.dimension], null, data.noMetadata)
      : null

  return { rows, noKeyRow }
}

export type BreakdownSortKey = 'label' | 'spend' | 'events'
export type BreakdownSortDirection = 'asc' | 'desc'

/** Stable client sort. Null spend always sorts LAST: absence never outranks
 * a real number in either direction. */
export function sortDisplayRows(
  rows: readonly DisplayRow[],
  key: BreakdownSortKey,
  direction: BreakdownSortDirection
): DisplayRow[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === 'label') return sign * a.label.localeCompare(b.label)
    if (key === 'events') return sign * (a.events - b.events)
    if (a.spentUsd === null && b.spentUsd === null) {
      return a.label.localeCompare(b.label)
    }
    if (a.spentUsd === null) return 1
    if (b.spentUsd === null) return -1
    return sign * (a.spentUsd - b.spentUsd)
  })
}

export function coverageLine(
  coveragePercent: number | null,
  dimension: SpendBreakdownDimension
): string {
  if (coveragePercent === null) return ''
  if (coveragePercent >= 100) {
    return `Every coding event this period has a ${dimension} recorded.`
  }
  // Clamp to 1..99 (0 only when truly zero): 99.6 must not round up to an
  // "Every" claim while a "No <dimension> recorded" row sits in the table,
  // and 0.4 must not round down to a 0% denial of tagged rows that exist.
  const rounded =
    coveragePercent <= 0
      ? 0
      : Math.min(99, Math.max(1, Math.round(coveragePercent)))
  return (
    `${rounded}% of the coding events this period have a ${dimension} ` +
    `recorded. The rest happened before ${dimension} tracking started or ` +
    `outside a tracked project folder, and they show under ` +
    `"${NO_KEY_LABELS[dimension]}".`
  )
}

export function noTaggedLine(dimension: SpendBreakdownDimension): string {
  return (
    `No ${dimension}-tagged AI spend yet this period. Events recorded ` +
    `before ${dimension} tracking started, or outside a tracked project ` +
    `folder, show under "${NO_KEY_LABELS[dimension]}".`
  )
}

export function totalsLine(totals: SpendBreakdownBucket): string {
  if (totals.spentUsd === null) return 'No priced spend for this period yet.'
  const noun = totals.eventCount === 1 ? 'coding event' : 'coding events'
  return `${formatCost(totals.spentUsd)} across ${totals.eventCount} ${noun} this period`
}

// ── CSV export ───────────────────────────────────────────────────────────────

/** CSV of the currently loaded breakdown. Null spend and null share export as
 * EMPTY fields — a 0 in a spreadsheet is a number someone will sum. Rows keep
 * the full composite key so branch identity survives the export. Every cell
 * rides csvCell, the app's one CSV escaper + formula-injection guard (a
 * branch can be named anything, including a spreadsheet formula). */
export function breakdownCsv(data: SpendBreakdownData): string {
  const total = data.totals.spentUsd
  const header = `${data.dimension},spent_usd,share_of_priced_spend_percent,events,events_without_price`
  const toLine = (key: string, bucket: SpendBreakdownBucket): string => {
    const spend = bucket.spentUsd === null ? '' : String(bucket.spentUsd)
    const share =
      bucket.spentUsd === null || total === null || total <= 0
        ? ''
        : ((bucket.spentUsd / total) * 100).toFixed(1)
    return [
      csvCell(key),
      spend,
      share,
      String(bucket.eventCount),
      String(bucket.unpricedEventCount),
    ].join(',')
  }
  const lines = [header, ...data.rows.map((row) => toLine(row.key, row))]
  if (data.noMetadata.eventCount > 0) {
    lines.push(toLine(NO_KEY_LABELS[data.dimension], data.noMetadata))
  }
  return lines.join('\n')
}

export function csvFileName(
  dimension: SpendBreakdownDimension,
  period: CapPeriod
): string {
  return `internal-coding-spend-by-${dimension}-${period}.csv`
}
