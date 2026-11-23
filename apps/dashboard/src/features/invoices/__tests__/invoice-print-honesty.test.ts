/**
 * Invoice print honesty. There is no hardcoded vendor default on a printed
 * invoice: the FROM block renders ONLY the org's stored billing identity,
 * with the org display name as the one fallback (built in
 * billing-identity-display.ts, whose behavior test covers the fallback).
 *
 * Source assertions, not render tests — this repo's Node-only jest has no
 * RTL (see apps/dashboard jest config), same constraint as every other
 * component test here.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const printViewSrc = readFileSync(
  join(__dirname, '..', 'InvoicePrintView.tsx'),
  'utf8'
)
const invoiceActionsSrc = readFileSync(
  join(__dirname, '..', 'InvoiceActions.tsx'),
  'utf8'
)
const invoicePageSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    '(dashboard)',
    'invoices',
    '[invoiceId]',
    'page.tsx'
  ),
  'utf8'
)

describe('InvoicePrintView — no invented seller data', () => {
  it('renders no hardcoded default company block', () => {
    expect(printViewSrc).not.toMatch(/defaultCompanyInfo/)
    expect(printViewSrc).not.toMatch(/123 Billing Street/)
    expect(printViewSrc).not.toMatch(/MarginFront Inc\./)
    expect(printViewSrc).not.toMatch(/billing@marginfront\.com/)
    expect(printViewSrc).not.toMatch(/companyInfo/)
  })

  it('renders the FROM block from the seller prop, field by field, only when present', () => {
    expect(printViewSrc).toMatch(/seller\?: InvoiceSeller/)
    expect(printViewSrc).toMatch(/\{seller && \(/)
    expect(printViewSrc).toMatch(/\{seller\.addressLine1 && \(/)
    expect(printViewSrc).toMatch(/\{seller\.country && \(/)
    expect(printViewSrc).toMatch(/\{seller\.email && \(/)
  })
})

describe('invoice detail page — honest download action, real seller identity', () => {
  it('offers no PDF download stub it cannot produce', () => {
    expect(invoicePageSrc).not.toMatch(/Coming Soon/)
    expect(invoicePageSrc).not.toMatch(/handleDownloadPdf/)
    expect(invoicePageSrc).not.toMatch(/isDownloadingPdf/)
  })

  it('offers one print action with Save-as-PDF guidance', () => {
    expect(invoicePageSrc).toMatch(/Print \/ save PDF/)
    expect(invoicePageSrc).toMatch(/Save as PDF/)
  })

  it('mounts the print view with the fetched seller identity', () => {
    expect(invoicePageSrc).toMatch(/useSellerIdentity/)
    expect(invoicePageSrc).toMatch(
      /<InvoicePrintView invoice=\{invoice\} seller=\{seller\} \/>/
    )
  })
})

describe('InvoiceActions PrintButton — same seller identity path', () => {
  it('fetches and passes the seller instead of relying on any default', () => {
    expect(invoiceActionsSrc).toMatch(/useSellerIdentity/)
    expect(invoiceActionsSrc).toMatch(/seller=\{seller\}/)
  })
})
