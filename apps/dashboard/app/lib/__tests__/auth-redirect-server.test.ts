const getSession = jest.fn()
const findMember = jest.fn()

jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('@marginfront/db', () => ({
  MANAGE_MONEY_ROLES: ['owner', 'admin', 'finance'],
}))
jest.mock('../auth', () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}))
jest.mock('../db', () => ({
  db: { ba_member: { findFirst: (...args: unknown[]) => findMember(...args) } },
}))
jest.mock('../pending-invite', () => ({
  resolvePostAuthDestination: jest.fn(),
}))

import { getPostAuthRedirectServer } from '../auth-redirect-server'

describe('getPostAuthRedirectServer — redirect target stays on this site', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    getSession.mockResolvedValue({
      session: { activeOrganizationId: 'org_1' },
      user: { id: 'user_1', email: 'someone@example.com' },
    })
    findMember.mockResolvedValue({ role: 'owner' })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    'https://evil.example/login',
    '//evil.example/login',
    '/\\evil.example',
  ])('falls back to the role landing for the off-site target %s', async (target) => {
    await expect(getPostAuthRedirectServer(target)).resolves.toEqual({
      url: '/money',
      reason: 'has-organization',
    })
  })

  it('still honours a same-site path', async () => {
    await expect(getPostAuthRedirectServer('/customers')).resolves.toEqual({
      url: '/customers',
      reason: 'has-organization',
    })
  })
})
