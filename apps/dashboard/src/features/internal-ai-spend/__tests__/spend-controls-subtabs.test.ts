import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Source-assertion coverage for the
 * Internal AI Spend page's 3-way sub-tab switcher and the "Seen coding"
 * roster chips. Dashboard jest is node-only (no RTL), so we pin the wiring
 * against the component source the same way spend-controls-analytics.test.ts
 * does, rather than mounting it:
 *   1. the sub-tab list is exactly Internal Setup / AI spend / Caps,
 *      in that order (setup leads: it's the landing view for a fresh org),
 *   2. the default view is data-driven: coding-agent activity lands on
 *      'spend', zero activity lands on 'setup' (the smart default),
 *   3. each sub-tab body is gated so only the selected one renders,
 *   4. the roster chips have an honest empty state and a populated state.
 */
const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

describe('internal-ai-spend/index.tsx — sub-tab switcher', () => {
  it('defines exactly three sub-tabs with these ids and labels, Internal Setup first', () => {
    expect(src).toMatch(/const SUB_TABS: ReadonlyArray<[^>]+> = \[/)
    expect(src).toContain("{ id: 'setup', label: 'Internal Setup' }")
    expect(src).toContain("{ id: 'spend', label: 'AI spend' }")
    expect(src).toContain("{ id: 'caps', label: 'Caps' }")
    expect(src).toMatch(/type SubTab = 'setup' \| 'spend' \| 'caps'/)
    const setupAt = src.indexOf("{ id: 'setup',")
    const spendAt = src.indexOf("{ id: 'spend',")
    const capsAt = src.indexOf("{ id: 'caps',")
    expect(setupAt).toBeGreaterThan(-1)
    expect(spendAt).toBeGreaterThan(setupAt)
    expect(capsAt).toBeGreaterThan(spendAt)
  })

  it("has no 'team' / 'Teammates & kit' sub-tab", () => {
    expect(src).not.toContain("id: 'team'")
    expect(src).not.toContain('Teammates & kit')
  })

  it('defaults smartly: coding-agent activity lands on spend, a fresh org on setup', () => {
    // No hardcoded landing view: state starts null and the render derives it.
    expect(src).toMatch(/useState<SubTab \| null>\(null\)/)
    expect(src).toMatch(
      /const activeSubTab = subTab \?\? \(anyToolActivity \? 'spend' : 'setup'\)/
    )
  })

  it('renders the switcher by mapping SUB_TABS to buttons that set the sub-tab', () => {
    expect(src).toMatch(/SUB_TABS\.map\(\(tab\) =>/)
    expect(src).toMatch(/onClick=\{\(\) => setSubTab\(tab\.id\)\}/)
  })

  it('gates each sub-tab body so only the selected one renders (mutually exclusive)', () => {
    // Each branch is `activeSubTab === '<id>' ? <body> : null` — never two at once.
    expect(src).toMatch(
      /activeSubTab === 'spend' \? <RepoSpendSection[\s\S]*?: null/
    )
    expect(src).toMatch(/activeSubTab === 'caps' \? \([\s\S]*?\) : null/)
    expect(src).toMatch(/activeSubTab === 'setup' \? \([\s\S]*?\) : null/)
    expect(src).toContain("activeSubTab === 'spend'")
    expect(src).toContain("activeSubTab === 'caps'")
    expect(src).toContain("activeSubTab === 'setup'")
  })
})

describe('internal-ai-spend/index.tsx — the Internal Setup pointer trio', () => {
  // Everything below must sit inside the setup branch, ABOVE the coverage
  // section (the trio is the first thing a fresh org reads).
  const setupBranchAt = src.indexOf("activeSubTab === 'setup'")
  const coverageAt = src.indexOf('toolCoverageLine', setupBranchAt)

  it('opens with the install-first intro and the three pointers, above the coverage section', () => {
    expect(setupBranchAt).toBeGreaterThan(-1)
    const trioAt = src.indexOf('Start here: install the meter', setupBranchAt)
    expect(trioAt).toBeGreaterThan(setupBranchAt)
    expect(trioAt).toBeLessThan(coverageAt)
  })

  it('shows the docs and Windows guide only when the operator has a docs site', () => {
    expect(src).toContain('{CCC_DOCS_URL ? (')
    expect(src).toContain('{CCC_WINDOWS_DOCS_URL ? (')
    expect(src).toContain('The same command works in PowerShell')
    expect(src).not.toContain('docs.marginfront.com')
  })

  it('points at the meter source, never a package registry', () => {
    expect(src).toContain('{sourceUrl ? (')
    expect(src).toContain('href={sourceUrl}')
    expect(src).toContain('packages/code-cost-clarity')
    expect(src).not.toContain('npmjs.com')
  })

  it('points onward to the guided walkthrough as an in-app Link', () => {
    expect(src).toMatch(
      /<Link\s+href='\/developer-zone\/getting-started\?method=ccc'/
    )
  })

  it('external pointers open safely in a new tab', () => {
    // Every <a> inside the trio carries the no-tab-nabbing rel.
    const trio = src.slice(
      src.indexOf('Start here: install the meter'),
      src.indexOf('</section>', src.indexOf('Start here: install the meter'))
    )
    const anchors = trio.match(/<a\s/g) ?? []
    const rels = trio.match(/rel='noopener noreferrer'/g) ?? []
    expect(anchors.length).toBeGreaterThan(0)
    expect(rels.length).toBe(anchors.length)
  })
})

describe('internal-ai-spend/index.tsx — Seen coding roster chips', () => {
  // Scope every assertion to the roster block so the CapCreateForm teammate
  // select (which also maps rosterEmails) can't satisfy these by accident.
  const rosterStart = src.indexOf('Seen coding')
  const rosterBlock = src.slice(rosterStart, rosterStart + 700)

  it('has a "Seen coding" roster block inside the Internal Setup sub-tab', () => {
    expect(rosterStart).toBeGreaterThan(-1)
    const setupBranchAt = src.indexOf("activeSubTab === 'setup'")
    expect(setupBranchAt).toBeGreaterThan(-1)
    expect(rosterStart).toBeGreaterThan(setupBranchAt)
  })

  it('shows an honest empty state when no one has been seen coding', () => {
    expect(rosterBlock).toMatch(/data\.prefill\.rosterEmails\.length === 0/)
    expect(rosterBlock).toContain('No one seen coding yet.')
  })

  it('renders one keyed chip per seen email when the roster is populated', () => {
    expect(rosterBlock).toMatch(
      /data\.prefill\.rosterEmails\.map\(\(email\) =>/
    )
    expect(rosterBlock).toMatch(/key=\{email\}/)
    expect(rosterBlock).toMatch(/\{email\}/)
  })
})
