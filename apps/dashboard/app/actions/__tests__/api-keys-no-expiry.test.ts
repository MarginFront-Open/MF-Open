/**
 * The dashboard's key-mint actions neither accept nor return expiresAt.
 *
 * The stored-expiry case is the load-bearing one: it proves that rows with an
 * expiresAt value are harmless rather than asserting it. A row carrying a long-past expiresAt still
 * reads back active, matching api-nest's validateApiKey, which filters only
 * apiKeyLookupHash + status + deletedAt (auth.service.ts) and never reads the column.
 *
 * Not vacuous: the row assertions use `'expiresAt' in data` rather than toBeUndefined(),
 * which would pass on a present-but-undefined key. Adding `expiresAt: expiresAt || null`
 * to either create action turns them red. Fully mocked DB.
 */

export {}

const ORG = 'org-no-expiry'
const USER = 'user-no-expiry'

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
const apiKeysFindMany = jest.fn()
const apiKeysCreate = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    api_keys: {
      findMany: (a: unknown) => apiKeysFindMany(a),
      create: (a: unknown) => apiKeysCreate(a),
    },
  },
}))

type ApiKeys = typeof import('../api-keys')
let apiKeys: ApiKeys

function dataOf<T>(r: { success: boolean; data?: T; error?: string }): T {
  if (!r.success || r.data === undefined)
    throw new Error(r.error ?? 'action failed')
  return r.data
}

function writtenRow(callIndex: number): Record<string, unknown> {
  return apiKeysCreate.mock.calls[callIndex][0].data
}

beforeAll(async () => {
  apiKeys = await import('../api-keys')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  apiKeysFindMany.mockReset()
  apiKeysCreate.mockReset()
  baMemberFindFirst.mockResolvedValue({ role: 'owner' })
  apiKeysCreate.mockImplementation(async (args: any) => ({
    id: `k-${apiKeysCreate.mock.calls.length}`,
    name: args.data.name,
    description: args.data.description,
    keyPrefix: args.data.keyPrefix,
    keyType: args.data.keyType,
    status: 'active',
    permissions: [],
    lastUsedAt: null,
    createdAt: new Date(),
  }))
})

describe('createApiKey — no expiry is written or returned', () => {
  it('writes a row with no expiresAt key at all', async () => {
    const res = await apiKeys.createApiKey({
      name: 'Single',
      keyType: 'secret',
    } as any)

    expect(res.success).toBe(true)
    expect(apiKeysCreate).toHaveBeenCalledTimes(1)
    expect('expiresAt' in writtenRow(0)).toBe(false)
  })

  it('returns a key carrying no expiresAt', async () => {
    const res = await apiKeys.createApiKey({
      name: 'Single',
      keyType: 'secret',
    } as any)

    expect('expiresAt' in dataOf(res)).toBe(false)
  })
})

describe('createApiKeyPair — no expiry on either half', () => {
  it('writes both rows with no expiresAt key at all', async () => {
    const res = await apiKeys.createApiKeyPair({ name: 'Pair' } as any)

    expect(res.success).toBe(true)
    expect(apiKeysCreate).toHaveBeenCalledTimes(2)
    expect('expiresAt' in writtenRow(0)).toBe(false)
    expect('expiresAt' in writtenRow(1)).toBe(false)
  })

  it('returns a secret and a publishable key, neither carrying expiresAt', async () => {
    const pair = dataOf(await apiKeys.createApiKeyPair({ name: 'Pair' } as any))

    expect('expiresAt' in pair.secretKey).toBe(false)
    expect('expiresAt' in pair.publishableKey).toBe(false)
  })
})

describe('getApiKeys — a row with a stored expiry is harmless', () => {
  beforeEach(() => {
    apiKeysFindMany.mockResolvedValue([
      {
        id: 'k-stored-expiry',
        name: 'Key someone set an expiry on in 2020',
        description: null,
        apiKeyPlaintext: null,
        keyPrefix: 'mf_sk_live',
        keyType: 'secret',
        status: 'active',
        permissions: [],
        lastUsedAt: null,
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        createdAt: new Date('2019-01-01T00:00:00.000Z'),
      },
    ])
  })

  it('still returns the key, still active — a long-past expiry retires nothing', async () => {
    const keys = dataOf(await apiKeys.getApiKeys())

    expect(keys).toHaveLength(1)
    expect(keys[0].id).toBe('k-stored-expiry')
    expect(keys[0].status).toBe('active')
  })

  it('drops the stored expiry from the shape it hands the UI', async () => {
    const keys = dataOf(await apiKeys.getApiKeys())

    expect('expiresAt' in keys[0]).toBe(false)
  })
})
