const handlerGet = jest.fn()
const handlerPost = jest.fn()

jest.mock('@/app/lib/auth', () => ({ auth: {} }))
jest.mock('better-auth/next-js', () => ({
  toNextJsHandler: () => ({
    GET: (...args: unknown[]) => handlerGet(...args),
    POST: (...args: unknown[]) => handlerPost(...args),
  }),
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '../[...all]/route'

const SECRET_DETAIL = 'connect ECONNREFUSED db.internal:5432 password=hunter2'

function request(method: 'GET' | 'POST') {
  return new NextRequest('http://localhost:3000/api/auth/sign-in/email', {
    method,
  })
}

describe('/api/auth — an internal failure tells the caller nothing', () => {
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    ['GET', GET, handlerGet],
    ['POST', POST, handlerPost],
  ] as const)(
    '%s returns a fixed message and logs the detail server-side',
    async (method, route, handler) => {
      const failure = new Error(SECRET_DETAIL)
      handler.mockRejectedValue(failure)

      const res = await route(request(method))
      const text = await res.text()

      expect(res.status).toBe(500)
      expect(JSON.parse(text)).toEqual({
        error: 'Something went wrong while signing in. Please try again.',
      })
      expect(text).not.toContain('stack')
      expect(text).not.toContain(SECRET_DETAIL)
      expect(text).not.toContain(failure.stack as string)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[Auth Route] ${method} failed`),
        failure
      )
    }
  )

  it('passes a normal response straight through', async () => {
    const ok = new Response('{"ok":true}', { status: 200 })
    handlerPost.mockResolvedValue(ok)
    expect(await POST(request('POST'))).toBe(ok)
  })
})
