import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /agents (the list) redirects to /build, so AgentTabs' "AI Agents"
 * breadcrumb must point straight at /build. Otherwise every agent
 * detail/signals/pricing-plans/revenue-simulator page sends the user through
 * an extra redirect hop. Source-assertion, not a render test —
 * AgentTabs depends on client-only hooks (useAgent/useAuth/useParams) this
 * repo's Node-only jest can't render.
 */
describe('AgentTabs "AI Agents" crumb points at /build, not the /agents list', () => {
  const src = readFileSync(join(__dirname, '..', 'AgentTabs.tsx'), 'utf8')

  it('never links the AI Agents crumb to the /agents list', () => {
    expect(src).not.toMatch(/name:\s*'AI Agents',\s*href:\s*'\/agents'/)
  })

  it('both AI Agents crumb instances (getBreadcrumb + loading skeleton) point at /build', () => {
    const matches = [
      ...src.matchAll(/\{\s*name:\s*'AI Agents',\s*href:\s*'([^']+)'\s*\}/g),
    ]
    expect(matches.length).toBe(2)
    for (const match of matches) {
      expect(match[1]).toBe('/build')
    }
  })
})
