/**
 * WHAT THIS FILE GUARDS: the subscriptions server action carries
 * seatsCount end to end — payload types, the Prisma create, the Prisma
 * update, and mapSubscription. If any of those spots drops the field, a
 * dashboard-created subscription stores the schema default of 0 and canon R2
 * bills the plan minimum regardless of real seats, which under-bills.
 *
 * Node-only jest, so these are source assertions (same idiom as
 * strategy-deactivation-warning.test.ts): importing the action would drag in
 * next/headers and the auth stack.
 */

import { readFileSync } from 'fs'
import path from 'path'

const source = readFileSync(
  path.join(__dirname, '../subscriptions.ts'),
  'utf-8'
)

function block(startMarker: string, length = 2500): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, start + length)
}

describe('subscriptions action — seatsCount persists end to end', () => {
  it('both payload types accept seatsCount', () => {
    expect(block('interface CreateSubscriptionPayload', 700)).toMatch(
      /seatsCount\?: number/
    )
    expect(block('interface UpdateSubscriptionPayload', 700)).toMatch(
      /seatsCount\?: number/
    )
  })

  it('the Subscription shape returns seatsCount (edit forms prefill from it)', () => {
    expect(block('export interface Subscription', 900)).toMatch(
      /seatsCount: number/
    )
    expect(block('const mapSubscription', 1200)).toMatch(
      /seatsCount: s\.seatsCount \?\? 0/
    )
  })

  it('create writes a sanitized seatsCount (?? 0, no negatives, no fractions)', () => {
    expect(block('export async function createSubscription')).toMatch(
      /seatsCount: Math\.max\(0, Math\.trunc\(data\.seatsCount \?\? 0\)\)/
    )
  })

  it('update sanitizes seatsCount but keeps missing = leave unchanged', () => {
    // No `?? 0` here on purpose: an update that doesn't mention seats must
    // not zero a real count (Prisma skips undefined fields).
    const updateBlock = block('export async function updateSubscription')
    expect(updateBlock).toMatch(/data\.seatsCount == null/)
    expect(updateBlock).toMatch(
      /Math\.max\(0, Math\.trunc\(data\.seatsCount\)\)/
    )
  })
})

describe('the two subscription forms — seats input wired to the action', () => {
  const featuresForm = readFileSync(
    path.join(
      __dirname,
      '../../../src/features/subscriptions/components/create-subscription-form.tsx'
    ),
    'utf-8'
  )
  const customersPage = readFileSync(
    path.join(
      __dirname,
      '../../(dashboard)/customers/[customerId]/subscriptions/new/page.tsx'
    ),
    'utf-8'
  )

  it('the features form sends seatsCount in edit mode too, so an edit can fix a stored 0', () => {
    expect(featuresForm).not.toMatch(
      /formData\.seatsCount !== undefined && !isEditMode/
    )
    expect(featuresForm).toMatch(/submissionData\.seatsCount/)
  })

  it('the features form renders a visible seats input', () => {
    expect(featuresForm).toMatch(/id='seatsCount'/)
  })

  it("the customers/new page keeps 'seatsCount' out of UI copy", () => {
    expect(customersPage).not.toMatch(/number of seatsCount/)
    expect(customersPage).not.toMatch(/user seatsCount/)
  })

  it('the customers/new seat gate ignores deactivated strategies', () => {
    expect(customersPage).toMatch(
      /chargeType === 'seat_based' && strategy\.active !== false/
    )
  })
})
