/**
 * WHAT THIS FILE DOES: proves the magic-link redeem route cannot
 * mint a portal session that escapes the revoke cascade.
 *
 * The cascade and the redeem serialize on the link row, so the redeem's claim
 * must be (a) a predicate-checked update carrying the same live-row WHERE the
 * cascade locks on, and (b) in the SAME transaction as the session mint. If
 * the mint ran after the claim's commit, a revoke could land between the two
 * writes and the fresh session would survive it — the exact window this
 * lock closes.
 *
 *   1. Claim lost (revoke won): zero sessions minted, zero cookies set, the
 *      customer lands on the link-expired page.
 *   2. Claim lost (second tab won): same, but the already-used page.
 *   3. Claim won: the session row is written through the claim's OWN
 *      transaction client, inside the transaction, after the claim — never
 *      through the root client, never after commit.
 *
 * Fully mocked DB, no network.
 */

export {}

const mockCookieSet = jest.fn()
const mockLinkFindUnique = jest.fn()
const mockClaimUpdateMany = jest.fn()
const mockTxSessionCreate = jest.fn()
const mockRootSessionCreate = jest.fn()

let mockInTransaction = false
let mockClaimRanInTransaction: boolean | null = null
let mockCreateRanInTransaction: boolean | null = null

const mockTxClient = {
  portal_magic_links: {
    updateMany: (args: unknown) => {
      mockClaimRanInTransaction = mockInTransaction
      return mockClaimUpdateMany(args)
    },
  },
  portal_sessions: {
    create: (args: unknown) => {
      mockCreateRanInTransaction = mockInTransaction
      return mockTxSessionCreate(args)
    },
  },
}

const mockDb = {
  app_throttle: {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  },
  portal_magic_links: {
    findUnique: (args: unknown) => mockLinkFindUnique(args),
  },
  portal_sessions: {
    create: (args: unknown) => mockRootSessionCreate(args),
  },
  $transaction: async (fn: (tx: unknown) => unknown) => {
    mockInTransaction = true
    try {
      return await fn(mockTxClient)
    } finally {
      mockInTransaction = false
    }
  },
}

jest.mock('@prisma/client', () => ({
  Prisma: {},
}))
jest.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: { redirect: (url: string) => ({ redirectedTo: url }) },
}))
jest.mock('next/headers', () => ({
  cookies: async () => ({ set: mockCookieSet, get: () => undefined }),
  headers: async () => new Headers(),
}))
jest.mock('@marginfront/db', () => ({
  db: mockDb,
  hashApiKeyForLookup: (token: string) => `hashed:${token}`,
}))

const LINK = {
  id: 'link-1',
  customerId: 'cust-1',
  organizationId: 'org-1',
  usedAt: null,
  expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  organizations: { slug: 'larkspur' },
}

type RedeemResult = { redirectedTo: string }

let GET: (
  request: unknown,
  context: { params: Promise<{ token: string }> }
) => Promise<RedeemResult>

beforeAll(async () => {
  const route = await import('../route')
  GET = route.GET as unknown as typeof GET
})

beforeEach(() => {
  ;[
    mockCookieSet,
    mockLinkFindUnique,
    mockClaimUpdateMany,
    mockTxSessionCreate,
    mockRootSessionCreate,
  ].forEach((m) => m.mockReset())
  mockDb.app_throttle.findUnique.mockResolvedValue(null)
  mockClaimRanInTransaction = null
  mockCreateRanInTransaction = null
})

function redeem(token = 'mgl_live-token') {
  const request = {
    headers: new Headers({
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'jest-agent',
      host: 'portal.test',
    }),
    nextUrl: { origin: 'https://portal.test' },
  }
  return GET(request, { params: Promise.resolve({ token }) })
}

