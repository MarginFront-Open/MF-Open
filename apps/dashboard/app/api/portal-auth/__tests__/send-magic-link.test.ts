const getOrganizationBySlug = jest.fn()
const findCustomerByEmail = jest.fn()
const createPortalMagicLink = jest.fn()
const consumePortalThrottle = jest.fn()
const resendSend = jest.fn()
let afterTasks: Array<() => Promise<unknown>> = []

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: (task: () => Promise<unknown>) => {
    afterTasks.push(task)
  },
}))

// Runs the work the route deferred until after its response was sent.
async function runDeferredWork() {
  const tasks = afterTasks
  afterTasks = []
  await Promise.all(tasks.map((task) => task()))
}
jest.mock('@/app/lib/portal-auth', () => ({
  getOrganizationBySlug: (...a: unknown[]) => getOrganizationBySlug(...a),
  findCustomerByEmail: (...a: unknown[]) => findCustomerByEmail(...a),
  createPortalMagicLink: (...a: unknown[]) => createPortalMagicLink(...a),
  consumePortalThrottle: (...a: unknown[]) => consumePortalThrottle(...a),
}))
jest.mock('resend', () => ({
  Resend: class {
    emails = { send: (...a: unknown[]) => resendSend(...a) }
  },
}))

import { NextRequest } from 'next/server'
import { POST } from '../send-magic-link/route'
import { renderMagicLinkEmail } from '../send-magic-link/email'

const REAL_ENV = process.env

function post(body: unknown, ip = '203.0.113.9') {
  return new NextRequest('http://localhost/api/portal-auth/send-magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

async function send(body: unknown, ip?: string) {
  const res = await POST(post(body, ip))
  const result = { status: res.status, body: await res.text() }
  await runDeferredWork()
  return result
}

const ORG = { id: 'org_1', name: 'Acme', logo: null }
const CUSTOMER = { id: 'cus_1', name: 'Pat', email: 'pat@customer.example' }

describe('POST /api/portal-auth/send-magic-link', () => {
  beforeEach(() => {
    afterTasks = []
    jest.clearAllMocks()
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
    process.env = {
      ...REAL_ENV,
      RESEND_API_KEY: 'test-key',
      RESEND_FROM_EMAIL: 'noreply@operator.example',
      PORTAL_BASE_URL: 'https://portal.operator.example',
    }
    consumePortalThrottle.mockResolvedValue(true)
    getOrganizationBySlug.mockResolvedValue(ORG)
    findCustomerByEmail.mockResolvedValue(CUSTOMER)
    createPortalMagicLink.mockResolvedValue('mgl_token')
    resendSend.mockResolvedValue({ data: { id: 'email_1' } })
  })

  afterEach(() => {
    process.env = REAL_ENV
    jest.restoreAllMocks()
  })

  describe('does not reveal which organizations or customers exist', () => {
    it('answers an unknown organization exactly like a known one', async () => {
      const known = await send({ email: 'pat@customer.example', slug: 'acme' })

      getOrganizationBySlug.mockResolvedValue(null)
      const unknownOrg = await send({
        email: 'pat@customer.example',
        slug: 'no-such-org',
      })

      getOrganizationBySlug.mockResolvedValue(ORG)
      findCustomerByEmail.mockResolvedValue(null)
      const unknownCustomer = await send({
        email: 'nobody@customer.example',
        slug: 'acme',
      })

      expect(known).toEqual({ status: 200, body: '{"success":true}' })
      expect(unknownOrg).toEqual(known)
      expect(unknownCustomer).toEqual(known)
    })

    it('responds before any organization or customer lookup has run', async () => {
      const res = await POST(post({ email: 'pat@customer.example', slug: 'acme' }))
      expect(res.status).toBe(200)
      expect(getOrganizationBySlug).not.toHaveBeenCalled()
      expect(findCustomerByEmail).not.toHaveBeenCalled()
      await runDeferredWork()
      expect(getOrganizationBySlug).toHaveBeenCalledWith('acme')
    })

    it('sends nothing and creates no token for an unknown organization', async () => {
      getOrganizationBySlug.mockResolvedValue(null)
      await send({ email: 'pat@customer.example', slug: 'no-such-org' })
      expect(createPortalMagicLink).not.toHaveBeenCalled()
      expect(resendSend).not.toHaveBeenCalled()
    })

    it('still emails a real customer their link', async () => {
      await send({ email: ' Pat@Customer.Example ', slug: 'acme' })
      expect(findCustomerByEmail).toHaveBeenCalledWith(
        'pat@customer.example',
        'org_1'
      )
      expect(resendSend).toHaveBeenCalledTimes(1)
      const sent = resendSend.mock.calls[0][0]
      expect(sent.to).toBe('pat@customer.example')
      expect(sent.html).toContain(
        'https://portal.operator.example/r/mgl_token'
      )
    })

    it('never writes the customer email address to the log', async () => {
      const logSpy = console.log as unknown as jest.SpyInstance
      await send({ email: 'pat@customer.example', slug: 'acme' })
      findCustomerByEmail.mockResolvedValue(null)
      await send({ email: 'nobody@customer.example', slug: 'acme' })
      const logged = logSpy.mock.calls.flat().join(' ')
      expect(logged).not.toContain('customer.example')
    })
  })

  describe('send limit', () => {
    it('counts the caller IP (10 a minute) and the target address (5 an hour) before any lookup', async () => {
      await send({ email: 'Pat@Customer.Example', slug: 'acme' }, '198.51.100.7')

      expect(consumePortalThrottle).toHaveBeenCalledTimes(2)
      const [ipCall, emailCall] = consumePortalThrottle.mock.calls
      expect(ipCall).toEqual([
        'portal-magic-link:ip:198.51.100.7',
        { max: 10, windowMs: 60_000 },
      ])
      expect(emailCall[0]).toMatch(/^portal-magic-link:email:[0-9a-f]{64}$/)
      expect(emailCall[0]).not.toContain('pat')
      expect(emailCall[1]).toEqual({ max: 5, windowMs: 3_600_000 })
    })

    it('uses one email bucket however the address is capitalised or which org is named', async () => {
      await send({ email: 'Pat@Customer.Example', slug: 'acme' })
      await send({ email: 'pat@customer.example ', slug: 'other-org' })
      expect(consumePortalThrottle.mock.calls[1][0]).toBe(
        consumePortalThrottle.mock.calls[3][0]
      )
    })

    it.each([
      ['the IP limit', [false]],
      ['the per-address limit', [true, false]],
    ])('turns the request away with 429 at %s and sends nothing', async (_l, answers) => {
      consumePortalThrottle.mockReset()
      for (const answer of answers) {
        consumePortalThrottle.mockResolvedValueOnce(answer)
      }

      const res = await send({ email: 'pat@customer.example', slug: 'acme' })

      expect(res.status).toBe(429)
      expect(JSON.parse(res.body).error).toContain('Too many sign-in links')
      expect(getOrganizationBySlug).not.toHaveBeenCalled()
      expect(createPortalMagicLink).not.toHaveBeenCalled()
      expect(resendSend).not.toHaveBeenCalled()
    })

    it('gives the same 429 for an unknown organization', async () => {
      consumePortalThrottle.mockResolvedValue(false)
      const known = await send({ email: 'pat@customer.example', slug: 'acme' })
      getOrganizationBySlug.mockResolvedValue(null)
      const unknown = await send({ email: 'pat@customer.example', slug: 'nope' })
      expect(unknown).toEqual(known)
    })

    it('fails closed (500, nothing sent) when the limiter itself errors', async () => {
      consumePortalThrottle.mockRejectedValue(new Error('db down'))
      const res = await send({ email: 'pat@customer.example', slug: 'acme' })
      expect(res.status).toBe(500)
      expect(resendSend).not.toHaveBeenCalled()
    })
  })

  describe('input checks', () => {
    it.each([
      [{ slug: 'acme' }, 'Email is required'],
      [{ email: 'pat@customer.example' }, 'Slug is required'],
      [{ email: 5, slug: 'acme' }, 'Email is required'],
    ])('rejects %j', async (body, error) => {
      const res = await send(body)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error })
      expect(consumePortalThrottle).not.toHaveBeenCalled()
    })
  })
})

