import { DEFAULT_MONEY_TAB, MONEY_TABS, resolveMoneyTab } from '../money-tabs'

/**
 * The Money sub-tab registry. Pure logic,
 * real assertions (not source-scanning) since this module has no JSX.
 */
describe('MONEY_TABS registry', () => {
  it('ships exactly Breakdown, Users, Plans, Subscriptions, Invoices, Simulator, in that order', () => {
    expect(MONEY_TABS.map((tab) => tab.id)).toEqual([
      'breakdown',
      'users',
      'plans',
      'subscriptions',
      'invoices',
      'simulator',
    ])
  })

  it('defaults to the Breakdown tab', () => {
    expect(DEFAULT_MONEY_TAB).toBe('breakdown')
  })
})

// Spend controls live on their own page, /internal-ai-spend. A next.config.ts
// redirect owns /money?tab=spend-controls links (sent emails carry them
// forever), so the registry must never carry that id: it would shadow the
// redirect's destination with a tab that renders nothing.
describe('spend controls live at /internal-ai-spend', () => {
  it('carries no spend-controls tab', () => {
    expect(MONEY_TABS.map((t) => t.id)).not.toContain('spend-controls')
    expect(MONEY_TABS.map((t) => t.label)).not.toContain('Internal AI Spend')
  })

  it('falls back to the default for a stale ?tab=spend-controls that slips past the redirect', () => {
    expect(resolveMoneyTab('spend-controls')).toBe(DEFAULT_MONEY_TAB)
  })
})

describe('resolveMoneyTab', () => {
  it('resolves a known tab id verbatim', () => {
    expect(resolveMoneyTab('users')).toBe('users')
    expect(resolveMoneyTab('breakdown')).toBe('breakdown')
    expect(resolveMoneyTab('plans')).toBe('plans')
    expect(resolveMoneyTab('subscriptions')).toBe('subscriptions')
    expect(resolveMoneyTab('invoices')).toBe('invoices')
    expect(resolveMoneyTab('simulator')).toBe('simulator')
  })

  it('falls back to the default for a missing ?tab= param', () => {
    expect(resolveMoneyTab(null)).toBe(DEFAULT_MONEY_TAB)
  })

  it('falls back to the default for an unrecognized value (stale bookmark, typo, not-yet-shipped tab)', () => {
    expect(resolveMoneyTab('settings')).toBe(DEFAULT_MONEY_TAB)
    expect(resolveMoneyTab('bogus')).toBe(DEFAULT_MONEY_TAB)
    expect(resolveMoneyTab('')).toBe(DEFAULT_MONEY_TAB)
  })
})
