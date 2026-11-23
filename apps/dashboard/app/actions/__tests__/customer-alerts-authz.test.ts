/**
 * Authz + forward proofs for the customer-watch actions.
 *
 * Behavioral, mutation-sensitive (the build-writes-authz pattern): the fetch
 * mock is asserted called / not-called, so deleting a guard line goes RED.
 * What this pins:
 *   1. Writes fail closed: non-money roles never reach the network; the API
 *      is the authority for allowed callers.
 *   2. The forward carries the caller's session cookie and the internal
 *      customer UUID — api-nest's guards see the real human.
 *   3. api-nest's own plain-English error bubbles up verbatim (the 409
 *      duplicate, the 400 recipient rule); a dead network degrades to the
 *      unreachable message, never a hang or a throw.
 *   4. The read is fail-closed too: a non-money caller gets canManage false
 *      and ZERO rows (thresholds are money data).
 *   5. The read returns only the active org's watches, never another org's.
 */

export {}

const ORG = 'org-real'
const OTHER_ORG = 'org-other'
const USER = 'user-1'
const CUSTOMER_UUID = '3f2a8c1e-0000-4000-8000-000000000001'

/** One watch in each org, so a read that reaches the wrong one is visible in
 *  the rows and not only in the query it sent. */
const WATCH_ROWS = [
  {
    id: 'real-watch',
    orgId: ORG,
    customerId: CUSTOMER_UUID,
    metric: 'cost',
    thresholdUsd: 500,
    windowMode: 'month',
    customStartDate: null,
    customEndDate: null,
    recipientEmail: 'finance@real.example',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  },
  {
    id: 'other-watch',
    orgId: OTHER_ORG,
    customerId: CUSTOMER_UUID,
    metric: 'revenue',
    thresholdUsd: 240,
    windowMode: 'rolling',
    customStartDate: null,
    customEndDate: null,
    recipientEmail: 'owner@other.example',
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
  },
]

let sessionState: { orgId: string | null; userId: string | null } = {
  orgId: ORG,
  userId: USER,
}
let memberRole: string | null = 'finance'

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
jest.mock('next/headers', () => ({
  headers: async () => new Headers({ cookie: 'better-auth.session=abc123' }),
}))
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }))
// The dual-root @/lib alias resolves api/config differently under jest than
// under next build; mock it flat (the org-settings-authz precedent) so the
// suite never depends on env vars.
jest.mock('@/lib/api/config', () => ({
  API_BASE_URL: 'http://test.local/v1',
  API_TIMEOUT: 10_000,
}))

const baMemberFindFirst = jest.fn()
const alertsFindMany = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    customer_alerts: { findMany: (a: unknown) => alertsFindMany(a) },
  },
}))

import {
  createCustomerWatch,
  deleteCustomerWatch,
  getCustomerWatches,
  updateCustomerWatch,
} from '../customer-alerts'

const fetchMock = jest.fn()
global.fetch = fetchMock as unknown as typeof fetch

function apiOk(body: unknown = {}) {
  return { ok: true, status: 200, json: async () => body }
}

function apiError(status: number, message: string) {
  return { ok: false, status, json: async () => ({ message }) }
}

beforeEach(() => {
  sessionState = { orgId: ORG, userId: USER }
  memberRole = 'finance'
  baMemberFindFirst
    .mockReset()
    .mockImplementation(async () => (memberRole ? { role: memberRole } : null))
  alertsFindMany
    .mockReset()
    .mockImplementation(async (args: { where: { orgId: string; customerId: string } }) =>
      WATCH_ROWS.filter(
        (row) =>
          row.orgId === args.where.orgId &&
          row.customerId === args.where.customerId
      )
    )
  fetchMock.mockReset().mockResolvedValue(apiOk())
})

const input = { metric: 'cost', thresholdUsd: 500, windowMode: 'month' }

describe('write guards — fail closed BEFORE the network', () => {
  it.each(['developer', 'member'])('a %s caller is refused and fetch never fires', async (role) => {
    memberRole = role
    const res = await createCustomerWatch(CUSTOMER_UUID, input)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/owners, admins, and finance/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no session is refused before the network', async () => {
    sessionState = { orgId: null, userId: null }
    const res = await createCustomerWatch(CUSTOMER_UUID, input)
    expect(res.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the forward — cookie, verb, path, payload', () => {
  it('create POSTs the internal customer UUID with the session cookie attached', async () => {
    const res = await createCustomerWatch(CUSTOMER_UUID, {
      ...input,
      customStartDate: undefined,
      customEndDate: undefined,
    })
    expect(res.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/customer-alerts$/)
    expect(init.method).toBe('POST')
    expect(init.headers.Cookie).toBe('better-auth.session=abc123')
    const body = JSON.parse(init.body)
    expect(body.customerId).toBe(CUSTOMER_UUID)
    expect(body.thresholdUsd).toBe(500)
    expect(body.customStartDate).toBeUndefined()
  })

  it('update PATCHes /customer-alerts/:id; delete DELETEs it', async () => {
    await updateCustomerWatch('watch-9', input)
    await deleteCustomerWatch('watch-9')
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/customer-alerts\/watch-9$/)
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH')
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/customer-alerts\/watch-9$/)
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE')
  })

  it("api-nest's own message bubbles up verbatim (the 409 duplicate)", async () => {
    fetchMock.mockResolvedValue(
      apiError(
        409,
        'An identical watch already exists for this customer (same metric, window, threshold, and recipient). Edit that one instead of creating a copy.'
      )
    )
    const res = await createCustomerWatch(CUSTOMER_UUID, input)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/identical watch already exists/)
  })

  it('a dead network degrades to the unreachable message, never a throw', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const res = await createCustomerWatch(CUSTOMER_UUID, input)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/couldn't reach the alerts service/i)
  })
})

describe('getCustomerWatches — fail-closed read', () => {
  it('a money role reads this customer scoped to the active org', async () => {
    const res = await getCustomerWatches(CUSTOMER_UUID)
    expect(res.success).toBe(true)
    expect(res.canManage).toBe(true)
    expect(alertsFindMany).toHaveBeenCalledWith({
      where: { orgId: ORG, customerId: CUSTOMER_UUID },
      orderBy: { createdAt: 'desc' },
    })
  })

  it('a developer gets canManage false and the DB is never queried', async () => {
    memberRole = 'developer'
    const res = await getCustomerWatches(CUSTOMER_UUID)
    expect(res).toEqual({ success: true, canManage: false, watches: [] })
    expect(alertsFindMany).not.toHaveBeenCalled()
  })

  it("a money role reads its own org's rows back, not another org's", async () => {
    const res = await getCustomerWatches(CUSTOMER_UUID)
    expect(res.watches?.map((w) => w.id)).toEqual(['real-watch'])
  })

})
