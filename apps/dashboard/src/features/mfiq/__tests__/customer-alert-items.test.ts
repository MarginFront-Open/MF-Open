/**
 * The "Customer alerts" card's row composition, pinned where the
 * compiler can't reach: the customer page is @ts-nocheck and index.tsx is
 * banned from carrying hrefs/severity, so this module is the ONE place the
 * deep-link identifier and row copy are decided. Each case fails against a
 * broken implementation:
 *   1. href uses the INTERNAL customer UUID — the route param the customer
 *      page resolves, never externalId, which the page can't resolve.
 *   2. Severity is red (the urgency the red sidebar badge promises).
 *   3. Copy carries name, threshold, metric, window label, and fired value,
 *      money formatted once here (canon R4 — the renderer formats nothing).
 *   4. A hard-deleted customer degrades to a generic label.
 */

import { buildCustomerAlertItems } from '../customer-alert-items'
import type { CustomerAlertNotificationView } from '@/app/actions/customer-alert-notifications'

const row = (
  over: Partial<CustomerAlertNotificationView> = {}
): CustomerAlertNotificationView => ({
  id: 'n-1',
  customerId: '3f2a8c1e-0000-4000-8000-000000000001',
  customerName: 'Acme',
  metric: 'cost',
  thresholdUsd: 500,
  valueUsd: 512.4,
  windowMode: 'month',
  firedAt: '2026-08-26T12:00:00.000Z',
  readAt: null,
  ...over,
})

describe('buildCustomerAlertItems', () => {
  it('deep-links the INTERNAL customer UUID, never externalId', () => {
    const [item] = buildCustomerAlertItems([row()])
    expect(item.href).toBe('/customers/3f2a8c1e-0000-4000-8000-000000000001')
  })

  it('every row is red — a fired tripwire is the urgency the badge promises', () => {
    const items = buildCustomerAlertItems([
      row(),
      row({ id: 'n-2', metric: 'revenue' }),
    ])
    expect(items.every((i) => i.severity === 'red')).toBe(true)
  })

  it('copy names the customer, threshold, metric, window, and fired value', () => {
    const [item] = buildCustomerAlertItems([row()])
    expect(item.text).toBe('Acme passed $500.00 cost (This month): $512.40')
  })

  it('rolling and custom windows use the selector labels', () => {
    const [rolling] = buildCustomerAlertItems([row({ windowMode: 'rolling' })])
    expect(rolling.text).toContain('(Last 30 days)')
    const [custom] = buildCustomerAlertItems([row({ windowMode: 'custom' })])
    expect(custom.text).toContain('(Custom range)')
  })

  it('a revenue row reads revenue, not cost', () => {
    const [item] = buildCustomerAlertItems([
      row({ metric: 'revenue', thresholdUsd: 1000, valueUsd: 1250 }),
    ])
    expect(item.text).toContain('revenue')
    expect(item.text).not.toContain(' cost ')
  })

  it('a deleted customer degrades to a generic label, never a blank or crash', () => {
    const [item] = buildCustomerAlertItems([row({ customerName: null })])
    expect(item.text).toContain('A deleted customer passed')
  })

  it('stamps a compact UTC fire date', () => {
    const [item] = buildCustomerAlertItems([row()])
    expect(item.timestamp).toBe('Aug 26')
  })

  it('a UTC-midnight boundary stamps the UTC day, not the local one', () => {
    const [item] = buildCustomerAlertItems([
      row({ firedAt: '2026-08-27T00:30:00.000Z' }),
    ])
    expect(item.timestamp).toBe('Aug 27')
  })

  it('an unparseable firedAt degrades to an empty stamp', () => {
    const [item] = buildCustomerAlertItems([row({ firedAt: 'not-a-date' })])
    expect(item.timestamp).toBe('')
  })

  it('an empty feed maps to an empty list', () => {
    expect(buildCustomerAlertItems([])).toEqual([])
  })
})
