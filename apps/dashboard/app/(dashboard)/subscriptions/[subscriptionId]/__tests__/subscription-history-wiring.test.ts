/**
 * WHAT THIS FILE GUARDS: subscription_change_logs rows are written by
 * updateSubscription and cancelSubscription (app/actions/subscriptions.ts).
 * This pins that the detail page renders a History section backed by the
 * read-only getSubscriptionChangeLogs action, and that no write path was
 * added to reach it.
 *
 * WHY THE TEST LOOKS LIKE THIS: apps/dashboard's jest runs in a NODE env
 * with no RTL (see jest.config.ts) — client components aren't rendered
 * here. Source-assert, same idiom as cancel-subscription-wiring.test.ts in
 * this directory.
 */

import { readFileSync } from 'fs'
import path from 'path'

const pageSource = readFileSync(path.join(__dirname, '../page.tsx'), 'utf-8')
const historySectionSource = readFileSync(
  path.join(
    process.cwd(),
    'src/features/subscriptions/components/subscription-history.tsx'
  ),
  'utf-8'
)
const actionsSource = readFileSync(
  path.join(process.cwd(), 'app/actions/subscriptions.ts'),
  'utf-8'
)

describe('Subscription detail page — History section is wired', () => {
  it('imports and renders SubscriptionHistorySection', () => {
    expect(pageSource).toMatch(
      /import \{ SubscriptionHistorySection \} from '@\/features\/subscriptions\/components\/subscription-history'/
    )
    expect(pageSource).toMatch(
      /<SubscriptionHistorySection subscriptionId=\{subscriptionId\} \/>/
    )
  })
})

describe('SubscriptionHistorySection — read-only, newest-first, honest empty state', () => {
  it('fetches through getSubscriptionChangeLogs — no direct db/prisma import in the component', () => {
    expect(historySectionSource).toMatch(
      /import \{\s*getSubscriptionChangeLogs,/
    )
    expect(historySectionSource).not.toMatch(/from '@\/app\/lib\/db'/)
    expect(historySectionSource).not.toMatch(/PrismaClient/)
  })

  it('renders an honest empty state instead of a blank table', () => {
    expect(historySectionSource).toContain('No changes recorded yet.')
  })

  it('formats the row timestamp through canon-date, never a raw Date/toLocaleDateString', () => {
    expect(historySectionSource).toMatch(
      /import \{ formatDisplayDate \} from '@\/lib\/canon-date'/
    )
    expect(historySectionSource).toMatch(/formatDisplayDate\(log\.createdAt\)/)
    expect(historySectionSource).not.toMatch(/toLocaleDateString/)
  })

  it('derives the field diff through the shared pure helper, not inline math', () => {
    expect(historySectionSource).toMatch(
      /deriveChangeLogFieldDiffs\(\s*log\.previousValues,\s*log\.newValues\s*\)/
    )
  })
})

describe('getSubscriptionChangeLogs — read-only action', () => {
  it('exists, is org-scoped, and orders newest-first', () => {
    const actionIndex = actionsSource.indexOf(
      'export async function getSubscriptionChangeLogs'
    )
    expect(actionIndex).toBeGreaterThan(-1)
    const body = actionsSource.slice(actionIndex, actionIndex + 1500)
    expect(body).toMatch(/organizationId: orgId/)
    expect(body).toMatch(/orderBy: \{ createdAt: 'desc' \}/)
  })

  it('is read-only — no .create(/.update(/.delete( calls anywhere in its body', () => {
    const actionIndex = actionsSource.indexOf(
      'export async function getSubscriptionChangeLogs'
    )
    const nextExportIndex = actionsSource.indexOf('\nexport ', actionIndex + 1)
    const body = actionsSource.slice(
      actionIndex,
      nextExportIndex === -1 ? undefined : nextExportIndex
    )
    expect(body).not.toMatch(/\.create\(/)
    expect(body).not.toMatch(/\.update\(/)
    expect(body).not.toMatch(/\.delete\(/)
  })
})
