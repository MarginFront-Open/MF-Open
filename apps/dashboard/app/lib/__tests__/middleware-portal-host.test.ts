import { NextRequest } from 'next/server'
import { middleware } from '../../../middleware'

const REAL_ENV = process.env

function visit(host: string, path: string) {
  return middleware(
    new NextRequest(`http://${host}${path}`, { headers: { host } })
  )
}

describe('middleware — customer portal host', () => {
  beforeEach(() => {
    process.env = { ...REAL_ENV }
    delete process.env.PORTAL_BASE_URL
    delete process.env.PORTAL_FALLBACK_URL
  })

  afterEach(() => {
    process.env = REAL_ENV
  })

  it('treats the host of PORTAL_BASE_URL as the portal', () => {
    process.env.PORTAL_BASE_URL = 'https://billing.operator.example'
    const res = visit('billing.operator.example', '/acme/login')
    expect(res.headers.get('x-middleware-rewrite')).toContain(
      '/portal/acme/login'
    )
  })

  it('does not treat that host as the portal when PORTAL_BASE_URL is unset', () => {
    const res = visit('billing.operator.example', '/acme/login')
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('still treats portal.<any-domain> as the portal with no configuration', () => {
    const res = visit('portal.localhost:3000', '/acme/login')
    expect(res.headers.get('x-middleware-rewrite')).toContain(
      '/portal/acme/login'
    )
  })

  it.each(['/', '/admin', '/portal'])(
    'answers %s on the portal host with a 404, not a redirect to somebody else',
    (path) => {
      const res = visit('portal.operator.example', path)
      expect(res.status).toBe(404)
      expect(res.headers.get('location')).toBeNull()
    }
  )

  it('sends the bare portal root to PORTAL_FALLBACK_URL when the operator sets one', () => {
    process.env.PORTAL_FALLBACK_URL = 'https://www.operator.example/'
    const res = visit('portal.operator.example', '/')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://www.operator.example/')
  })

  it('ignores a PORTAL_FALLBACK_URL that is not an http(s) address', () => {
    process.env.PORTAL_FALLBACK_URL = 'javascript:alert(1)'
    expect(visit('portal.operator.example', '/').status).toBe(404)
  })
})
