/**
 * Payment rows must display the UTC calendar date (canon I3/W1): a
 * midnight-UTC paymentDate through a viewer-local helper renders the
 * PREVIOUS day in negative-offset zones. Source assertions —
 * this repo's jest is node-only, no RTL.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const panelSource = readFileSync(
  join(__dirname, '..', 'PaymentHistoryPanel.tsx'),
  'utf8'
)

describe('PaymentHistoryPanel payment-date display (canon I3/W1)', () => {
  it('imports the UTC-safe canon date formatter', () => {
    expect(panelSource).toMatch(
      /import \{ formatDisplayDate \} from '@\/lib\/canon-date'/
    )
  })

  it('renders payment.paymentDate through formatDisplayDate', () => {
    expect(panelSource).toMatch(/formatDisplayDate\(payment\.paymentDate\)/)
  })

  it('never renders payment.paymentDate through the viewer-local helper', () => {
    expect(panelSource).not.toMatch(/formatDate\(payment\.paymentDate\)/)
  })

  it('keeps the local helper for refund timestamps shown with their time', () => {
    // Deliberate: a "date at time" line is a genuine instant and stays in the
    // viewer's zone — only the bare payment DATE is calendar-pinned to UTC.
    expect(panelSource).toMatch(/formatDate\(refund\.createdAt\)/)
    expect(panelSource).toMatch(/formatTime\(refund\.createdAt\)/)
  })
})
