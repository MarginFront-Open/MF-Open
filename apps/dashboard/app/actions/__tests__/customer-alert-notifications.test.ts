/**
 * Tenancy + read-state proofs for the notification actions.
 *
 * The whole DB is mocked (no database needed); what these pin is the CONTRACT the
 * mocks observe — the exact where-clauses and outcomes:
 *   1. Every query scopes BOTH userId = session user AND orgId = active org
 *      (org A's customer names must never
 *      render while working in org B).
 *   2. The unread count is readAt IS NULL only; mark-read stamps exactly the
 *      viewer's unread rows in the active org.
 *   3. Feed rows join customer names and convert Decimals to honest numbers.
 *   4. No session = empty/zero, never a throw into the nav.
 */

export {}

const ORG = 'org-real'
const USER = 'user-1'

let sessionState: { orgId: string | null; userId: string | null } = {
  orgId: ORG,
  userId: USER,
}

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.orgId
          ? {
              session: { activeOrganizationId: sessionState.orgId },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
const notificationsFindMany = jest.fn()
const notificationsCount = jest.fn()
const notificationsUpdateMany = jest.fn()
const customersFindMany = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    customer_alert_notifications: {
      findMany: (a: unknown) => notificationsFindMany(a),
      count: (a: unknown) => notificationsCount(a),
      updateMany: (a: unknown) => notificationsUpdateMany(a),
    },
    customers: {
      findMany: (a: unknown) => customersFindMany(a),
    },
  },
}))

import { Decimal } from '@prisma/client/runtime/library'
import {
  getCustomerAlertNotifications,
  getUnreadCustomerAlertCount,
  markCustomerAlertNotificationsRead,
} from '../customer-alert-notifications'

const FIRED_AT = new Date('2026-08-26T12:00:00.000Z')

function notificationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    orgId: ORG,
    userId: USER,
    alertId: 'watch-1',
    customerId: 'cust-1',
    metric: 'cost',
    thresholdUsd: new Decimal(500),
    valueUsd: new Decimal('512.4'),
    windowMode: 'month',
    firedAt: FIRED_AT,
    readAt: null,
    ...over,
  }
}

beforeEach(() => {
  sessionState = { orgId: ORG, userId: USER }
  notificationsFindMany.mockReset().mockResolvedValue([])
  notificationsCount.mockReset().mockResolvedValue(0)
  notificationsUpdateMany.mockReset().mockResolvedValue({ count: 0 })
  customersFindMany.mockReset().mockResolvedValue([])
})

describe('getUnreadCustomerAlertCount — scoping', () => {
  it('counts ONLY (userId = viewer AND orgId = active org AND readAt null)', async () => {
    notificationsCount.mockResolvedValue(3)
    const res = await getUnreadCustomerAlertCount()
    expect(res).toEqual({ success: true, count: 3 })
    expect(notificationsCount).toHaveBeenCalledWith({
      where: { userId: USER, orgId: ORG, readAt: null },
    })
  })

  it('no session reads as 0 without touching the DB', async () => {
    sessionState = { orgId: null, userId: null }
    const res = await getUnreadCustomerAlertCount()
    expect(res).toEqual({ success: true, count: 0 })
    expect(notificationsCount).not.toHaveBeenCalled()
  })

  it('a DB explosion reads as 0 — a broken poll never breaks the nav', async () => {
    notificationsCount.mockRejectedValue(new Error('db down'))
    const res = await getUnreadCustomerAlertCount()
    expect(res).toEqual({ success: false, count: 0 })
  })
})

describe('getCustomerAlertNotifications — the feed', () => {
  it('reads ONLY the viewer+org rows, newest first, capped at 20', async () => {
    notificationsFindMany.mockResolvedValue([notificationRow()])
    customersFindMany.mockResolvedValue([{ id: 'cust-1', name: 'Acme' }])

    const res = await getCustomerAlertNotifications()

    expect(notificationsFindMany).toHaveBeenCalledWith({
      where: { userId: USER, orgId: ORG },
      orderBy: { firedAt: 'desc' },
      take: 20,
    })
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(1)
  })

  it('joins the customer name org-scoped and converts Decimals to honest numbers', async () => {
    notificationsFindMany.mockResolvedValue([notificationRow()])
    customersFindMany.mockResolvedValue([{ id: 'cust-1', name: 'Acme' }])

    const res = await getCustomerAlertNotifications()
    const row = res.data![0]

    // The name join carries its own org clause — safety is local, not
    // inherited from the notification rows' scoping.
    expect(customersFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['cust-1'] }, organizationId: ORG },
      select: { id: true, name: true },
    })
    expect(row.customerName).toBe('Acme')
    expect(row.thresholdUsd).toBe(500)
    expect(row.valueUsd).toBeCloseTo(512.4, 6)
    expect(row.firedAt).toBe(FIRED_AT.toISOString())
    expect(row.readAt).toBeNull()
  })

  it('a hard-deleted customer degrades to a null name, never a crash', async () => {
    notificationsFindMany.mockResolvedValue([
      notificationRow({ customerId: 'cust-gone' }),
    ])
    customersFindMany.mockResolvedValue([])
    const res = await getCustomerAlertNotifications()
    expect(res.success).toBe(true)
    expect(res.data![0].customerName).toBeNull()
  })

  it('no session is an explicit error, not an empty success', async () => {
    sessionState = { orgId: null, userId: null }
    const res = await getCustomerAlertNotifications()
    expect(res.success).toBe(false)
    expect(notificationsFindMany).not.toHaveBeenCalled()
  })
})

describe('markCustomerAlertNotificationsRead', () => {
  it('stamps readAt on exactly the viewer+org unread rows', async () => {
    notificationsUpdateMany.mockResolvedValue({ count: 2 })
    const res = await markCustomerAlertNotificationsRead()
    expect(res).toEqual({ success: true, marked: 2 })
    const arg = notificationsUpdateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ userId: USER, orgId: ORG, readAt: null })
    expect(arg.data.readAt).toBeInstanceOf(Date)
  })

  it('no session marks nothing', async () => {
    sessionState = { orgId: null, userId: null }
    const res = await markCustomerAlertNotificationsRead()
    expect(res).toEqual({ success: true, marked: 0 })
    expect(notificationsUpdateMany).not.toHaveBeenCalled()
  })
})
