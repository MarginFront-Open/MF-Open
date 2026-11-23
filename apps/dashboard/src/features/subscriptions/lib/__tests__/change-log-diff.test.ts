import {
  deriveChangeLogFieldDiffs,
  formatChangeLogValue,
} from '../change-log-diff'

describe('deriveChangeLogFieldDiffs', () => {
  it('cancelSubscription shape: a clean 1-key pair diffs to exactly that field', () => {
    const diffs = deriveChangeLogFieldDiffs(
      { status: 'active' },
      { status: 'canceled' }
    )
    expect(diffs).toEqual([
      { field: 'status', oldValue: 'active', newValue: 'canceled' },
    ])
  })

  it('updateSubscription shape: only the tracked fields that actually changed render — an untouched tracked field is dropped', () => {
    const diffs = deriveChangeLogFieldDiffs(
      {
        planId: 'plan-1',
        agentId: 'agent-1',
        status: 'active',
        billingCycle: 'monthly',
      },
      {
        // The full edit payload — planId/status/billingCycle unchanged,
        // agentId changed, plus fields never tracked in previousValues.
        planId: 'plan-1',
        agentId: 'agent-2',
        status: 'active',
        billingCycle: 'monthly',
        name: 'Renamed sub',
        netTerms: 30,
      }
    )
    expect(diffs).toEqual([
      { field: 'agentId', oldValue: 'agent-1', newValue: 'agent-2' },
    ])
  })

  it('a field tracked in previousValues but absent from newValues renders old -> null, never crashes', () => {
    const diffs = deriveChangeLogFieldDiffs({ status: 'active' }, {})
    expect(diffs).toEqual([
      { field: 'status', oldValue: 'active', newValue: null },
    ])
  })

  it('returns [] when previousValues is null (no tracked fields to diff)', () => {
    expect(deriveChangeLogFieldDiffs(null, { status: 'canceled' })).toEqual([])
  })

  it('returns [] when every tracked field is unchanged', () => {
    expect(
      deriveChangeLogFieldDiffs({ status: 'active' }, { status: 'active' })
    ).toEqual([])
  })
})

describe('formatChangeLogValue', () => {
  it('renders null/undefined as the em-dash placeholder', () => {
    expect(formatChangeLogValue(null)).toBe('—')
    expect(formatChangeLogValue(undefined)).toBe('—')
  })

  it('renders strings and numbers as-is', () => {
    expect(formatChangeLogValue('canceled')).toBe('canceled')
    expect(formatChangeLogValue(30)).toBe('30')
  })

  it('renders booleans as literal words', () => {
    expect(formatChangeLogValue(true)).toBe('true')
    expect(formatChangeLogValue(false)).toBe('false')
  })

  it('renders an object as JSON rather than "[object Object]"', () => {
    expect(formatChangeLogValue({ a: 1 })).toBe('{"a":1}')
  })
})
