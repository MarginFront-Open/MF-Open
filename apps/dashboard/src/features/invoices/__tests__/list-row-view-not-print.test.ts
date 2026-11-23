/**
 * Each invoices list row has exactly one view control and no print control.
 * Printing lives on the invoice detail page (InvoiceActions.tsx's
 * PrintButton, which calls window.print()). Source assertions, because this
 * repo's Node-only jest has no RTL.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

describe('Invoices list row actions — no dishonest "Print Invoice" control', () => {
  it('has no "Print Invoice" tooltip label anywhere in the file', () => {
    expect(SRC).not.toMatch(/Print Invoice/i)
  })

  it("does not import lucide-react's PrinterIcon", () => {
    expect(SRC).not.toMatch(/PrinterIcon/)
  })
})

describe('Invoices list row actions — exactly ONE view control per row', () => {
  it('has exactly one <Eye> icon in the row actions cell (one view control)', () => {
    const actionsCellStart = SRC.indexOf("id: 'actions'")
    expect(actionsCellStart).toBeGreaterThan(-1)
    const actionsCell = SRC.slice(actionsCellStart)
    const eyeIconMatches = [...actionsCell.matchAll(/<Eye className=/g)]
    expect(eyeIconMatches.length).toBe(1)
  })

  it('has exactly one "View Invoice" tooltip', () => {
    const viewTooltipMatches = [...SRC.matchAll(/View [Ii]nvoice/g)]
    expect(viewTooltipMatches.length).toBe(1)
    expect(viewTooltipMatches[0][0]).toBe('View Invoice')
  })

  it('the single view control navigates to the invoice detail route on click', () => {
    const tooltipIndex = SRC.indexOf('View Invoice')
    expect(tooltipIndex).toBeGreaterThan(-1)
    const handlerWindow = SRC.slice(
      SRC.lastIndexOf('onClick', tooltipIndex),
      tooltipIndex
    )
    expect(handlerWindow).toMatch(
      /router\.push\(`\/invoices\/\$\{invoice\.id\}`\)/
    )
  })

  it('the row keeps Copy Link as a separate control', () => {
    expect(SRC).toMatch(/Copy Link/)
    expect(SRC).toMatch(/<Link2Icon className=/)
  })
})
