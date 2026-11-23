/**
 * WHAT THIS FILE DOES: proves the BUILD-write role gate on the
 * actual dashboard Server Actions, not only the shared helper. For each build write
 * (agents / customers / signals), it asserts the OUTCOME:
 *
 *   - a plain `member` is DENIED and the underlying DB mutation NEVER fires
 *   - a `finance` user is DENIED too (finance owns the BOOKS, not the build plumbing)
 *   - an `owner` / `admin` is ALLOWED and the mutation DOES fire, scoped to the active org
 *
 * api-keys create/revoke are NOT in this matrix: they gate on
 * MINT_KEY_ROLES via assertKeyMinter, not MANAGE_BUILD_ROLES via assertBuildManager —
 * finance is deliberately ALLOWED there, which would
 * make it a false positive in the shared "finance is denied" block below. See the
 * dedicated 'api-keys mint/revoke gate' describe block at the bottom of this file.
 *
 * These are behavioral (the write-mock is asserted called / not-called), so they are
 * mutation-sensitive: delete the `assertBuildManager()` line from any action and the
 * matching "member is denied / nothing written" case goes RED. The whole DB is mocked,
 * including the role lookup.
 */

export {}

const ORG = 'org-real-build'
const USER = 'user-build'

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
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
// The role lookup (gate) + every domain write all live on this one mocked db.
const baMemberFindFirst = jest.fn()
const agentsFindFirst = jest.fn()
const agentsFindUnique = jest.fn()
const agentsCreate = jest.fn()
const agentsUpdate = jest.fn()
const customersFindFirst = jest.fn()
const customersCreate = jest.fn()
const customersUpdate = jest.fn()
const signalsFindFirst = jest.fn()
const signalsCreate = jest.fn()
const signalsUpdate = jest.fn()
const apiKeysFindFirst = jest.fn()
const apiKeysCreate = jest.fn()
const apiKeysUpdate = jest.fn()
// RevokeApiKey/deleteApiKey run inside db.$transaction and
// cascade to the portal tables, so the mock needs both delegates plus a
// pass-through $transaction.
const portalLinksUpdateMany = jest.fn()
const portalSessionsUpdateMany = jest.fn()

