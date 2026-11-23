import {
  copyrightFooterHtml,
  escapeHtml,
  safeHttpUrlForHtml,
  supportNoteHtml,
} from '../email-html'

describe('escapeHtml', () => {
  it('neutralises markup and attribute breakouts', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;'
    )
  })

  it('returns an empty string for missing values', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})

describe('safeHttpUrlForHtml', () => {
  it('keeps an https URL and escapes it for an attribute', () => {
    expect(safeHttpUrlForHtml('https://cdn.example.com/logo.png?a=1&b=2')).toBe(
      'https://cdn.example.com/logo.png?a=1&amp;b=2'
    )
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'not a url',
    '',
  ])('drops %s', (value) => {
    expect(safeHttpUrlForHtml(value)).toBeNull()
  })

  it('cannot break out of a quoted attribute', () => {
    const out = safeHttpUrlForHtml('https://x.example/"><script>alert(1)</script>')
    expect(out).not.toContain('"')
    expect(out).not.toContain('<')
  })
})

describe('supportNoteHtml', () => {
  const REAL_ENV = process.env

  afterEach(() => {
    process.env = REAL_ENV
  })

  it('names no support address when the operator has not set one', () => {
    process.env = { ...REAL_ENV, NEXT_PUBLIC_SUPPORT_EMAIL: '' }
    const note = supportNoteHtml()
    expect(note).toBe('This email is not monitored for replies.')
  })

  it("uses the operator's own support address when set", () => {
    process.env = {
      ...REAL_ENV,
      NEXT_PUBLIC_SUPPORT_EMAIL: 'help@operator.example',
    }
    expect(supportNoteHtml()).toContain('mailto:help@operator.example')
  })

  it('ignores a value that is not an email address', () => {
    process.env = {
      ...REAL_ENV,
      NEXT_PUBLIC_SUPPORT_EMAIL: '"><script>alert(1)</script>',
    }
    expect(supportNoteHtml()).toBe('This email is not monitored for replies.')
  })
})

describe('copyrightFooterHtml', () => {
  const REAL = process.env

  afterEach(() => {
    process.env = REAL
  })

  it('renders nothing when no operator name is set', () => {
    process.env = { ...REAL, NEXT_PUBLIC_COMPANY_NAME: '' }
    expect(copyrightFooterHtml()).toBe('')
  })

  it("shows the operator's name, escaped, and never MarginFront's", () => {
    process.env = { ...REAL, NEXT_PUBLIC_COMPANY_NAME: 'Acme <Co>' }
    const html = copyrightFooterHtml()
    expect(html).toContain('Acme &lt;Co&gt;')
    expect(html).not.toContain('MarginFront')
  })
})
