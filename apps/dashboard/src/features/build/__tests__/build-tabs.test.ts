import { BUILD_TABS, DEFAULT_BUILD_TAB, resolveBuildTab } from '../build-tabs'

/**
 * The Build sub-tab registry. Pure logic,
 * real assertions (not source-scanning) since this module has no JSX.
 * Modeled on money-tabs.test.ts.
 */
describe('BUILD_TABS registry', () => {
  it('ships exactly Agents, API keys, Simulator, in that order', () => {
    expect(BUILD_TABS.map((tab) => tab.id)).toEqual([
      'agents',
      'keys',
      'simulator',
    ])
    expect(BUILD_TABS.map((tab) => tab.label)).toEqual([
      'Agents',
      'API keys',
      'Simulator',
    ])
  })

  it('defaults to the Agents tab', () => {
    expect(DEFAULT_BUILD_TAB).toBe('agents')
  })
})

describe('resolveBuildTab', () => {
  it('resolves a known tab id verbatim', () => {
    expect(resolveBuildTab('agents')).toBe('agents')
    expect(resolveBuildTab('keys')).toBe('keys')
    expect(resolveBuildTab('simulator')).toBe('simulator')
  })

  it('falls back to the default for a missing ?tab= param', () => {
    expect(resolveBuildTab(null)).toBe(DEFAULT_BUILD_TAB)
  })

  it('falls back to the default for an unrecognized value (stale bookmark, typo, not-yet-shipped tab)', () => {
    expect(resolveBuildTab('settings')).toBe(DEFAULT_BUILD_TAB)
    expect(resolveBuildTab('bogus')).toBe(DEFAULT_BUILD_TAB)
    expect(resolveBuildTab('')).toBe(DEFAULT_BUILD_TAB)
  })
})
