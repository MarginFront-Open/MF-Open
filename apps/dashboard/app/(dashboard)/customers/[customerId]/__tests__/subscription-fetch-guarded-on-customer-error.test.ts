/**
 * Visiting /customers/<not-a-uuid> shows the "Failed to fetch customer"
 * empty state and must not also log a redundant "Failed to fetch
 * subscription details" console error. So the subscriptions-fetch effect is
 * gated on the sibling `useCustomer` fetch resolving successfully first
 * (isCustomerLoading/customerError are in its dependency array). When the
 * customer fetch has errored, the effect short-circuits before calling
 * getSubscriptionsAction, but still flips `loading` false so the page
 * doesn't get stuck on the loading skeleton (nothing else clears it).
 *
 * Source-assertion, not a render test — this repo's dashboard jest is
 * node-only (no RTL), and the guard is inline hook logic in a 'use client'
 * page, same constraint as kpi-strip-cancelled-only-customer.test.ts.
 */

import { readFileSync } from 'fs'
import path from 'path'

const pageSource = readFileSync(path.join(__dirname, '../page.tsx'), 'utf-8')

function subscriptionEffectBody(): string {
  const start = pageSource.indexOf('Fetch subscriptions and their analytics')
  expect(start).toBeGreaterThan(-1)
  const end = pageSource.indexOf(
    '}, [customerId, isCustomerLoading, customerError])'
  )
  expect(end).toBeGreaterThan(start)
  return pageSource.slice(start, end)
}

describe('customer detail page — subscription fetch is gated on the customer fetch', () => {
  it('the effect depends on isCustomerLoading and customerError, not just customerId', () => {
    expect(pageSource).toMatch(
      /}, \[customerId, isCustomerLoading, customerError\]\)/
    )
  })

  it('bails before calling getSubscriptionsAction while the customer fetch is still pending', () => {
    const body = subscriptionEffectBody()
    const bailIndex = body.indexOf(
      'if (!customerId || isCustomerLoading) return'
    )
    const fetchCallIndex = body.indexOf('getSubscriptionsAction(')
    expect(bailIndex).toBeGreaterThan(-1)
    expect(fetchCallIndex).toBeGreaterThan(bailIndex)
  })

  it('short-circuits on a customer-fetch error BEFORE calling getSubscriptionsAction, and flips loading false itself', () => {
    const body = subscriptionEffectBody()
    const guardIndex = body.indexOf('if (customerError) {')
    const setLoadingFalseIndex = body.indexOf('setLoading(false)', guardIndex)
    const fetchCallIndex = body.indexOf('getSubscriptionsAction(')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(setLoadingFalseIndex).toBeGreaterThan(guardIndex)
    expect(setLoadingFalseIndex).toBeLessThan(fetchCallIndex)
    expect(fetchCallIndex).toBeGreaterThan(guardIndex)
  })

  it('valid customers still reach the subscriptions fetch (the guard does not remove the call)', () => {
    const body = subscriptionEffectBody()
    expect(body).toMatch(/fetchSubscriptionData\(\)/)
    expect(body).toMatch(/getSubscriptionsAction\(\{/)
  })
})
