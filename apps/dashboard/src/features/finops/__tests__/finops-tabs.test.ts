import {
  FINOPS_TABS,
  DEFAULT_FINOPS_TAB,
  resolveFinopsTab,
} from '../finops-tabs'

/**
 * The FinOps sub-tab registry. Pure logic,
 * real assertions (not source-scanning) since this module has no JSX.
 * Modeled on build-tabs.test.ts / money-tabs.test.ts.
 */
describe('FINOPS_TABS registry', () => {
  it('ships exactly Close, Cost management, Settings, in that order', () => {
    expect(FINOPS_TABS.map((tab) => tab.id)).toEqual([
      'close',
      'cost-management',
      'settings',
    ])
    expect(FINOPS_TABS.map((tab) => tab.label)).toEqual([
      'Close',
      'Cost management',
      'Settings',
    ])
  })

  it('defaults to the Close tab', () => {
    expect(DEFAULT_FINOPS_TAB).toBe('close')
  })

  it('tab labels carry no em dash (rendered copy rule)', () => {
    for (const tab of FINOPS_TABS) {
      expect(tab.label).not.toMatch(/—/)
    }
  })
})

describe('resolveFinopsTab', () => {
  it('resolves a known tab id verbatim', () => {
    expect(resolveFinopsTab('close')).toBe('close')
    expect(resolveFinopsTab('cost-management')).toBe('cost-management')
    expect(resolveFinopsTab('settings')).toBe('settings')
  })

  it('falls back to the default for a missing ?tab= param', () => {
    expect(resolveFinopsTab(null)).toBe(DEFAULT_FINOPS_TAB)
  })

  it('falls back to the default for an unrecognized value (stale bookmark, typo, unknown tab)', () => {
    expect(resolveFinopsTab('finops-settings')).toBe(DEFAULT_FINOPS_TAB)
    expect(resolveFinopsTab('bogus')).toBe(DEFAULT_FINOPS_TAB)
    expect(resolveFinopsTab('')).toBe(DEFAULT_FINOPS_TAB)
  })
})