describe('magic-link redeem vs key revoke — the claim transaction', () => {
  it('revoke wins the race: claim misses, no session is minted, no cookie is set', async () => {
    mockLinkFindUnique
      .mockResolvedValueOnce(LINK) // initial lookup: link still looked live
      .mockResolvedValueOnce({ usedAt: null }) // post-loss re-read: unused, so it was expired out
    mockClaimUpdateMany.mockResolvedValue({ count: 0 }) // cascade got the row first

    const res = await redeem()

    expect(mockTxSessionCreate).not.toHaveBeenCalled()
    expect(mockRootSessionCreate).not.toHaveBeenCalled()
    expect(mockCookieSet).not.toHaveBeenCalled()
    expect(res.redirectedTo).toBe(
      'https://portal.test/larkspur/link-error?reason=link_expired'
    )
  })

  it('second tab wins the race: claim misses, customer sees already-used', async () => {
    mockLinkFindUnique
      .mockResolvedValueOnce(LINK)
      .mockResolvedValueOnce({ usedAt: new Date() })
    mockClaimUpdateMany.mockResolvedValue({ count: 0 })

    const res = await redeem()

    expect(mockTxSessionCreate).not.toHaveBeenCalled()
    expect(mockCookieSet).not.toHaveBeenCalled()
    expect(res.redirectedTo).toBe(
      'https://portal.test/larkspur/link-error?reason=link_already_used'
    )
  })

  it('the claim carries the same live-row WHERE the cascade locks on', async () => {
    mockLinkFindUnique
      .mockResolvedValueOnce(LINK)
      .mockResolvedValueOnce({ usedAt: null })
    mockClaimUpdateMany.mockResolvedValue({ count: 0 })

    await redeem()

    // id + usedAt null + unexpired: this predicate is what makes the claim
    // contend with the cascade's row lock and refuse after the cascade wins.
    const claimArgs = mockClaimUpdateMany.mock.calls[0][0]
    expect(claimArgs.where.id).toBe(LINK.id)
    expect(claimArgs.where.usedAt).toBeNull()
    expect(claimArgs.where.expiresAt.gt).toBeInstanceOf(Date)
    expect(claimArgs.data.usedAt).toBeInstanceOf(Date)
  })

  it('redeem wins: session mints through the claim transaction, then the cookie', async () => {
    mockLinkFindUnique.mockResolvedValueOnce(LINK)
    mockClaimUpdateMany.mockResolvedValue({ count: 1 })
    mockTxSessionCreate.mockResolvedValue({})

    const res = await redeem()

    // The mint happened INSIDE the claim's transaction, through the tx
    // client, after the claim — never through the root client. Root-client
    // or post-commit minting would reopen the revoke window.
    expect(mockTxSessionCreate).toHaveBeenCalledTimes(1)
    expect(mockRootSessionCreate).not.toHaveBeenCalled()
    expect(mockClaimRanInTransaction).toBe(true)
    expect(mockCreateRanInTransaction).toBe(true)
    expect(mockClaimUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockTxSessionCreate.mock.invocationCallOrder[0]
    )

    const createArgs = mockTxSessionCreate.mock.calls[0][0]
    expect(createArgs.data.customerId).toBe(LINK.customerId)
    expect(createArgs.data.organizationId).toBe(LINK.organizationId)
    expect(createArgs.data.token).toMatch(/^hashed:prtl_/)
    expect(createArgs.data.expiresAt).toBeInstanceOf(Date)

    // Cookie carries the RAW prtl_ token; redirect lands on the org home.
    const [cookieName, cookieValue, cookieOpts] = mockCookieSet.mock.calls[0]
    expect(cookieName).toBe('mf_portal_session')
    expect(cookieValue).toMatch(/^prtl_/)
    expect(cookieOpts.httpOnly).toBe(true)
    expect(res.redirectedTo).toBe('https://portal.test/larkspur/')
  })
})

describe('magic-link redeem looks tokens up by hash only', () => {
  it('a value that is not a live hash finds nothing, and the raw value is never queried', async () => {
    mockLinkFindUnique.mockResolvedValue(null)

    const res = await redeem('mgl_value-copied-from-the-table')

    expect(mockLinkFindUnique).toHaveBeenCalledTimes(1)
    expect(mockLinkFindUnique.mock.calls[0][0].where.token).toBe(
      'hashed:mgl_value-copied-from-the-table'
    )
    expect(mockCookieSet).not.toHaveBeenCalled()
    expect(res.redirectedTo).toBe(
      'https://portal.test/r/link-error?reason=invalid_link'
    )
  })
})
