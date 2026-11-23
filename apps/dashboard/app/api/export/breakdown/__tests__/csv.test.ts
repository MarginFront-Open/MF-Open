/**
 * WHAT THIS FILE DOES: unit tests for the Money breakdown CSV builder
 * — header labels, column selection/availability per
 * revenue basis, the "Other" rollup row, and RFC-4180 / formula-injection
 * quoting (proving csvCell is actually wired in, not just present in the
 * import list).
 *
 * Pure logic only — no DB, no request. Fixture rows in, CSV text out.
 */
import { toBreakdownCsv, type BreakdownCsvRow } from '../csv'
import { BREAKDOWN_CSV_COLUMN_LABELS } from '@/features/money/components/csv-columns'

const row = (overrides: Partial<BreakdownCsvRow> = {}): BreakdownCsvRow => ({
  label: 'Acme Inc',
  eventCount: 42,
  cost: 12.5,
  revenue: 20,
  marginPercent: 37.5,
  ...overrides,
})

describe('toBreakdownCsv — header + column selection', () => {
  it('always includes Account first, regardless of requested columns', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'billed',
      columns: ['cost'],
      rows: [row()],
    })
    expect(csv.split('\n')[0]).toBe('Account,Cost')
  })

  it('labels the revenue column by basis — Earned for agent/signal', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'earned',
      columns: ['tasks', 'cost', 'revenue', 'margin', 'marginPercent'],
      rows: [row()],
    })
    expect(csv.split('\n')[0]).toBe('Account,Tasks,Cost,Earned,Margin,Margin %')
  })

  it('labels the revenue column by basis — Billed for customer/plan', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'billed',
      columns: ['revenue'],
      rows: [row()],
    })
    expect(csv.split('\n')[0]).toBe('Account,Billed')
  })

  it('drops Revenue/Margin/Margin % entirely when the dimension has no honest basis (canon M2 — model/environment), even if requested', () => {
    const csv = toBreakdownCsv({
      revenueBasis: null,
      columns: ['tasks', 'cost', 'revenue', 'margin', 'marginPercent'],
      rows: [row({ revenue: undefined, marginPercent: undefined })],
    })
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Account,Tasks,Cost')
    expect(lines[1]).not.toMatch(/undefined/)
  })

  it('keeps the exported header names while the dialog says "Usage events"', () => {
    // The header row is a wire contract: a customer sheet or script reads the
    // export by column name. The on-screen label for the same number
    // differs; the header deliberately stays.
    expect(BREAKDOWN_CSV_COLUMN_LABELS.tasks).toBe('Usage events')
    const csv = toBreakdownCsv({
      revenueBasis: null,
      columns: ['tasks', 'cost'],
      rows: [row()],
    })
    expect(csv.split('\n')[0]).toBe('Account,Tasks,Cost')
  })

  it('honors a caller-requested subset (e.g. only Tasks + Margin %)', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'earned',
      columns: ['tasks', 'marginPercent'],
      rows: [row()],
    })
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Account,Tasks,Margin %')
    expect(lines[1]).toBe('Acme Inc,42,37.5%')
  })
})

describe('toBreakdownCsv — cell values', () => {
  it('computes Margin as revenue minus cost, using the row’s own canon-sourced numbers (no re-derivation)', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'billed',
      columns: ['cost', 'revenue', 'margin'],
      rows: [row({ cost: 12.5, revenue: 20 })],
    })
    const cells = csv.split('\n')[1].split(',')
    // Account,Cost,Billed,Margin
    expect(cells[1]).toBe('12.50')
    expect(cells[2]).toBe('20.00')
    expect(cells[3]).toBe('7.50')
  })

  it('renders Margin % as "—" when null (canon M1 — revenue was exactly 0)', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'billed',
      columns: ['marginPercent'],
      rows: [row({ revenue: 0, marginPercent: null })],
    })
    expect(csv.split('\n')[1]).toBe('Acme Inc,—')
  })

  it('renders Revenue/Margin as empty (not "0" or "undefined") when the row itself has no defined revenue', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'earned',
      columns: ['revenue', 'margin'],
      rows: [row({ revenue: undefined, marginPercent: undefined })],
    })
    expect(csv.split('\n')[1]).toBe('Acme Inc,,')
  })

  it('renders the usage-event count as a plain integer string', () => {
    const csv = toBreakdownCsv({
      revenueBasis: null,
      columns: ['tasks'],
      rows: [row({ eventCount: 1234 })],
    })
    expect(csv.split('\n')[1]).toBe('Acme Inc,1234')
  })
})

describe('toBreakdownCsv — "Other" rollup row', () => {
  it('appends the Other bucket after every named row when present', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'billed',
      columns: ['tasks', 'cost'],
      rows: [row({ label: 'Acme Inc' })],
      other: { label: 'Other', eventCount: 3, cost: 1.23 },
    })
    const lines = csv.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('Other,3,1.23')
  })

  it('omits the Other row entirely when there is no overflow', () => {
    const csv = toBreakdownCsv({
      revenueBasis: 'billed',
      columns: ['tasks', 'cost'],
      rows: [row()],
      other: null,
    })
    expect(csv.split('\n')).toHaveLength(2)
  })
})

describe('toBreakdownCsv — RFC-4180 + formula-injection quoting (reuses csvCell, not a second escaper)', () => {
  it('quotes an Account label containing a comma', () => {
    const csv = toBreakdownCsv({
      revenueBasis: null,
      columns: ['tasks'],
      rows: [row({ label: 'Acme, Inc' })],
    })
    expect(csv.split('\n')[1]).toBe('"Acme, Inc",42')
  })

  it('quotes and doubles an embedded double-quote in a label', () => {
    const csv = toBreakdownCsv({
      revenueBasis: null,
      columns: ['tasks'],
      rows: [row({ label: 'Say "hi"' })],
    })
    expect(csv.split('\n')[1]).toBe('"Say ""hi""",42')
  })

  it('quotes a label containing an embedded newline', () => {
    // Deliberately NOT split on '\n' here — the embedded newline this test
    // is proving gets quoted is itself a '\n', so splitting the whole CSV on
    // '\n' would cut the assertion's own fixture in half. Assert the full
    // text instead: one header line, then the quoted multi-line cell.
    const csv = toBreakdownCsv({
      revenueBasis: null,
      columns: ['tasks'],
      rows: [row({ label: 'Acme\nInc' })],
    })
    expect(csv).toBe('Account,Tasks\n"Acme\nInc",42')
  })

  it('defangs a label starting with a formula-injection trigger (CWE-1236) — an org-controlled customer/agent/plan/signal name is untrusted input', () => {
    const csv = toBreakdownCsv({
      revenueBasis: null,
      columns: ['tasks'],
      rows: [row({ label: '=HYPERLINK("http://evil","x")' })],
    })
    const dataLine = csv.split('\n')[1]
    expect(dataLine).toContain("'=HYPERLINK")
    expect(dataLine).not.toMatch(/^=HYPERLINK/)
  })
})
