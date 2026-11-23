/**
 * WHAT THIS FILE DOES: proves that a plain READ of the API-keys list (getApiKeys)
 * never hands back a secret key's full plaintext,
 * and pins the rules around it:
 *
 *   1. SECRET keys (mf_sk_*) come back MASKED to `<prefix>...<last4>` — never the live secret.
 *   2. PUBLISHABLE keys (mf_pk_*) come back in FULL — they're frontend-safe by design.
 *   3. createApiKey STILL returns the full secret ONCE at creation (show-once-at-mint).
 *
 * The negative control pins that the test isn't vacuous: it asserts the returned secret value
 * is NOT the stored plaintext AND that it carries the `...` mask marker. If the read returns
 * `key.apiKeyPlaintext`, the "does not equal full plaintext"
 * assertion goes RED. Fully mocked DB.
 */

export {}

const ORG = 'org-real-mask'
const USER = 'user-mask'

const FULL_SECRET = 'mf_sk_live_SUPERSECRETbody_abcd1234'
const SECRET_PREFIX = 'mf_sk_live'
const FULL_PUBLISHABLE = 'mf_pk_live_publishable_value_5678'

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

// Narrow the discriminated ActionResult union to its success payload (or throw).
function dataOf<T>(r: { success: boolean; data?: T; error?: string }): T {
  if (!r.success || r.data === undefined)
    throw new Error(r.error ?? 'action failed')
  return r.data
}
type Key = { id: string; apiKeyPlaintext?: string }

beforeAll(async () => {
  apiKeys = await import('../api-keys')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  baMemberFindFirst.mockReset()
  apiKeysFindMany.mockReset()
  apiKeysCreate.mockReset()
})

describe('getApiKeys — secret-key plaintext is MASKED on read', () => {
  beforeEach(() => {
    apiKeysFindMany.mockResolvedValue([
      {
        id: 'k-secret',
        name: 'Server key',
        description: null,
        apiKeyPlaintext: FULL_SECRET,
        keyPrefix: SECRET_PREFIX,
        keyType: 'secret',
        status: 'active',
        permissions: [],
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
      {
        id: 'k-pub',
        name: 'Frontend key',
        description: null,
        apiKeyPlaintext: FULL_PUBLISHABLE,
        keyPrefix: 'mf_pk_live',
        keyType: 'publishable',
        status: 'active',
        permissions: [],
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
    ])
  })

  it('does NOT return the full secret plaintext, returns a <prefix>...<last4> mask instead', async () => {
    const res = await apiKeys.getApiKeys()
    expect(res.success).toBe(true)
    const secret = dataOf<Key[]>(res).find((k: Key) => k.id === 'k-secret')!

    // Load-bearing negative control: the returned value is NOT the live secret.
    expect(secret.apiKeyPlaintext).not.toBe(FULL_SECRET)
    // It is the documented mask shape: prefix + "..." + last 4 chars.
    expect(secret.apiKeyPlaintext).toBe(
      `${SECRET_PREFIX}...${FULL_SECRET.slice(-4)}`
    )
    expect(secret.apiKeyPlaintext).toContain('...')
    // The secret body never appears in the masked output.
    expect(secret.apiKeyPlaintext).not.toContain('SUPERSECRETbody')
  })

  it('returns PUBLISHABLE keys in full (frontend-safe, unchanged)', async () => {
    const res = await apiKeys.getApiKeys()
    const pub = dataOf<Key[]>(res).find((k: Key) => k.id === 'k-pub')!
    expect(pub.apiKeyPlaintext).toBe(FULL_PUBLISHABLE)
  })

  it('masks a secret to undefined when no plaintext is stored (already-rotated key)', async () => {
    apiKeysFindMany.mockResolvedValueOnce([
      {
        id: 'k-empty',
        name: 'Rotated',
        description: null,
        apiKeyPlaintext: null,
        keyPrefix: SECRET_PREFIX,
        keyType: 'secret',
        status: 'active',
        permissions: [],
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date(),
      },
    ])
    const res = await apiKeys.getApiKeys()
    expect(dataOf<Key[]>(res)[0].apiKeyPlaintext).toBeUndefined()
  })
})

describe('createApiKey — the full secret is STILL shown ONCE at creation', () => {
  it('returns a full secret (no mask marker) on mint, for an owner', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    apiKeysCreate.mockImplementation(async (args: any) => ({
      id: 'k-new',
      name: args.data.name,
      description: args.data.description,
      keyPrefix: args.data.keyPrefix,
      keyType: args.data.keyType,
      status: 'active',
      permissions: [],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    }))

    const res = await apiKeys.createApiKey({
      name: 'Mint me',
      keyType: 'secret',
    } as any)
    expect(res.success).toBe(true)
    const minted = dataOf<Key>(res).apiKeyPlaintext!
    // Show-once: a real, full secret (begins with the secret prefix, carries a long body,
    // and is NOT a `...` mask).
    expect(minted.startsWith('mf_sk_')).toBe(true)
    expect(minted).not.toContain('...')
    expect(minted.length).toBeGreaterThan(20)
    // The full secret is returned to the caller ONCE (asserted above)
    // but is NOT persisted — a secret key's apiKeyPlaintext column is written null, so
    // there is no plaintext-at-rest to leak or to drain later.
    expect(apiKeysCreate.mock.calls[0][0].data.apiKeyPlaintext).toBeNull()
  })
})
