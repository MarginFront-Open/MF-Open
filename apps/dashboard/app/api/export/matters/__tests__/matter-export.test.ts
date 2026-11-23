/**
 * WHAT THIS FILE DOES: pins the audit-export contract — the
 * reconciliation partition (every matter + Unassigned sums to the org total,
 * nothing leaks, nothing double-counts), the exact detail columns,
 * an attribution source on EVERY row, blank-not-zero for unresolved costs,
 * and formula-injection defense on org-controlled strings.
 *
 * WHY IT EXISTS: this CSV is the record a firm shows a carrier auditor. If
 * the partition breaks, the firm's AI bill stops being provable; if a cell
 * executes in Excel, the auditor's machine runs org-supplied code.
 *
 * CONNECTS TO: src/features/law/matter-export-utils.ts (buildMatterExport),
 * ../csv.ts (the builders), ../../journal/csv.ts (csvCell, reused).
 */

import {
  buildMatterExport,
  type MatterExportEventInput,
} from '@/features/law/matter-export-utils'
import { toMatterSummaryCsv, toMatterDetailCsv } from '../csv'

const WINDOW_START = new Date('2026-08-01T00:00:00.000Z')
const WINDOW_END = new Date('2026-08-31T23:59:59.999Z')

/** Quote-aware CSV row split — a naive split(',') breaks on the injection
 * fixture's quoted cell, which legitimately contains commas. */
function splitCsvRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells
}

const MATTER_A = {
  matterNumber: 'MAT-2214',
  name: 'Hartley v. Grange',
  clientName: 'Hartley Trust',
}
// Org-controlled string opening with '=' — the CWE-1236 probe.
const MATTER_EVIL = {
  matterNumber: '=HYPERLINK("http://evil","x")',
  name: 'Injection Probe',
  clientName: 'B Client',
}

function ev(
  overrides: Partial<MatterExportEventInput>
): MatterExportEventInput {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2, 8),
    usageDate: new Date('2026-08-10T12:00:00.000Z'),
    quantity: 1,
    usageCost: 1,
    matterSource: null,
    agentName: 'intake-agent',
    signalName: 'Contract Review',
    models: ['claude-sonnet-5'],
    matter: null,
    ...overrides,
  }
}

const FIXTURE: MatterExportEventInput[] = [
  ev({ id: 'e1', matter: MATTER_A, matterSource: 'tag', usageCost: 0.000123 }),
  ev({
    id: 'e2',
    matter: MATTER_A,
    matterSource: 'rule',
    usageCost: 1.25,
    models: ['claude-sonnet-5', 'gpt-6', 'claude-sonnet-5'],
  }),
  ev({ id: 'e3', matter: MATTER_EVIL, matterSource: 'manual', usageCost: 2.5 }),
  ev({ id: 'e4', usageCost: 0.5 }),
  // Cost never resolved AND manually unassigned by an operator.
  ev({ id: 'e5', usageCost: null, matterSource: 'manual', quantity: null }),
]

describe('buildMatterExport — the reconciliation partition', () => {
  const data = buildMatterExport(FIXTURE, WINDOW_START, WINDOW_END)

  it('every event lands in exactly one summary row; counts partition the total', () => {
    expect(data.totalEvents).toBe(5)
    expect(data.summary.reduce((s, r) => s + r.eventCount, 0)).toBe(5)
  })

  it('summary costs + Unassigned sum to the org total (nulls contribute 0, like getCostMetrics)', () => {
    const summarySum = data.summary.reduce((s, r) => s + r.cost, 0)
    expect(summarySum).toBeCloseTo(data.totalCost, 10)
    expect(data.totalCost).toBeCloseTo(0.000123 + 1.25 + 2.5 + 0.5, 10)
  })

  it('the Unassigned row exists, sits LAST, and includes the manually-unassigned event', () => {
    const last = data.summary[data.summary.length - 1]
    expect(last.matterNumber).toBeNull()
    expect(last.eventCount).toBe(2)
    expect(last.cost).toBeCloseTo(0.5, 10)
  })

  it('flags unresolved costs instead of inventing zeros', () => {
    expect(data.eventsMissingCost).toBe(1)
    const unassigned = data.summary[data.summary.length - 1]
    expect(unassigned.eventsMissingCost).toBe(1)
  })

  it('joins DISTINCT child models; the event stays one row', () => {
    const multi = data.rows.find((r) => r.eventId === 'e2')
    expect(multi?.models).toBe('claude-sonnet-5; gpt-6')
    expect(data.rows).toHaveLength(5)
  })
})

describe('toMatterDetailCsv — the audit-trail rows', () => {
  const data = buildMatterExport(FIXTURE, WINDOW_START, WINDOW_END)
  const lines = toMatterDetailCsv(data).split('\n')

  it('carries the exact columns in order', () => {
    expect(lines[0]).toBe(
      'Matter Number,Client,Usage Date,Agent,Signal,Service/Model,Quantity,Actual Cost (USD),Attribution Source,Event ID'
    )
  })

  it('emits one row per event with an attribution source on EVERY row', () => {
    expect(lines).toHaveLength(1 + 5)
    // Not .at(-2): the dashboard tsconfig lib is ES2020 and .at() is ES2022 —
    // it transpiles under jest but fails tsc --noEmit.
    const sources = lines.slice(1).map((l) => {
      const cells = splitCsvRow(l)
      return cells[cells.length - 2]
    })
    for (const source of sources) {
      expect(['tag', 'rule', 'manual', 'unassigned']).toContain(source)
    }
    expect(sources).toEqual(
      expect.arrayContaining(['tag', 'rule', 'manual', 'unassigned'])
    )
  })

  it('exports a NULL cost as a blank cell, never 0.000000', () => {
    const nullCostLine = lines.find((l) => l.includes('e5'))!
    const cells = splitCsvRow(nullCostLine)
    expect(cells[7]).toBe('')
  })

  it('neutralizes a formula-shaped matter number (CWE-1236)', () => {
    const evilLine = lines.find(
      (l) => l.includes('Injection Probe') || l.includes('e3')
    )!
    // csvCell prefixes a quote INSIDE the RFC-4180 quoting, so the cell can
    // never start with a live '=' when a spreadsheet parses it.
    expect(evilLine.startsWith('"\'=')).toBe(true)
  })
})

describe('toMatterSummaryCsv — the reconciliation view', () => {
  const data = buildMatterExport(FIXTURE, WINDOW_START, WINDOW_END)
  const lines = toMatterSummaryCsv(data).split('\n')

  it('ends with a TOTAL row carrying the full-precision org total', () => {
    const total = splitCsvRow(lines[lines.length - 1])
    expect(total[0]).toBe('TOTAL')
    expect(total[3]).toBe(data.totalCost.toFixed(6))
  })

  it('labels the null-matter row UNASSIGNED', () => {
    const unassignedLine = lines[lines.length - 2]
    expect(unassignedLine.startsWith('UNASSIGNED,Unassigned,')).toBe(true)
  })

  it('summary cost cells re-sum to the TOTAL cell at 6-decimal precision', () => {
    const costCells = lines
      .slice(1, -1)
      .map((l) => parseFloat(splitCsvRow(l)[3]))
    const sum = costCells.reduce((s, c) => s + c, 0)
    expect(sum).toBeCloseTo(parseFloat(data.totalCost.toFixed(6)), 6)
  })
})
