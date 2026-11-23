'use client'

/**
 * Shared chart palettes, small display components and breakdown export
 * helpers. Colors are CSS variables from src/index.css, not hardcoded hex,
 * so they follow the app theme in both modes.
 */

import React from 'react'
import { format } from 'date-fns'
import { Badge } from '@/components/ui/badge'

// The breakdown date-range presets used by the export helpers below.
type DatePreset =
  | 'last7'
  | 'last30'
  | 'last60'
  | 'last90'
  | 'ytd'
  | 'allTime'
  | 'custom'

// ─────────────────────────────────────────────
// AGENT PALETTE
// ─────────────────────────────────────────────
// Each agent gets its own color from the chart variable palette.
// These map to --chart-1 through --chart-3 in the CSS theme.
export const AGENT_PALETTE = {
  Research: { color: 'hsl(var(--chart-1))', label: 'Research' },
  Support: { color: 'hsl(var(--chart-3))', label: 'Support' },
  Onboarding: { color: 'hsl(var(--chart-4))', label: 'Onboarding' },
} as const

// Chart colors for breakdowns — uses the 5 built-in chart CSS variables
export const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-1) / 0.7)',
  'hsl(var(--chart-2) / 0.7)',
  'hsl(var(--chart-3) / 0.7)',
  'hsl(var(--chart-4) / 0.7)',
  'hsl(var(--chart-5) / 0.7)',
]

// Status colors used across revenue and invoicing views
export const STATUS_COLORS = {
  paid: 'hsl(var(--chart-1))',
  pending: 'hsl(var(--chart-2))',
  overdue: 'hsl(var(--destructive))',
  draft: 'hsl(var(--muted-foreground))',
  sent: 'hsl(var(--chart-3))',
  partial: 'hsl(var(--chart-2) / 0.7)',
} as const

// ─────────────────────────────────────────────
// DETERMINISTIC SEED
// ─────────────────────────────────────────────
// Math.random() causes Next.js hydration mismatches because the
// server and client generate different values → blank charts.
// This hash function gives realistic variation, same result every render.
export const seed = (n: number) =>
  (((Math.sin(n * 127.1 + 311.7) * 43758.5453) % 1) + 1) % 1

// ─────────────────────────────────────────────
// SHARED COMPONENTS
// ─────────────────────────────────────────────

// Small colored badge showing which agent did the work
export const AgentBadge = ({ name }: { name: string }) => {
  const palette = AGENT_PALETTE[name as keyof typeof AGENT_PALETTE]
  const color = palette?.color || 'hsl(var(--chart-3))'
  return (
    <Badge
      variant='outline'
      className='text-[10px] font-semibold'
      style={{ color, borderColor: color }}
    >
      {name}
    </Badge>
  )
}

// Arrow + percentage showing trend direction.
// Default ('higher-is-better'): up=green (good), down=red (bad).
// Set trendDirection='lower-is-better' for cost trends where down=good.
// isNewAgent renders a "NEW" badge instead of an arrow, for an agent with
// current-window activity and no prior-window activity, where a percent
// trend is undefined.
export const TrendBadge = ({
  value,
  trendDirection = 'higher-is-better',
  isNewAgent = false,
}: {
  value: number | null
  trendDirection?: 'higher-is-better' | 'lower-is-better'
  isNewAgent?: boolean
}) => {
  if (isNewAgent) {
    return (
      <span className='text-[10px] font-bold text-muted-foreground'>NEW</span>
    )
  }
  if (value === null || value === 0)
    return <span className='text-[10px] text-muted-foreground'>—</span>
  const isUp = value > 0
  const isGood = trendDirection === 'higher-is-better' ? isUp : !isUp
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${isGood ? 'text-emerald-400' : 'text-destructive'}`}
    >
      {isUp ? '▲' : '▼'} {Math.abs(value).toFixed(2)}%
    </span>
  )
}

// Margin-aware trend: green when margin improves, red when it drops
// (opposite of cost trend — higher margin = good)
export const MarginTrendBadge = ({ value }: { value: number }) => {
  if (value === 0)
    return <span className='text-[10px] text-muted-foreground'>—</span>
  const isUp = value > 0
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${isUp ? 'text-emerald-400' : 'text-destructive'}`}
    >
      {isUp ? '▲' : '▼'} {Math.abs(value).toFixed(2)}%
    </span>
  )
}

export const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className='rounded-lg border border-border bg-card p-3 shadow-lg'>
      <p className='mb-2 text-[10px] font-semibold text-muted-foreground'>
        {label}
      </p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className='flex items-center gap-3 py-0.5'>
          <div
            className='h-2 w-2 rounded-full'
            style={{ background: entry.color }}
          />
          <span className='text-[11px] text-muted-foreground'>
            {entry.name}
          </span>
          <span className='ml-auto text-[11px] font-bold text-foreground'>
            $
            {typeof entry.value === 'number'
              ? entry.value.toFixed(2)
              : entry.value}
          </span>
        </div>
      ))}
    </div>
  )
}

