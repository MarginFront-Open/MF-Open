const findFirst = jest.fn()

jest.mock('@marginfront/db', () => ({
  db: {
    ba_verification: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
  hashApiKeyForLookup: (value: string) => `hash(${value})`,
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function visit(token: string) {
  return GET(
    new NextRequest(
      `http://localhost:3000/api/invite-verify?token=${encodeURIComponent(token)}`
    )
  )
}

describe('GET /api/invite-verify — a stored hash is not a usable token', () => {
  beforeEach(() => {
    findFirst.mockReset()
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('looks the token up by its hash only, never by the raw value', async () => {
    findFirst.mockResolvedValue(null)

    const res = await visit('stolen-stored-hash')

    expect(findFirst).toHaveBeenCalledTimes(1)
    expect(findFirst.mock.calls[0][0].where.value).toBe(
      'hash(stolen-stored-hash)'
    )
    expect(res.headers.get('location')).toContain('error=invalid_token')
  })

  it('still routes a genuine token to the accept page', async () => {
    findFirst.mockResolvedValue({ identifier: 'invite-magic:inv_123' })
    const res = await visit('real-token')
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/invite/accept/inv_123'
    )
  })
})
