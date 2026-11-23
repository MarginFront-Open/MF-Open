/**
 * WHAT THIS FILE GUARDS: the subscription detail page's "Cancel
 * Subscription" action bar control is wired, and wired to the SAFE stop.
 *
 * WHY THE TEST LOOKS LIKE THIS: apps/dashboard's jest runs in a NODE env
 * with no RTL (see jest.config.ts) — client components aren't rendered
 * here. So this reads the real source files and asserts on their text,
 * the same idiom as usage-chart-tab-tooltips.test.ts in this directory.
 * That is enough to lock: (a) the control is wired, not commented out,
 * (b) it never routes through deleteSubscription (which zeros revenue
 *   history), and (c) there is no live pause or adjust-plan call anywhere
 *   in this page.
 */

import { readFileSync } from 'fs'
import path from 'path'

const pageSource = readFileSync(path.join(__dirname, '../page.tsx'), 'utf-8')
const dialogSource = readFileSync(
  path.join(
    process.cwd(),
    'src/features/subscriptions/components/cancel-subscription-dialog.tsx'
  ),
  'utf-8'
)
const actionsSource = readFileSync(
  path.join(process.cwd(), 'app/actions/subscriptions.ts'),
  'utf-8'
)

describe('Subscription detail page — Cancel Subscription control is wired', () => {
  it('has no commented-out "Uncomment when actions are ready" block', () => {
    expect(pageSource).not.toMatch(/Uncomment when actions are ready/)
  })

  it('imports and renders the cancel action + its confirmation dialog', () => {
    expect(pageSource).toMatch(
      /import \{ cancelSubscription \} from '@\/app\/actions\/subscriptions'/
    )
    expect(pageSource).toMatch(/CancelSubscriptionDialog/)
    expect(pageSource).toMatch(/handleCancelSubscription/)
  })

})

describe('Subscription detail page — never routes a stop through delete', () => {
  it('never imports or calls deleteSubscription', () => {
    expect(pageSource).not.toMatch(/import\s*\{[^}]*deleteSubscription/)
    expect(pageSource).not.toMatch(/deleteSubscription\(/)
  })

  it('never sets a subscription status literal to "ended" on this page', () => {
    expect(pageSource).not.toMatch(/status:\s*['"]ended['"]/)
  })
})

describe('Subscription detail page — pause/adjust are deferred, not half-wired', () => {
  it('never assigns a "paused" status literal (explanatory prose about why it is absent is fine)', () => {
    expect(pageSource).not.toMatch(/status:\s*['"]paused['"]/)
  })

  it('has no live Pause/Adjust-Plan action wired into the button handlers', () => {
    // A comment may explain why pause/adjust are absent. What must NOT exist
    // is an actual onClick wired to either concept.
    expect(pageSource).not.toMatch(/onClick=\{[^}]*[Pp]ause[Ss]ubscription/)
    expect(pageSource).not.toMatch(/onClick=\{[^}]*[Aa]djustPlan/)
  })
})

describe('CancelSubscriptionDialog — requires a reason before confirming', () => {
  it('disables the confirm button until a non-empty reason is typed', () => {
    expect(dialogSource).toMatch(/disabled=\{pending \|\| !reason\.trim\(\)\}/)
  })

  it('describes what cancel affects (the customer + billing history) in its copy', () => {
    expect(dialogSource).toMatch(/stops being billed/i)
    expect(dialogSource).toMatch(/never erases billing history/i)
  })
})

describe('cancelSubscription server action — the safe-stop invariant', () => {
  it("sets status to 'canceled', never delegates to a delete/soft-delete path", () => {
    const start = actionsSource.indexOf(
      'export async function cancelSubscription'
    )
    expect(start).toBeGreaterThan(-1)
    const end = actionsSource.indexOf(
      '\n/**',
      start + 'export async function cancelSubscription'.length
    )
    const body = actionsSource.slice(start, end === -1 ? undefined : end)
    expect(body).toMatch(/status:\s*'canceled'/)
    expect(body).not.toMatch(/status:\s*'ended'/)
    // deletedAt: null is fine here (the existing-row read-guard, same as
    // every other action in this file). Setting deletedAt to a value is the
    // delete path, and must never appear.
    expect(body).not.toMatch(/deletedAt:\s*(now|new Date\(\))/)
    expect(body).not.toMatch(/deleteSubscription\(/)
  })

  it('requires a changeReason and logs to subscription_change_logs', () => {
    const start = actionsSource.indexOf(
      'export async function cancelSubscription'
    )
    const body = actionsSource.slice(start)
    expect(body).toMatch(/changeReason/)
    expect(body).toMatch(/subscription_change_logs\.create/)
    expect(body).toMatch(/changeType:\s*'status_change'/)
  })
})
