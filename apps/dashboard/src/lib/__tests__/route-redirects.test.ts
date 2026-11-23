import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Top-level path aliases that redirect to / (/home, /overview,
 * /revenue-dashboard, /dashboard, /users, /analytics). Source-asserted against next.config.ts
 * because `next build` doesn't print the resolved redirects list; this test
 * is the pin.
 */
describe('top-level route aliases (next.config.ts)', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', 'next.config.ts'),
    'utf8'
  )

  const redirectedRoutes = [
    '/home',
    '/overview',
    '/revenue-dashboard',
    '/dashboard',
    '/users',
    '/analytics',
  ]

  it('defines an async redirects() function', () => {
    expect(src).toMatch(/async redirects\(\)/)
  })

  it.each(redirectedRoutes)(
    'redirects %s to / as a temporary (non-permanent) redirect',
    (route) => {
      const entryPattern = new RegExp(
        `source:\\s*['"]${route.replace('/', '\\/')}['"][^}]*destination:\\s*['"]\\/['"][^}]*permanent:\\s*false`
      )
      expect(src).toMatch(entryPattern)
    }
  )
})

/**
 * /money?tab=spend-controls redirects to the standalone /internal-ai-spend
 * page. Cap-alert emails link to the /money URL, so the redirect must stay. The critical safety property: the
 * entry must carry a `has` query matcher, because a bare source: '/money'
 * would hijack the ENTIRE money page. Next.js only fires a has-matcher entry
 * when the query matches, so plain /money and every other ?tab= pass through.
 */
describe('spend-controls redirect (next.config.ts)', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', 'next.config.ts'),
    'utf8'
  )

  const entryStart = src.indexOf("source: '/money'")
  const entryEnd = src.indexOf('}', src.indexOf('permanent', entryStart))
  const entry = src.slice(entryStart, entryEnd)

  it('redirects /money?tab=spend-controls to /internal-ai-spend, temporary (307)', () => {
    expect(entryStart).toBeGreaterThan(-1)
    expect(entry).toContain("destination: '/internal-ai-spend'")
    expect(entry).toContain('permanent: false')
  })

  it('cannot shadow plain /money: the entry is gated on a has-query matcher', () => {
    expect(entry).toContain(
      "has: [{ type: 'query', key: 'tab', value: 'spend-controls' }]"
    )
    // The has: line sits between source and destination, i.e. inside THIS
    // entry — not somewhere else in the file.
    expect(entry.indexOf('has:')).toBeGreaterThan(-1)
    expect(entry.indexOf('has:')).toBeLessThan(entry.indexOf('destination:'))
  })

  it("defines exactly one '/money' source (no second, ungated entry)", () => {
    expect(src.split("source: '/money'").length - 1).toBe(1)
  })
})
