/**
 * The dashboard's key-pair mint must build its secret row from the shared
 * helper in @marginfront/db, so every minted key has the same shape. This pins it.
 */

import { createHash } from 'crypto'

const ORG = 'org-pair-shape'
const USER = 'user-pair-shape'

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: ORG },
        user: { id: USER },
      }),
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const baMemberFindFirst = jest.fn()
const apiKeysCreate = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    api_keys: { create: (a: unknown) => apiKeysCreate(a) },
  },
}))

type ApiKeys = typeof import('../api-keys')
let apiKeys: ApiKeys

beforeAll(async () => {
  apiKeys = await import('../api-keys')
})

beforeEach(() => {
  baMemberFindFirst.mockReset()
  apiKeysCreate.mockReset()
  apiKeysCreate.mockImplementation(async (args: any) => ({
    ...args.data,
    lastUsedAt: null,
  }))
})

it('writes the secret half of a key pair exactly as secretPairKeyCreateData builds it', async () => {
  const { secretPairKeyCreateData } = jest.requireActual('@marginfront/db')
  baMemberFindFirst.mockResolvedValue({ role: 'developer' })

  const res = await apiKeys.createApiKeyPair({
    name: '  Meter  ',
    role: 'ingest',
  })
  if (!res.success) throw new Error(res.error)

  const written = apiKeysCreate.mock.calls[0][0].data
  const plaintext = res.data.secretKey.apiKeyPlaintext
  expect(written).toEqual(
    secretPairKeyCreateData({
      id: written.id,
      now: written.createdAt,
      name: '  Meter  ',
      organizationId: ORG,
      role: 'ingest',
      minterUserId: USER,
      minterRole: 'developer',
      key: {
        plaintext,
        hash: createHash('sha256').update(plaintext).digest('hex'),
        prefix: 'mf_sk_',
      },
    })
  )
  expect(written.permissions).toEqual({
    role: 'ingest',
    minterUserId: USER,
    minterRole: 'developer',
  })
})