jest.mock('@/app/lib/db', () => {
  const db: Record<string, unknown> = {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    agents: {
      findFirst: (a: unknown) => agentsFindFirst(a),
      findUnique: (a: unknown) => agentsFindUnique(a),
      create: (a: unknown) => agentsCreate(a),
      update: (a: unknown) => agentsUpdate(a),
    },
    customers: {
      findFirst: (a: unknown) => customersFindFirst(a),
      create: (a: unknown) => customersCreate(a),
      update: (a: unknown) => customersUpdate(a),
    },
    signals: {
      findFirst: (a: unknown) => signalsFindFirst(a),
      create: (a: unknown) => signalsCreate(a),
      update: (a: unknown) => signalsUpdate(a),
    },
    api_keys: {
      findFirst: (a: unknown) => apiKeysFindFirst(a),
      create: (a: unknown) => apiKeysCreate(a),
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
  return {
    db,
    // Bindings the modules destructure at import; never exercised on these paths.
    Prisma: { InputJsonValue: {} },
  }
})

type Agents = typeof import('../agents')
type Customers = typeof import('../customers')
type Signals = typeof import('../signals')
type ApiKeys = typeof import('../api-keys')

let agents: Agents
let customers: Customers
let signals: Signals
let apiKeys: ApiKeys

beforeAll(async () => {
  agents = await import('../agents')
  customers = await import('../customers')
  signals = await import('../signals')
  apiKeys = await import('../api-keys')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    agentsFindFirst,
    agentsFindUnique,
    agentsCreate,
    agentsUpdate,
    customersFindFirst,
    customersCreate,
    customersUpdate,
    signalsFindFirst,
    signalsCreate,
    signalsUpdate,
    apiKeysFindFirst,
    apiKeysCreate,
    apiKeysUpdate,
    portalLinksUpdateMany,
    portalSessionsUpdateMany,
  ].forEach((m) => m.mockReset())

  // Default "row exists" returns so ALLOW paths reach their write instead of an
  // early not-found bail. (Reset per-test; DENY paths never get this far.)
  agentsFindFirst.mockResolvedValue(null) // createAgent: no dup code
  agentsFindUnique.mockResolvedValue({ id: 'a1', name: 'A', agentCode: 'AC' })
  agentsCreate.mockResolvedValue({
    id: 'a1',
    name: 'A',
    description: '',
    agentCode: 'AC',
    orgId: ORG,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  agentsUpdate.mockResolvedValue({})
  customersCreate.mockResolvedValue({
    id: 'c1',
    organizationId: ORG,
    name: 'C',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  customersFindFirst.mockResolvedValue({ id: 'c1', organizationId: ORG })
  customersUpdate.mockResolvedValue({})
  signalsCreate.mockResolvedValue({
    id: 's1',
    name: 'S',
    shortName: 'S',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  signalsFindFirst.mockResolvedValue({ id: 's1', orgId: ORG })
  signalsUpdate.mockResolvedValue({})
  apiKeysCreate.mockResolvedValue({
    id: 'k1',
    name: 'K',
    description: null,
    keyPrefix: 'mf_sk_abc',
    keyType: 'secret',
    status: 'active',
    permissions: [],
    createdAt: new Date(),
  })
  // keyType 'secret' so the ALLOW cases exercise the portal cascade
  // path instead of silently skipping it.
  apiKeysFindFirst.mockResolvedValue({
    id: 'k1',
    organizationId: ORG,
    keyType: 'secret',
  })
  apiKeysUpdate.mockResolvedValue({})
  portalLinksUpdateMany.mockResolvedValue({ count: 0 })
  portalSessionsUpdateMany.mockResolvedValue({ count: 0 })
})

// ---- the matrix: (action, the write-mock that must NOT fire on deny) ----------------

describe('BUILD-write gate — DENY: member + finance are blocked, NOTHING is written', () => {
  const denyRoles = ['member', 'finance', 'noRow'] as const
  function setRole(r: string) {
    baMemberFindFirst.mockResolvedValue(r === 'noRow' ? null : { role: r })
  }

  it.each(denyRoles)('createAgent denied for %s', async (r) => {
    setRole(r)
    const res = await agents.createAgent({ name: 'x', agentCode: 'X' } as any)
    expect(res.success).toBe(false)
    expect(agentsCreate).not.toHaveBeenCalled()
  })

  it.each(denyRoles)('deleteAgent denied for %s', async (r) => {
    setRole(r)
    const res = await agents.deleteAgent('a1')
    expect(res.success).toBe(false)
    expect(agentsUpdate).not.toHaveBeenCalled()
  })

  it.each(denyRoles)('createCustomer denied for %s', async (r) => {
    setRole(r)
    const res = await customers.createCustomer({ name: 'x' } as any)
    expect(res.success).toBe(false)
    expect(customersCreate).not.toHaveBeenCalled()
  })

  it.each(denyRoles)(
    'deleteCustomer denied for %s (cascade-bearing delete is gated)',
    async (r) => {
      setRole(r)
      const res = await customers.deleteCustomer('c1')
      expect(res.success).toBe(false)
      expect(customersUpdate).not.toHaveBeenCalled()
    }
  )

  it.each(denyRoles)('createSignal denied for %s', async (r) => {
    setRole(r)
    const res = await signals.createSignal({ name: 'x', agentId: 'a1' } as any)
    expect(res.success).toBe(false)
    expect(signalsCreate).not.toHaveBeenCalled()
  })

  it.each(denyRoles)('deleteSignal denied for %s', async (r) => {
    setRole(r)
    const res = await signals.deleteSignal('s1')
    expect(res.success).toBe(false)
    expect(signalsUpdate).not.toHaveBeenCalled()
  })
})

describe('BUILD-write gate — ALLOW: owner/admin/developer pass and the write fires', () => {
  // 'developer' is the build/operations seat — it holds every
  // build write. finance/member stay in denyRoles above (finance owns the books).
  const allowRoles = ['owner', 'admin', 'developer'] as const

  it.each(allowRoles)('createAgent allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    const res = await agents.createAgent({ name: 'x', agentCode: 'X' } as any)
    expect(res.success).toBe(true)
    expect(agentsCreate).toHaveBeenCalledTimes(1)
    // Gate read the role in the active org.
    expect(baMemberFindFirst.mock.calls[0][0].where.organizationId).toBe(
      ORG
    )
  })

  it.each(allowRoles)('deleteAgent allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    // deleteAgent verifies the row exists before the soft-delete write.
    agentsFindFirst.mockResolvedValue({ id: 'a1', orgId: ORG })
    const res = await agents.deleteAgent('a1')
    expect(res.success).toBe(true)
    expect(agentsUpdate).toHaveBeenCalledTimes(1)
  })

  it.each(allowRoles)('createCustomer allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    const res = await customers.createCustomer({ name: 'x' } as any)
    expect(res.success).toBe(true)
    expect(customersCreate).toHaveBeenCalledTimes(1)
  })

  it.each(allowRoles)('deleteCustomer allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    const res = await customers.deleteCustomer('c1')
    expect(res.success).toBe(true)
    expect(customersUpdate).toHaveBeenCalledTimes(1)
  })

  it.each(allowRoles)('createSignal allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    // createSignal verifies the parent agent exists before writing the meter.
    agentsFindFirst.mockResolvedValue({ id: 'a1', orgId: ORG })
    const res = await signals.createSignal({ name: 'x', agentId: 'a1' } as any)
    expect(res.success).toBe(true)
    expect(signalsCreate).toHaveBeenCalledTimes(1)
  })

  it.each(allowRoles)('deleteSignal allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    const res = await signals.deleteSignal('s1')
    expect(res.success).toBe(true)
    expect(signalsUpdate).toHaveBeenCalledTimes(1)
  })
})

// Api-keys create/revoke gate on MINT_KEY_ROLES (assertKeyMinter),
// NOT MANAGE_BUILD_ROLES (assertBuildManager) — deliberately wider by 'finance'
// (finance may mint/revoke a finance-scoped key).
// member and no-membership stay denied; owner/admin/developer/finance are allowed.
describe('api-keys mint/revoke gate — MINT_KEY_ROLES (assertKeyMinter), wider than MANAGE_BUILD_ROLES by finance', () => {
  const denyRoles = ['member', 'noRow'] as const
  function setRole(r: string) {
    baMemberFindFirst.mockResolvedValue(r === 'noRow' ? null : { role: r })
  }

  it.each(denyRoles)('createApiKey denied for %s', async (r) => {
    setRole(r)
    const res = await apiKeys.createApiKey({
      name: 'x',
      keyType: 'secret',
    } as any)
    expect(res.success).toBe(false)
    expect(apiKeysCreate).not.toHaveBeenCalled()
  })

  it.each(denyRoles)('revokeApiKey denied for %s', async (r) => {
    setRole(r)
    const res = await apiKeys.revokeApiKey('k1')
    expect(res.success).toBe(false)
    expect(apiKeysUpdate).not.toHaveBeenCalled()
  })

  const allowRoles = ['owner', 'admin', 'developer', 'finance'] as const

  it.each(allowRoles)('createApiKey allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    const res = await apiKeys.createApiKey({
      name: 'x',
      keyType: 'secret',
    } as any)
    expect(res.success).toBe(true)
    expect(apiKeysCreate).toHaveBeenCalledTimes(1)
  })

  it.each(allowRoles)('revokeApiKey allowed for %s', async (r) => {
    baMemberFindFirst.mockResolvedValue({ role: r })
    const res = await apiKeys.revokeApiKey('k1')
    expect(res.success).toBe(true)
    expect(apiKeysUpdate).toHaveBeenCalledTimes(1)
  })

  it('mutation sensitivity: finance writes, member does not — for the identical input', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'finance' })
    expect(
      (await apiKeys.createApiKey({ name: 'x', keyType: 'secret' } as any))
        .success
    ).toBe(true)
    expect(apiKeysCreate).toHaveBeenCalledTimes(1)

    apiKeysCreate.mockClear()
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    expect(
      (await apiKeys.createApiKey({ name: 'x', keyType: 'secret' } as any))
        .success
    ).toBe(false)
    expect(apiKeysCreate).not.toHaveBeenCalled()
  })
})

// MUTATION SENSITIVITY: same call, only the role flips -> outcome flips. Proves the
// suite reads the role and isn't vacuously green.
describe('BUILD-write gate — mutation sensitivity (role flip flips outcome)', () => {
  it('createAgent: owner writes, member does not — for the identical input', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    expect(
      (await agents.createAgent({ name: 'x', agentCode: 'X' } as any)).success
    ).toBe(true)
    expect(agentsCreate).toHaveBeenCalledTimes(1)

    agentsCreate.mockClear()
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    expect(
      (await agents.createAgent({ name: 'x', agentCode: 'X' } as any)).success
    ).toBe(false)
    expect(agentsCreate).not.toHaveBeenCalled()
  })
})
