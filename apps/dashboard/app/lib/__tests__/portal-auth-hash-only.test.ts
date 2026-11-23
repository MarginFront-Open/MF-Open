const sessionFindUnique = jest.fn()
const linkFindUnique = jest.fn()
const sessionDeleteMany = jest.fn()
const cookieGet = jest.fn()

jest.mock('@prisma/client', () => ({
  Prisma: {},
}))
jest.mock('@marginfront/db', () => ({
  db: {
    portal_sessions: {
      findUnique: (...a: unknown[]) => sessionFindUnique(...a),
      deleteMany: (...a: unknown[]) => sessionDeleteMany(...a),
    },
    portal_magic_links: {
      findUnique: (...a: unknown[]) => linkFindUnique(...a),
    },
  },
  hashApiKeyForLookup: (value: string) => `hash(${value})`,
}))
jest.mock('next/headers', () => ({
  cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }),
}))
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  cache: <T>(fn: T) => fn,
}))

import {
  deletePortalSession,
  getPortalSession,
  validatePortalSessionForSlug,
  verifyPortalMagicLink,
} from '../portal-auth'

/**
 * Tokens are stored as SHA-256 hashes so that reading the table does not hand
 * out working tokens. That only holds if nothing ever looks a token up by its
 * raw value: a raw lookup would match a stored hash presented as a token.
 */
describe('portal tokens are matched by hash only', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionFindUnique.mockResolvedValue(null)
    linkFindUnique.mockResolvedValue(null)
    sessionDeleteMany.mockResolvedValue({ count: 0 })
  })

  it('verifyPortalMagicLink rejects a stored hash presented as a token', async () => {
    const result = await verifyPortalMagicLink('stored-hash')
    expect(result).toEqual({ valid: false, error: 'invalid_token' })
    expect(linkFindUnique).toHaveBeenCalledTimes(1)
    expect(linkFindUnique.mock.calls[0][0].where).toEqual({
      token: 'hash(stored-hash)',
    })
  })

  it('getPortalSession rejects a stored hash presented as the cookie', async () => {
    cookieGet.mockReturnValue({ value: 'stored-hash' })
    expect(await getPortalSession()).toBeNull()
    expect(sessionFindUnique).toHaveBeenCalledTimes(1)
    expect(sessionFindUnique.mock.calls[0][0].where).toEqual({
      token: 'hash(stored-hash)',
    })
  })

  it('validatePortalSessionForSlug rejects a stored hash presented as the cookie', async () => {
    expect(await validatePortalSessionForSlug('stored-hash', 'acme')).toBeNull()
    expect(sessionFindUnique).toHaveBeenCalledTimes(1)
    expect(sessionFindUnique.mock.calls[0][0].where).toEqual({
      token: 'hash(stored-hash)',
    })
  })

  it('deletePortalSession cannot be used to delete a session by its stored hash', async () => {
    await deletePortalSession('stored-hash')
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { token: 'hash(stored-hash)' },
    })
  })
})