export const StatusPill = ({
  status,
}: {
  status: keyof typeof STATUS_COLORS
}) => {
  const color = STATUS_COLORS[status] || STATUS_COLORS.draft
  return (
    <Badge
      variant='outline'
      className='text-[9px] font-bold uppercase'
      style={{ color, borderColor: color }}
    >
      {status}
    </Badge>
  )
}

/**
 * Which dollar-amount label each breakdown tab uses. Customer + Plan
 * map directly to invoice records (Billed). Service/Task/Agent are
 * per-activity dimensions that attribute via per-event calcRouted
 * (Earned).
 */
export type BreakdownView =
  | 'service'
  | 'task'
  | 'agent'
  | 'customer'
  | 'plan'
  | 'invoices'

export const BILLED_VIEWS = new Set<BreakdownView>(['customer', 'plan'])

export function amountLabelFor(view: BreakdownView): 'Billed' | 'Earned' {
  return BILLED_VIEWS.has(view) ? 'Billed' : 'Earned'
}

/**
 * Format a breakdown filter boundary for a server call.
 *
 * Rolling presets send a full ISO timestamp so the window's start lands on
 * the tile's exact now()-30d moment instead of being floored to UTC
 * midnight; flooring would pull in an extra leading slice and push the
 * table/export totals above the tile. Custom calendar ranges send a bare
 * YYYY-MM-DD so parseWindowFilter still expands the end to 23:59:59.999 and
 * keeps the chosen end day inclusive (a full ISO timestamp would cut it off).
 */
export function formatBreakdownFilterDate(d: Date, preset: DatePreset): string {
  return preset === 'custom' ? format(d, 'yyyy-MM-dd') : d.toISOString()
}

/**
 * Triggers a server-generated XLSX download of every breakdown tab for
 * the given filter window. Runs via /api/export/breakdown so orgs with
 * thousands of events don't freeze the browser.
 */
export async function downloadBreakdownExport(filters: {
  startDate: Date
  endDate: Date
  customerId?: string
  agentId?: string
  datePreset?: DatePreset
}): Promise<void> {
  // Match the on-screen table's window exactly: rolling presets export the
  // ISO now()-30d window, custom ranges keep the end-of-day-inclusive bare
  // date. Callers that don't pass a preset get the bare UTC date.
  const toParam = (d: Date) =>
    filters.datePreset
      ? formatBreakdownFilterDate(d, filters.datePreset)
      : d.toISOString().slice(0, 10)
  const params = new URLSearchParams({
    start: toParam(filters.startDate),
    end: toParam(filters.endDate),
  })
  if (filters.customerId) params.set('customer', filters.customerId)
  if (filters.agentId) params.set('agent', filters.agentId)
  const res = await fetch(`/api/export/breakdown?${params.toString()}`)
  if (!res.ok) {
    console.error('breakdown export failed:', res.status, await res.text())
    return
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `marginfront-breakdown-${new Date().toISOString().slice(0, 10)}.xlsx`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export interface BreakdownCsvExportOptions {
  dimension: string
  startDate?: string
  endDate?: string
  columns: string[]
}

/**
 * Triggers a server-generated CSV download of ONE breakdown dimension for
 * the given window + column selection — the "Custom CSV export…" path from
 * the Money options dialog, beside downloadBreakdownExport's one-click XLSX
 * above.
 *
 * Returns a result instead of only console.error-ing on failure (unlike
 * downloadBreakdownExport) because this is a dialog flow — the user picked
 * options and is waiting on this click, so a validation error (e.g. an
 * incomplete custom date range slipping past the dialog) needs to reach
 * them, not only the console.
 */
export async function downloadBreakdownCsv(
  options: BreakdownCsvExportOptions
): Promise<{ ok: true } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    format: 'csv',
    dimension: options.dimension,
  })
  if (options.startDate) params.set('startDate', options.startDate)
  if (options.endDate) params.set('endDate', options.endDate)
  if (options.columns.length > 0)
    params.set('columns', options.columns.join(','))

  const res = await fetch(`/api/export/breakdown?${params.toString()}`)
  if (!res.ok) {
    const body = await res.text()
    let message = body
    try {
      message = JSON.parse(body).error ?? body
    } catch {
      // Body wasn't JSON — fall back to the raw text above.
    }
    console.error('breakdown CSV export failed:', res.status, body)
    return { ok: false, error: message || `Export failed (${res.status})` }
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `marginfront-money-breakdown-${options.dimension}-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  return { ok: true }
}
