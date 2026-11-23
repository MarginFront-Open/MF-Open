import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /agents (the list) redirects to /build, so the two "Go to Agents" CTAs in
 * the Getting Started checklist ("Create an Agent" and "Set up a Pricing
 * Plan") link straight to /build and skip the extra redirect hop.
 * Source-assertion, not a render test (same constraint as the sibling
 * path-persistence test — this file's client-only hooks can't render in
 * Node-only jest).
 */
describe('Getting Started "Go to Agents" CTAs point at /build', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('never sends a CTA to the /agents list', () => {
    expect(src).not.toMatch(/window\.location\.href = '\/agents'/)
  })

  it('both "Go to Agents" CTAs point at /build', () => {
    const matches = [
      ...src.matchAll(/window\.location\.href = '(\/[a-z-]+)'/g),
    ].filter((m) => m[1] === '/build')
    expect(matches.length).toBe(2)
  })
})

describe('Getting Started revenue card with no docs site configured', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
  const card = src.slice(
    src.indexOf('const RevenueSetup = ()'),
    src.indexOf('</Card>', src.indexOf('const RevenueSetup = ()'))
  )

  it('never renders an empty body: without a docs link it points at Build', () => {
    expect(card).toContain('{DOCS.concepts ? (')
    expect(card).not.toMatch(/\) : null\}/)
    expect(card).toContain("href='/build'")
    expect(card).toContain('add a pricing plan')
  })
})
