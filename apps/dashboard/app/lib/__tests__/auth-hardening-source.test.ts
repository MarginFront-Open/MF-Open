import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'

/**
 * Source-level guards for sign-in defaults that must never appear: a login
 * code written in the source, a bot check that switches itself off in
 * development mode, hard-coded hosted addresses, and token lookups by the raw
 * value.
 */
const DASHBOARD = join(__dirname, '..', '..', '..')

function read(...parts: string[]): string {
  return readFileSync(join(DASHBOARD, ...parts), 'utf8')
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const OWNED_FILES = [
  ...sourceFiles(join(DASHBOARD, 'app', 'lib')),
  ...sourceFiles(join(DASHBOARD, 'app', 'api')),
  ...sourceFiles(join(DASHBOARD, 'app', '(auth)')),
  ...sourceFiles(join(DASHBOARD, 'src', 'features', 'auth')),
  join(DASHBOARD, 'middleware.ts'),
  join(DASHBOARD, 'instrumentation.ts'),
  join(DASHBOARD, 'sentry.client.config.ts'),
  join(DASHBOARD, 'sentry.server.config.ts'),
  join(DASHBOARD, 'sentry.edge.config.ts'),
  join(DASHBOARD, 'src', 'config', 'sentry.ts'),
]

describe('app/lib/auth.ts — no built-in login shortcuts', () => {
  const auth = read('app', 'lib', 'auth.ts')

  it('never supplies its own one-time code', () => {
    expect(auth).not.toContain('generateOTP')
    expect(auth).not.toMatch(/['"`]\d{6}['"`]/)
  })

  it('does not change sign-in behaviour based on NODE_ENV=development', () => {
    expect(auth).not.toMatch(/NODE_ENV\s*===?\s*['"]development['"]/)
  })

  it('allows the same number of code attempts everywhere', () => {
    expect(auth).toContain('allowedAttempts: 3,')
  })

  it('only skips an email through the guarded local-development switch', () => {
    expect(auth).not.toMatch(/process\.env\.SKIP_(OTP|MAGIC_LINK)_EMAIL/)
    expect(auth).toContain("isLocalDevShortcutActive('SKIP_OTP_EMAIL'")
    expect(auth).toContain("'SKIP_MAGIC_LINK_EMAIL'")
  })

  it('runs the bot check whenever a Turnstile secret is set', () => {
    expect(auth).toContain('if (!isTurnstileEnabled()) {')
  })

  it('uses copyrightFooterHtml() in all 3 email templates with no hardcoded MarginFront copyright', () => {
    expect(auth.match(/\$\{copyrightFooterHtml\(\)\}/g)).toHaveLength(3)
    expect(auth).not.toContain('All rights reserved')
    expect(auth).not.toMatch(/© .*MarginFront/)
  })
})

describe('sign-in code — no hard-coded hosted address', () => {
  it('scans a real set of files (guards against a silently-empty suite)', () => {
    expect(OWNED_FILES.length).toBeGreaterThan(30)
  })

  it.each([
    ['marginfront.com', /marginfront\.com/i],
    ['a vercel.app host', /vercel\.app/i],
  ])('names %s nowhere', (_label, pattern) => {
    const hits = OWNED_FILES.filter((file) =>
      pattern.test(readFileSync(file, 'utf8'))
    ).map((file) => relative(DASHBOARD, file))
    expect(hits).toEqual([])
  })
})

describe('app — no URL is built from the Host header', () => {
  it('never reads the host header', () => {
    const files = sourceFiles(join(DASHBOARD, 'app')).filter(
      (f) => !f.endsWith(join('lib', 'local-dev-shortcuts.ts'))
    )
    const hits = files
      .filter((file) =>
        /headers\(?\)?\.get\(\s*['"]host['"]\s*\)/i.test(
          readFileSync(file, 'utf8')
        )
      )
      .map((file) => relative(DASHBOARD, file))
    expect(hits).toEqual([])
  })
})

describe('no anonymous endpoint says whether an organization slug is taken', () => {
  it('has no slug-check route', () => {
    expect(
      existsSync(
        join(DASHBOARD, 'app', 'api', 'organizations', 'slug', 'check', 'route.ts')
      )
    ).toBe(false)
  })
})

describe('the sign-in route never returns error internals', () => {
  it('does not put a stack or raw error message in a response', () => {
    const route = read('app', 'api', 'auth', '[...all]', 'route.ts')
    expect(route).not.toMatch(/error\.stack/)
    expect(route).not.toMatch(/error\.message/)
    expect(route).not.toMatch(/process\.env/)
  })
})
