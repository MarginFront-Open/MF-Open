const getSession = jest.fn()

jest.mock('../auth-client', () => ({
  authClient: { getSession: (...args: unknown[]) => getSession(...args) },
}))

import { getPostAuthRedirect, getPostAuthRedirectSync } from '../auth-redirect'

const WITH_ORG = { session: { activeOrganizationId: 'org_1' } }
const NO_ORG = { session: {} }

const OFF_SITE_TARGETS = [
  'https://evil.example/login',
  '//evil.example/login',
  '/\\evil.example',
  'https://evil.example/invite/accept/abc',
  '//evil.example/invite/accept/abc',
]

describe('post-login redirect only ever stays on this site', () => {
  beforeEach(() => {
    getSession.mockReset()
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('getPostAuthRedirectSync', () => {
    it.each(OFF_SITE_TARGETS)('ignores the off-site target %s', (target) => {
      expect(getPostAuthRedirectSync(WITH_ORG, target)).toEqual({
        url: '/',
        reason: 'has-organization',
      })
    })

    it('does not let an off-site "invite" link skip onboarding for an org-less user', () => {
      expect(
        getPostAuthRedirectSync(
          NO_ORG,
          'https://evil.example/invite/accept/abc'
        )
      ).toEqual({ url: '/quick-onboarding', reason: 'no-organization' })
    })

    it('still honours a same-site path', () => {
      expect(getPostAuthRedirectSync(WITH_ORG, '/customers')).toEqual({
        url: '/customers',
        reason: 'has-organization',
      })
    })

    it('still honours a same-site invite link for an org-less user', () => {
      expect(getPostAuthRedirectSync(NO_ORG, '/invite/accept/abc')).toEqual({
        url: '/invite/accept/abc',
        reason: 'has-organization',
      })
    })
  })

  describe('getPostAuthRedirect', () => {
    it.each(OFF_SITE_TARGETS)(
      'ignores the off-site target %s',
      async (target) => {
        getSession.mockResolvedValue({ data: WITH_ORG })
        await expect(getPostAuthRedirect(target)).resolves.toEqual({
          url: '/',
          reason: 'has-organization',
        })
      }
    )

    it('still honours a same-site path', async () => {
      getSession.mockResolvedValue({ data: WITH_ORG })
      await expect(getPostAuthRedirect('/invoices?x=1')).resolves.toEqual({
        url: '/invoices?x=1',
        reason: 'has-organization',
      })
    })

    it('still honours a same-site invite link', async () => {
      getSession.mockResolvedValue({ data: NO_ORG })
      await expect(getPostAuthRedirect('/invite/accept/abc')).resolves.toEqual(
        { url: '/invite/accept/abc', reason: 'has-organization' }
      )
    })
  })
})
