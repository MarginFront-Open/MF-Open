/**
 * GettingStartedNudge source-asserted (dashboard jest
 * is node-only, no RTL). Pins the contract a later refactor could silently
 * break: fetches the zero-events signal exactly once, stays quiet on
 * null/error/true, only shows for a real `false`, and links out to the
 * actual Getting Started page.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(
  join(__dirname, '..', 'components', 'getting-started-nudge.tsx'),
  'utf8'
)

describe('GettingStartedNudge — single-fetch, fail-quiet posture', () => {
  it('imports getHasIngestedFirstEvent from its action, and calls it exactly once', () => {
    expect(src).toMatch(
      /import\s*\{\s*getHasIngestedFirstEvent\s*\}\s*from\s*'@\/app\/actions\/getting-started-status'/
    )
    expect(src.match(/getHasIngestedFirstEvent\(\)/g)).toHaveLength(1)
  })

  it('a failed or ambiguous check renders nothing — never coalesced to a shown/hidden guess', () => {
    expect(src).toMatch(
      /result\.success \? \(result\.hasEvents \?\? null\) : null/
    )
  })

  it('renders null unless hasEvents is the real boolean false', () => {
    expect(src).toMatch(/if \(hasEvents !== false \|\| dismissed\) return null/)
  })

  it('guards the mount fetch against a cancelled unmount', () => {
    expect(src).toMatch(/let cancelled = false/)
    expect(src).toMatch(/cancelled = true/)
  })
})

describe('GettingStartedNudge — the affordance itself', () => {
  it('links to the real Getting Started page', () => {
    expect(src).toMatch(/href='\/developer-zone\/getting-started'/)
  })

  it('offers a local dismiss that needs no server round-trip (no new write action)', () => {
    expect(src).toMatch(/onClick=\{\(\) => setDismissed\(true\)\}/)
    expect(src).not.toMatch(/dismissGettingStarted|persistDismiss/)
  })

  it('never imports a second action module — the ONE zero-events read is the only data path', () => {
    const actionImports = [
      ...new Set(
        [...src.matchAll(/from '@\/app\/actions\/([^']+)'/g)].map((m) => m[1])
      ),
    ]
    expect(actionImports).toEqual(['getting-started-status'])
  })
})
