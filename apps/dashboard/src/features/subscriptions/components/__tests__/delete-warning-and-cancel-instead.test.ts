/**
 * WHAT THIS FILE GUARDS: the subscriptions LIST
 * table's delete confirmation must (a) say plainly that a delete erases
 * the subscription's recognized revenue from every report, (b) offer the
 * safe alternative ("Cancel instead") wired to the cancelSubscription
 * safe-stop, visually preferred over the destructive delete button, and
 * (c) source any dollar figure from the canonical metrics action, never a
 * dedicated revenue endpoint.
 *
 * apps/dashboard jest is node-only (no RTL), so this reads the real
 * source and asserts on its text — same idiom as
 * cancel-subscription-wiring.test.ts.
 */

import { readFileSync } from 'fs'
import path from 'path'

const tableSource = readFileSync(
  path.join(__dirname, '../subscriptions-list-table.tsx'),
  'utf-8'
)

describe('Subscriptions list delete dialog — the warning names the money', () => {
  it('does not say "remove the data from our servers"', () => {
    expect(tableSource).not.toMatch(/remove the data from our servers/)
  })

  it('states that recognized revenue disappears from every report, past included', () => {
    expect(tableSource).toMatch(/recognized revenue/)
    expect(tableSource).toMatch(/every revenue report/)
    expect(tableSource).toMatch(/past periods included/)
  })

  it('shows the dollar amount via the canonical metrics action', () => {
    expect(tableSource).toMatch(
      /import \{ getCanonicalSubscriptionMetrics \} from '@\/app\/actions\/analytics'/
    )
    expect(tableSource).toMatch(/formatCurrency/)
    // No bespoke revenue fetch: the only network-ish calls are the shared
    // actions + hooks. (\b so React Query's refetch() doesn't trip this.)
    expect(tableSource).not.toMatch(/\bfetch\(/)
  })
})

describe('Subscriptions list delete dialog — offers Cancel instead', () => {
  it('imports the shared cancel dialog and the safe-stop action', () => {
    expect(tableSource).toMatch(
      /import \{ CancelSubscriptionDialog \} from '\.\/cancel-subscription-dialog'/
    )
    expect(tableSource).toMatch(
      /import \{ cancelSubscription \} from '@\/app\/actions\/subscriptions'/
    )
  })

  it('renders a "Cancel instead" control inside the delete dialog footer', () => {
    expect(tableSource).toMatch(/Cancel instead/)
  })

  it('makes Cancel-instead the preferred button and keeps delete destructive', () => {
    const cancelInsteadIndex = tableSource.indexOf('Cancel instead')
    expect(cancelInsteadIndex).toBeGreaterThan(-1)
    // The 400 chars before the label cover its <Button ...> opening tag:
    // it must NOT be the destructive variant.
    const cancelInsteadTag = tableSource.slice(
      cancelInsteadIndex - 400,
      cancelInsteadIndex
    )
    expect(cancelInsteadTag).not.toMatch(/variant='destructive'/)
    // The actual delete button stays destructive.
    expect(tableSource).toMatch(/variant='destructive'/)
    expect(tableSource).toMatch(/Delete permanently/)
  })

  it('never routes the cancel path through deleteSubscription', () => {
    // The delete flow uses the delete hook; the cancel flow must
    // call the cancelSubscription server action with a reason.
    expect(tableSource).toMatch(/cancelSubscription\(/)
    const cancelCallIndex = tableSource.indexOf('cancelSubscription(')
    const cancelCallBody = tableSource.slice(
      cancelCallIndex,
      cancelCallIndex + 120
    )
    expect(cancelCallBody).toMatch(/reason/)
  })

  it('only offers Cancel-instead for subscriptions that can still be canceled', () => {
    // Same status guard the detail page uses for its Cancel control.
    expect(tableSource).toMatch(/'canceled',\s*'ended',\s*'expired'/)
  })
})

describe('Subscriptions list delete dialog — stale-revenue race guard', () => {
  it('keys the fetched amount to the subscription it was fetched for', () => {
    // The earned amount is stored as {id, amount} and only rendered when it
    // matches the current delete target, so a slow response for sub A can
    // never label sub B's warning.
    expect(tableSource).toMatch(/deleteTargetEarned\?\.id === deleteTarget/)
  })
})
