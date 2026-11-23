import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /agents (the list) redirects to /build,
 * so this page's own "Agents" breadcrumb crumb (used in both the loading
 * skeleton and the real render) must point straight at /build rather than
 * bounce through the redirect.
 */
describe('New Pricing Plan page "Agents" crumb points at /build', () => {
  const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

  it('never links the Agents crumb to the /agents list', () => {
    expect(src).not.toMatch(/name:\s*'Agents',\s*href:\s*'\/agents'/)
  })

  it('both Agents crumb instances point at /build', () => {
    const matches = [
      ...src.matchAll(/\{\s*name:\s*'Agents',\s*href:\s*'([^']+)'\s*\}/g),
    ]
    expect(matches.length).toBe(2)
    for (const match of matches) {
      expect(match[1]).toBe('/build')
    }
  })
})
