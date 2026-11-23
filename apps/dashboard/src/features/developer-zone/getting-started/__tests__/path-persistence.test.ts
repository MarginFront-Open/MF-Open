/**
 * Getting Started saved-path persistence + tab precedence.
 *
 * Mirrors the decision logic inside GettingStartedPage at:
 *   apps/dashboard/src/features/developer-zone/getting-started/index.tsx
 *
 * This directory's jest config runs in a NODE environment and only matches
 * *.test.ts — React components and client-only hooks (useSearchParams,
 * useAuth, localStorage) are NOT rendered here; those stay on Playwright E2E
 * (see apps/dashboard/jest.config.ts). So, exactly like
 * setup-method-confirm.test.ts, we mirror the inline call-site decisions as
 * pure functions and assert their branches. If the page's branching changes,
 * update the mirrored functions below so these boundary cases stay anchored.
 *
 * The three invariants this guards:
 *   1. Precedence is URL param → saved path → 'manual'. A ?method= deep link
 *      (the SetupMethodModal contract) always beats the saved path, and the
 *      no-signal default is 'manual' (the zero-prerequisite end of the
 *      spectrum).
 *   2. 'examples' is reference material: it is a valid deep-link target but
 *      is NEVER written to storage and NEVER restored as a saved path.
 *   3. The restore step never clobbers a tab the user already clicked while
 *      the session was still hydrating (orgId arrives async).
 */

// Mirror of TAB_CONFIG ids + EXAMPLES_TAB.id in index.tsx. Order matters for
// nothing here — membership does. If a tab id is ever added or renamed (it
// shouldn't be — they're the ?method= contract), update both places.
const PATH_IDS = ['manual', 'mcp', 'sdk', 'api', 'ccc']
const VALID_METHODS = [...PATH_IDS, 'examples']

// Mirror of the initialTab expression: validated ?method= param or the
// 'manual' fallback.
const resolveInitialTab = (methodParam: string | null): string =>
  methodParam && VALID_METHODS.includes(methodParam) ? methodParam : 'manual'

// Mirror of the restore effect's decision: given the URL param, the org id,
// what the user may have already clicked (tabOverride), and what storage
// holds, what does tabOverride become?
const decideRestoredOverride = (
  methodParam: string | null,
  orgId: string | null,
  currentOverride: string | null,
  savedValue: string | null
): string | null => {
  if (methodParam || !orgId) return currentOverride
  if (currentOverride) return currentOverride
  return savedValue && PATH_IDS.includes(savedValue)
    ? savedValue
    : currentOverride
}

// Mirror of handleTabChange's persistence gate: which selections get written
// to storage?
const shouldPersistSelection = (value: string): boolean =>
  PATH_IDS.includes(value)

describe('Getting Started initial tab (index.tsx initialTab)', () => {
  it('valid ?method= deep links win for all six tab ids (the SetupMethodModal contract)', () => {
    for (const method of ['manual', 'mcp', 'sdk', 'api', 'ccc', 'examples']) {
      expect(resolveInitialTab(method)).toBe(method)
    }
  })

  it('no param falls back to manual, the zero-prerequisite end of the spectrum', () => {
    expect(resolveInitialTab(null)).toBe('manual')
  })

  it('an unknown ?method= value falls back to manual instead of rendering an empty tab', () => {
    expect(resolveInitialTab('garbage')).toBe('manual')
  })
})

describe('Getting Started saved-path restore (index.tsx restore effect)', () => {
  it('restores the saved path when there is no URL param and no user click yet', () => {
    expect(decideRestoredOverride(null, 'org_1', null, 'sdk')).toBe('sdk')
  })

  it('URL param beats the saved path — a deep link must land on its tab', () => {
    expect(decideRestoredOverride('api', 'org_1', null, 'sdk')).toBeNull()
  })

  it('a tab the user already clicked while the session was hydrating is never clobbered', () => {
    expect(decideRestoredOverride(null, 'org_1', 'api', 'sdk')).toBe('api')
  })

  it('no orgId (session not loaded / no active org) restores nothing', () => {
    expect(decideRestoredOverride(null, null, null, 'sdk')).toBeNull()
  })

  it("'examples' in storage is never restored as a path — it's reference material", () => {
    expect(decideRestoredOverride(null, 'org_1', null, 'examples')).toBeNull()
  })

  it('garbage in storage (stale or hand-edited key) restores nothing', () => {
    expect(
      decideRestoredOverride(null, 'org_1', null, 'walkthrough')
    ).toBeNull()
  })
})

describe('Getting Started saved-path write (index.tsx handleTabChange)', () => {
  it('all five real paths persist', () => {
    for (const path of PATH_IDS) {
      expect(shouldPersistSelection(path)).toBe(true)
    }
  })

  it("'examples' never persists — visiting reference material must not overwrite the saved path", () => {
    expect(shouldPersistSelection('examples')).toBe(false)
  })
})
