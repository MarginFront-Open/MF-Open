import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /agents (the list) redirects to /build,
 * so this page's own "Agents" breadcrumb crumb (loading skeleton, not-found,
 * and real render) must point straight at /build rather than bounce through
 * the redirect.
 */
describe('Pricing Plan detail page "Agents" crumb points at /build', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('never links the Agents crumb to the /agents list', () => {
    expect(src).not.toMatch(/name:\s*'Agents',\s*href:\s*'\/agents'/)
  })

  it('all three Agents crumb instances point at /build', () => {
    const matches = [
      ...src.matchAll(/\{\s*name:\s*'Agents',\s*href:\s*'([^']+)'\s*\}/g),
    ]
    expect(matches.length).toBe(3)
    for (const match of matches) {
      expect(match[1]).toBe('/build')
    }
  })
})
