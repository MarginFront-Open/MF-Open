// Better Auth ships as ES modules that this Jest setup cannot load, so the
// test captures the options auth.ts hands to betterAuth(). Better Auth's
// /sign-up/email handler answers EMAIL_PASSWORD_SIGN_UP_DISABLED when
// emailAndPassword.disableSignUp is true.
jest.mock('better-auth', () => ({
  betterAuth: (options: unknown) => ({ options }),
}))
jest.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => ({}) }))
jest.mock('better-auth/next-js', () => ({ nextCookies: () => ({}) }))
jest.mock('better-auth/plugins', () => ({
  emailOTP: () => ({}),
  organization: () => ({}),
  magicLink: () => ({}),
}))
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
  APIError: class APIError extends Error {},
}))
jest.mock('../permissions', () => ({ ac: {}, roles: {} }))
jest.mock('@/app/lib/db', () => ({ db: {} }))
jest.mock('@marginfront/db', () => ({ hashApiKeyForLookup: jest.fn() }))

import { auth } from '../auth'

describe('password sign-up', () => {
  it('is turned off, so POST /api/auth/sign-up/email cannot create an account', () => {
    const { emailAndPassword } = (
      auth as unknown as {
        options: { emailAndPassword: { disableSignUp?: boolean } }
      }
    ).options

    expect(emailAndPassword.disableSignUp).toBe(true)
  })
})