describe('portal sign-in email', () => {
  const HOSTILE = `<script>alert("x")</script><img src=x onerror='y'>`

  it('escapes the organization name everywhere it appears', () => {
    const html = renderMagicLinkEmail({
      customerName: 'Pat',
      organizationName: HOSTILE,
      organizationLogo: null,
      magicLinkUrl: 'https://portal.operator.example/r/mgl_token',
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('escapes the customer name', () => {
    const html = renderMagicLinkEmail({
      customerName: HOSTILE,
      organizationName: 'Acme',
      organizationLogo: null,
      magicLinkUrl: 'https://portal.operator.example/r/mgl_token',
    })
    expect(html).not.toContain('<script>')
  })

  it('cannot be broken out of through the logo address or its alt text', () => {
    const html = renderMagicLinkEmail({
      customerName: 'Pat',
      organizationName: `Acme" onload="alert(1)`,
      organizationLogo: `https://cdn.example/logo.png" onerror="alert(1)`,
      magicLinkUrl: 'https://portal.operator.example/r/mgl_token',
    })
    expect(html).not.toMatch(/" on(load|error)="/)
  })

  it('drops a logo that is not an http(s) address', () => {
    const html = renderMagicLinkEmail({
      customerName: 'Pat',
      organizationName: 'Acme',
      organizationLogo: 'javascript:alert(1)',
      magicLinkUrl: 'https://portal.operator.example/r/mgl_token',
    })
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
  })

  it('links nowhere except the sign-in link', () => {
    const html = renderMagicLinkEmail({
      customerName: 'Pat',
      organizationName: 'Acme',
      organizationLogo: null,
      magicLinkUrl: 'https://portal.operator.example/r/mgl_token',
    })
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(['https://portal.operator.example/r/mgl_token'])
  })

  describe('operator copyright footer', () => {
    const originalCompanyName = process.env.NEXT_PUBLIC_COMPANY_NAME

    afterEach(() => {
      if (originalCompanyName === undefined) {
        delete process.env.NEXT_PUBLIC_COMPANY_NAME
      } else {
        process.env.NEXT_PUBLIC_COMPANY_NAME = originalCompanyName
      }
    })

    it('omits MarginFront and copyright notice when NEXT_PUBLIC_COMPANY_NAME is unset', () => {
      delete process.env.NEXT_PUBLIC_COMPANY_NAME
      const html = renderMagicLinkEmail({
        customerName: 'Pat',
        organizationName: 'Acme',
        organizationLogo: null,
        magicLinkUrl: 'https://portal.operator.example/r/mgl_token',
      })
      expect(html).not.toContain('MarginFront')
      expect(html).not.toContain('©')
    })

    it('renders escaped operator copyright when NEXT_PUBLIC_COMPANY_NAME is set', () => {
      process.env.NEXT_PUBLIC_COMPANY_NAME = 'Acme & <Co>'
      const html = renderMagicLinkEmail({
        customerName: 'Pat',
        organizationName: 'Acme',
        organizationLogo: null,
        magicLinkUrl: 'https://portal.operator.example/r/mgl_token',
      })
      expect(html).not.toContain('MarginFront')
      expect(html).toMatch(/© \d{4} Acme &amp; &lt;Co&gt;/)
    })
  })
})
