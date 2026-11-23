/**
 * WHAT THIS FILE DOES: proves that revoking OR deleting a SECRET key
 * through the dashboard actions ends the org's live portal access in the same
 * transaction, and that the blast radius stays exactly as designed:
 *
 *   1. revokeApiKey on a secret key fires BOTH portal updateMany cascades with
 *      the pinned WHERE shapes (org-scoped, live-rows-only) and a past-dated
 *      expiresAt, and returns the honest counts.
 *   2. deleteApiKey cascades identically.
 *   3. A PUBLISHABLE key revoke cascades NOTHING (publishable keys cannot mint
 *      portal access, so signing customers out would be pure collateral).
 *   4. The cascade is tenant-scoped: every WHERE carries the caller's org id.
 *   5. The role gate sits ABOVE the transaction: a plain member is refused and
 *      no portal row is touched.
 *   6. A cascade failure fails the whole action with a plain-English error
 *      (real Prisma rolls the transaction back; the mock only needs to prove
 *      the action surfaces the failure instead of half-succeeding).
 *
 * Fully mocked DB, no network.
 */

export {}

const ORG = 'org-real-cascade'
const USER = 'user-cascade'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = {
  activeOrganizationId: ORG,
  userId: USER,
}

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const baMemberFindFirst = jest.fn()
const apiKeysFindFirst = jest.fn()
const apiKeysUpdate = jest.fn()
const portalLinksUpdateMany = jest.fn()
const portalSessionsUpdateMany = jest.fn()

jest.mock('@/app/lib/db', () => {
  const db: Record<string, unknown> = {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    api_keys: {
      findFirst: (a: unknown) => apiKeysFindFirst(a),
      update: (a: unknown) => apiKeysUpdate(a),
    },
    portal_magic_links: {
      updateMany: (a: unknown) => portalLinksUpdateMany(a),
    },
    portal_sessions: {
      updateMany: (a: unknown) => portalSessionsUpdateMany(a),
    },
  }
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db)
  return { db, Prisma: { InputJsonValue: {} } }
})

type ApiKeys = typeof import('../api-keys')
let apiKeys: ApiKeys

beforeAll(async () => {
  apiKeys = await import('../api-keys')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    apiKeysFindFirst,
    apiKeysUpdate,
    portalLinksUpdateMany,
    portalSessionsUpdateMany,
  ].forEach((m) => m.mockReset())

  baMemberFindFirst.mockResolvedValue({ role: 'owner' })
  apiKeysFindFirst.mockResolvedValue({
    id: 'k-secret',
    organizationId: ORG,
    keyType: 'secret',
  })
  apiKeysUpdate.mockResolvedValue({})
  portalLinksUpdateMany.mockResolvedValue({ count: 2 })
  portalSessionsUpdateMany.mockResolvedValue({ count: 3 })
})

function expectCascadeWhereShapes() {
  const linkArgs = portalLinksUpdateMany.mock.calls[0][0]
  const sessionArgs = portalSessionsUpdateMany.mock.calls[0][0]

  // Tenant scope + live-rows-only filters (the honest-count WHERE).
  expect(linkArgs.where.organizationId).toBe(ORG)
  expect(linkArgs.where.usedAt).toBeNull()
  expect(linkArgs.where.expiresAt.gt).toBeInstanceOf(Date)
  expect(sessionArgs.where.organizationId).toBe(ORG)
  expect(sessionArgs.where.expiresAt.gt).toBeInstanceOf(Date)

  // The written expiry sits strictly in the past for every strict-gt reader.
  const comparedNow: Date = linkArgs.where.expiresAt.gt
  expect(
    comparedNow.getTime() - linkArgs.data.expiresAt.getTime()
  ).toBeGreaterThanOrEqual(1000)
  expect(
    comparedNow.getTime() - sessionArgs.data.expiresAt.getTime()
  ).toBeGreaterThanOrEqual(1000)
}

