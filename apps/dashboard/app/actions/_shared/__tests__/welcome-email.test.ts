import { buildWelcomeEmailHtml } from '../welcome-email'

const VARS = [
  'BETTER_AUTH_URL',
  'NEXT_PUBLIC_BETTER_AUTH_URL',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_COMPANY_NAME',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const name of VARS) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe('welcome email', () => {
  it('points nowhere and offers no call when nothing is configured', () => {
    const html = buildWelcomeEmailHtml()
    expect(html).not.toContain('marginfront.com')
    expect(html).not.toMatch(/founders?/i)
    expect(html).not.toContain('All rights reserved')
    expect(html).not.toContain('Go to Your Dashboard')
    expect(html).not.toContain('©')
  })

  it("links to this copy's own address and signs with the operator name", () => {
    process.env.BETTER_AUTH_URL = 'https://billing.example.com/'
    process.env.NEXT_PUBLIC_COMPANY_NAME = 'Acme & Co'
    const html = buildWelcomeEmailHtml()
    expect(html).toContain('href="https://billing.example.com"')
    expect(html).toContain('Acme &amp; Co')
    expect(html).toMatch(/© \d{4} Acme &amp; Co/)
  })

  it('falls back to the public app address for the button', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
    expect(buildWelcomeEmailHtml()).toContain('href="https://app.example.com"')
  })

  it('omits the CTA button and never emits javascript: for unsafe BETTER_AUTH_URL', () => {
    process.env.BETTER_AUTH_URL = 'javascript:alert(1)'
    const html = buildWelcomeEmailHtml()
    expect(html).not.toContain('Go to Your Dashboard')
    expect(html).not.toContain('javascript:')
  })
})
