import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Guards a specific naming trap: /api/export/breakdown's query params are
 * start/end/customer/agent, not startDate/endDate like the rest of the app.
 * Money's Export button must call downloadBreakdownExport VERBATIM
 * (command-center-shared.tsx already does this translation correctly) and
 * never hand-roll its own fetch to the export route.
 */
describe('Money export — param contract (source-assert)', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('imports downloadBreakdownExport from command-center-shared', () => {
    expect(src).toMatch(/downloadBreakdownExport/)
    expect(src).toMatch(/command-center-shared/)
  })

  it('never hand-builds a fetch to /api/export/breakdown', () => {
    expect(src).not.toMatch(/api\/export\/breakdown/)
  })
})

/**
 * The Export control is a menu: the one-click XLSX handler sits alongside a
 * "Custom CSV export…" entry that opens CsvExportDialog. Never a second
 * hand-rolled export mechanism on this page.
 */
describe('Money export menu — XLSX and custom CSV', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('wires the XLSX item to the handleExport/parseWindowFilter path', () => {
    expect(src).toMatch(/const handleExport = useCallback\(/)
    expect(src).toMatch(/parseWindowFilter\(period\)/)
    expect(src).toMatch(/onSelect=\{handleExport\}/)
  })

  it('offers a "Custom CSV export…" menu item that opens CsvExportDialog', () => {
    expect(src).toMatch(/Custom CSV export/)
    expect(src).toMatch(
      /import \{ CsvExportDialog \} from '\.\/components\/csv-export-dialog'/
    )
    expect(src).toMatch(/<CsvExportDialog/)
  })

  it("passes the page's own current window as the dialog's default timeframe (no second date computation)", () => {
    expect(src).toMatch(/defaultPeriod=\{period\}/)
  })
})