describe('revokeApiKey — secret-key revoke cascades to portal access', () => {
  it('fires both portal cascades with the pinned WHERE shapes and returns honest counts', async () => {
    const res = await apiKeys.revokeApiKey('k-secret')

    expect(res.success).toBe(true)
    expect(apiKeysUpdate).toHaveBeenCalledTimes(1)
    expect(portalLinksUpdateMany).toHaveBeenCalledTimes(1)
    expect(portalSessionsUpdateMany).toHaveBeenCalledTimes(1)
    expectCascadeWhereShapes()

    if (!res.success) throw new Error('unreachable')
    expect(res.data.magicLinksEnded).toBe(2)
    expect(res.data.portalSessionsEnded).toBe(3)
    // The message surfaces the real session count, not an invented one.
    expect(res.data.message).toContain('3')
  })

  it('clears the plaintext but KEEPS apiKeyLookupHash (honest-401 contract)', async () => {
    const res = await apiKeys.revokeApiKey('k-secret')

    expect(res.success).toBe(true)
    const written = apiKeysUpdate.mock.calls[0][0].data
    expect(written.apiKeyPlaintext).toBeNull()
    expect(written.status).toBe('revoked')
    // The retained hash is what lets the 401 path recognize the revoked key.
    // Nulling it on revoke turns this red.
    expect(written).not.toHaveProperty('apiKeyLookupHash')
  })

  it('a PUBLISHABLE key revoke cascades nothing', async () => {
    apiKeysFindFirst.mockResolvedValue({
      id: 'k-pub',
      organizationId: ORG,
      keyType: 'publishable',
    })

    const res = await apiKeys.revokeApiKey('k-pub')

    expect(res.success).toBe(true)
    expect(apiKeysUpdate).toHaveBeenCalledTimes(1)
    expect(portalLinksUpdateMany).not.toHaveBeenCalled()
    expect(portalSessionsUpdateMany).not.toHaveBeenCalled()
    if (!res.success) throw new Error('unreachable')
    expect(res.data.magicLinksEnded).toBe(0)
    expect(res.data.portalSessionsEnded).toBe(0)
  })

  it('the role gate sits ABOVE the transaction: member is refused, no portal row touched', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })

    const res = await apiKeys.revokeApiKey('k-secret')

    expect(res.success).toBe(false)
    expect(apiKeysUpdate).not.toHaveBeenCalled()
    expect(portalLinksUpdateMany).not.toHaveBeenCalled()
    expect(portalSessionsUpdateMany).not.toHaveBeenCalled()
  })

  it('a cascade failure fails the whole action with a plain-English error', async () => {
    portalSessionsUpdateMany.mockRejectedValue(new Error('connection lost'))

    const res = await apiKeys.revokeApiKey('k-secret')

    expect(res.success).toBe(false)
    if (res.success) throw new Error('unreachable')
    expect(res.error).toContain("wasn't revoked")
    expect(res.error).toContain('undone')
  })
})

describe('deleteApiKey — secret-key delete cascades identically', () => {
  it('fires both portal cascades and returns the counts', async () => {
    const res = await apiKeys.deleteApiKey('k-secret')

    expect(res.success).toBe(true)
    expect(apiKeysUpdate).toHaveBeenCalledTimes(1)
    expect(portalLinksUpdateMany).toHaveBeenCalledTimes(1)
    expect(portalSessionsUpdateMany).toHaveBeenCalledTimes(1)
    expectCascadeWhereShapes()

    if (!res.success) throw new Error('unreachable')
    expect(res.data.magicLinksEnded).toBe(2)
    expect(res.data.portalSessionsEnded).toBe(3)
  })

  it('still NULLs apiKeyLookupHash — the deliberate revoke/delete asymmetry', async () => {
    // Revoke keeps the hash so the 401 can say "revoked"; delete erases it.
    // A revoked key that is later deleted (the delete precondition has no
    // status filter) downgrades back to the generic 401 — pinned here so the
    // cliff is a contract, not an accident.
    const res = await apiKeys.deleteApiKey('k-secret')

    expect(res.success).toBe(true)
    const written = apiKeysUpdate.mock.calls[0][0].data
    expect(written.apiKeyPlaintext).toBeNull()
    expect(written.apiKeyLookupHash).toBeNull()
  })

  it('a publishable delete cascades nothing', async () => {
    apiKeysFindFirst.mockResolvedValue({
      id: 'k-pub',
      organizationId: ORG,
      keyType: 'publishable',
    })

    const res = await apiKeys.deleteApiKey('k-pub')

    expect(res.success).toBe(true)
    expect(portalLinksUpdateMany).not.toHaveBeenCalled()
    expect(portalSessionsUpdateMany).not.toHaveBeenCalled()
  })

  it('the BUILD gate sits above the transaction: finance is refused, no portal row touched', async () => {
    // deleteApiKey gates on assertBuildManager (MANAGE_BUILD_ROLES), which
    // excludes finance — unlike the revoke door's MINT_KEY_ROLES.
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })

    const res = await apiKeys.deleteApiKey('k-secret')

    expect(res.success).toBe(false)
    expect(apiKeysUpdate).not.toHaveBeenCalled()
    expect(portalLinksUpdateMany).not.toHaveBeenCalled()
    expect(portalSessionsUpdateMany).not.toHaveBeenCalled()
  })
})
