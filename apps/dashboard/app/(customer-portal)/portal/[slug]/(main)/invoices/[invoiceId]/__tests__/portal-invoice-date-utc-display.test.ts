/**
 * A midnight-UTC date field rendered through naive `new
 * Date(x).toLocaleDateString(...)` shows the PREVIOUS calendar day in
 * negative-offset zones. The customer-portal invoice page has five such
 * fields — invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd, and
 * payment.paymentDate — all calendar-date-only (none renders a time
 * alongside). Source assertions — this repo's jest is node-only, no RTL.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const pageSource = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('customer-portal invoice page date display', () => {
  it('imports the UTC-safe canon date formatter', () => {
    expect(pageSource).toMatch(
      /import \{ formatDisplayDate \} from '@\/lib\/canon-date'/
    )
  })

  it('renders invoice.invoiceDate through formatDisplayDate', () => {
    expect(pageSource).toMatch(/formatDisplayDate\(invoice\.invoiceDate\)/)
  })

  it('renders invoice.dueDate through formatDisplayDate', () => {
    expect(pageSource).toMatch(/formatDisplayDate\(invoice\.dueDate\)/)
  })

  it('renders invoice.billingPeriodStart and billingPeriodEnd through formatDisplayDate', () => {
    expect(pageSource).toMatch(
      /formatDisplayDate\(invoice\.billingPeriodStart, 'MMM d'\)/
    )
    expect(pageSource).toMatch(
      /formatDisplayDate\(invoice\.billingPeriodEnd, 'MMM d'\)/
    )
  })

  it('renders payment.paymentDate through formatDisplayDate', () => {
    expect(pageSource).toMatch(/formatDisplayDate\(payment\.paymentDate\)/)
  })

  it('never renders any of the five date fields through the viewer-local toLocaleDateString', () => {
    expect(pageSource).not.toMatch(/toLocaleDateString/)
  })
})
