/**
 * WHAT THIS FILE GUARDS: a credit pool can name OTHER metrics
 * and how many credits each of their units burns (creditRates). The rules are
 * enforced server-side; this pins the client half:
 *
 *  1. validatePricingForm rejects a rate that isn't above zero, and rejects a
 *     member metric that also has its own pricing switched on (the customer
 *     would pay twice for one unit of work) — before the round-trip.
 *  2. formatForApi sends creditRates on the pool payload, sends `{}` to CLEAR
 *     when the pool is switched off, and omits the field entirely on a pool
 *     that never had rates so its NULL column stays NULL.
 *  3. creditRatesFingerprint makes a rates-only edit count as a change, and a
 *     reordered/emptied map NOT count.
 *  4. The member table is wired: pool card owns the rates, pool size relabels
 *     to credits, the mid-period caution rides active subscriptions.
 *
 * Behavioral where the code is a plain closure (useToast is mocked, so the
 * hook has no React state in node jest); source assertions for the UI wiring,
 * same idiom as credit-pool-single-pool-ux.test.ts, because this jest slice is
 * node-only (no RTL).
 */

import { readFileSync } from 'fs'
import path from 'path'

const mockToast = jest.fn()
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

import { usePricingValidation } from '../hooks/usePricingValidation'
import { creditRatesFingerprint } from '../credit-rates'

const enabledPricingOptions = [
  {
    id: 'activity',
    name: 'Usage-Based',
    enabled: true,
    type: 'VARIABLE' as const,
    billingCycle: 'RECURRING' as const,
  },
]

// 5,000 credits for $99, then $0.03 per credit.
const poolTiers = [
  { lower: 0, upper: 5000, rate: 99 },
  { lower: 5000, upper: null, rate: 0.03 },
]

const makePool = (
  id: string,
  name: string,
  creditRates?: Record<string, number>
) => ({
  signalId: id,
  signal: { id, name },
  enabled: true,
  pricingType: 'CREDIT_POOL' as const,
  price: 0,
  billingFrequency: 'monthly' as const,
  tiers: poolTiers,
  creditRates,
})

const makeSignal = (id: string, name: string, enabled: boolean) => ({
  signalId: id,
  signal: { id, name },
  enabled,
  pricingType: 'FLAT' as const,
  price: 5,
  billingFrequency: 'monthly' as const,
  tiers: [{ lower: 0, upper: null, rate: 5 }],
})

// useToast is mocked above, so the "hook" is a plain closure with no React
// state — safe to call outside a component in this node-only suite.
// eslint-disable-next-line react-hooks/rules-of-hooks -- the mocked hook is a plain closure
const { validatePricingForm } = usePricingValidation()

beforeEach(() => {
  mockToast.mockClear()
})

describe('validatePricingForm — burn rates must be above zero', () => {
  it('passes a pool with no rates at all', () => {
    expect(
      validatePricingForm('plan-1', enabledPricingOptions, [
        makePool('s1', 'Reports'),
      ])
    ).toBe(true)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('passes a pool whose members all burn a positive rate', () => {
    expect(
      validatePricingForm('plan-1', enabledPricingOptions, [
        makePool('s1', 'Reports', { s1: 4, s2: 0.5 }),
        makeSignal('s2', 'Notes', false),
      ])
    ).toBe(true)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('blocks a zero rate and names the metric, not the signal id', () => {
    const ok = validatePricingForm('plan-1', enabledPricingOptions, [
      makePool('s1', 'Reports', { s2: 0 }),
      makeSignal('s2', 'Notes', false),
    ])
    expect(ok).toBe(false)
    const { variant, description } = mockToast.mock.calls[0][0]
    expect(variant).toBe('destructive')
    expect(description).toContain('Notes')
    expect(description).toContain('greater than zero')
    // "Free" has a spelling, and it isn't 0 — same rule as the server's.
    expect(description).toContain('remove it from the pool')
  })

  it('blocks a negative rate', () => {
    expect(
      validatePricingForm('plan-1', enabledPricingOptions, [
        makePool('s1', 'Reports', { s2: -2 }),
        makeSignal('s2', 'Notes', false),
      ])
    ).toBe(false)
    expect(mockToast).toHaveBeenCalledTimes(1)
  })

  it("blocks the pool's OWN signal at a bad rate too", () => {
    expect(
      validatePricingForm('plan-1', enabledPricingOptions, [
        makePool('s1', 'Reports', { s1: 0 }),
      ])
    ).toBe(false)
    expect(mockToast.mock.calls[0][0].description).toContain('Reports')
  })

  it("never tells the pool's own metric to leave its own pool", () => {
    // Row 1 has no remove button and a pool metric always burns its own pool,
    // so "remove it from the pool" would name an escape that doesn't exist.
    validatePricingForm('plan-1', enabledPricingOptions, [
      makePool('s1', 'Reports', { s1: 0 }),
    ])
    const ownMetric = mockToast.mock.calls[0][0].description
    expect(ownMetric).not.toContain('remove it from the pool')
    expect(ownMetric).toContain('give it a rate greater than zero')

    // A real member keeps the removal escape, which for it IS true.
    mockToast.mockClear()
    validatePricingForm('plan-1', enabledPricingOptions, [
      makePool('s1', 'Reports', { s2: 0 }),
      makeSignal('s2', 'Notes', false),
    ])
    expect(mockToast.mock.calls[0][0].description).toContain(
      'remove it from the pool'
    )
  })

  it('falls back to the raw id when the member signal is not on this form', () => {
    const ok = validatePricingForm('plan-1', enabledPricingOptions, [
      makePool('s1', 'Reports', { 'signal-from-another-agent': 0 }),
    ])
    expect(ok).toBe(false)
    expect(mockToast.mock.calls[0][0].description).toContain(
      'signal-from-another-agent'
    )
  })
})

describe('validatePricingForm — a member metric cannot also bill on its own', () => {
  it('blocks a member whose own pricing is switched on, naming both', () => {
    const ok = validatePricingForm('plan-1', enabledPricingOptions, [
      makePool('s1', 'Reports', { s2: 2 }),
      makeSignal('s2', 'Notes', true),
    ])
    expect(ok).toBe(false)
    const { variant, description } = mockToast.mock.calls[0][0]
    expect(variant).toBe('destructive')
    expect(description).toContain('Notes')
    expect(description).toContain('Reports')
    expect(description).toContain('pay twice')
  })

  it('allows the same member once its own pricing is switched off', () => {
    expect(
      validatePricingForm('plan-1', enabledPricingOptions, [
        makePool('s1', 'Reports', { s2: 2 }),
        makeSignal('s2', 'Notes', false),
      ])
    ).toBe(true)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it("never counts the pool's own signal as its own rival", () => {
    // The pool row IS enabled — reading it as a double-priced member would
    // make every rated pool unsavable.
    expect(
      validatePricingForm('plan-1', enabledPricingOptions, [
        makePool('s1', 'Reports', { s1: 4 }),
      ])
    ).toBe(true)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('ignores rates on a row that is not a credit pool', () => {
    // Switching off the pool model leaves `{}` in state; nothing to validate.
    const switchedOff = {
      ...makeSignal('s1', 'Reports', true),
      creditRates: {},
    }
    expect(
      validatePricingForm('plan-1', enabledPricingOptions, [
        switchedOff,
        makeSignal('s2', 'Notes', true),
      ])
    ).toBe(true)
  })
})

describe('creditRatesFingerprint — what counts as a rates change', () => {
  it('treats null, undefined, and {} as the same absent map', () => {
    expect(creditRatesFingerprint(null)).toBe('')
    expect(creditRatesFingerprint(undefined)).toBe('')
    expect(creditRatesFingerprint({})).toBe('')
  })

  it('ignores key order so re-adding a member is not a phantom edit', () => {
    expect(creditRatesFingerprint({ a: 4, b: 2 })).toBe(
      creditRatesFingerprint({ b: 2, a: 4 })
    )
  })

  it('sees a changed rate, an added member, and a removed member', () => {
    expect(creditRatesFingerprint({ a: 4 })).not.toBe(
      creditRatesFingerprint({ a: 2 })
    )
    expect(creditRatesFingerprint({ a: 4 })).not.toBe(
      creditRatesFingerprint({ a: 4, b: 1 })
    )
    expect(creditRatesFingerprint({ a: 4, b: 1 })).not.toBe(
      creditRatesFingerprint({ a: 4 })
    )
  })

  it('is not fooled into calling a real clear a no-op', () => {
    expect(creditRatesFingerprint({ a: 4 })).not.toBe(
      creditRatesFingerprint({})
    )
  })
})

const operationsSource = readFileSync(
  path.join(__dirname, '../hooks/usePricingOperations.ts'),
  'utf-8'
)
const poolInputsSource = readFileSync(
  path.join(__dirname, '../components/CreditPoolInputs.tsx'),
  'utf-8'
)
const itemSource = readFileSync(
  path.join(__dirname, '../components/SignalPricingItem.tsx'),
  'utf-8'
)
const indexSource = readFileSync(path.join(__dirname, '../index.tsx'), 'utf-8')
const stateSource = readFileSync(
  path.join(__dirname, '../hooks/usePricingState.ts'),
  'utf-8'
)

describe('formatForApi — creditRates rides the strategy payload', () => {
  it('sends the map when state holds one and omits it when state holds none', () => {
    const index = operationsSource.indexOf('if (pricing.creditRates !== undef')
    expect(index).toBeGreaterThan(-1)
    const body = operationsSource.slice(index, index + 200)
    expect(body).toMatch(/strategy\.creditRates = pricing\.creditRates/)
  })

  it('loads a stored NULL as undefined, not {}, so the column stays NULL', () => {
    const index = stateSource.indexOf(
      'creditRates: existingStrategy.creditRates'
    )
    expect(index).toBeGreaterThan(-1)
    const body = stateSource.slice(index - 60, index + 160)
    expect(body).toMatch(/: undefined/)
  })

  it('clears the map when a pool row switches to another pricing model', () => {
    const index = operationsSource.indexOf('const updateSignalPricingType')
    expect(index).toBeGreaterThan(-1)
    const body = operationsSource.slice(index, index + 1200)
    expect(body).toMatch(
      /type !== 'CREDIT_POOL' && row\.pricingType === 'CREDIT_POOL'/
    )
    expect(body).toMatch(/creditRates: \{\}/)
  })

  it('counts a rates-only edit as a change so the save actually sends it', () => {
    const index = operationsSource.indexOf('const simpleFieldsChanged')
    expect(index).toBeGreaterThan(-1)
    const body = operationsSource.slice(index, index + 600)
    expect(body).toMatch(
      /creditRatesFingerprint\(originalStrategy\.creditRates\)/
    )
    expect(body).toMatch(
      /creditRatesFingerprint\(currentStrategy\.creditRates\)/
    )
  })

  it('adds a member at rate 1 and removes by deleting the key', () => {
    expect(operationsSource).toMatch(/\[memberSignalId\]: 1/)
    expect(operationsSource).toMatch(/delete rates\[memberSignalId\]/)
  })
})

describe('CreditPoolInputs — the member table lives on the pool card', () => {
  it('always shows the pool signal as row one, with no remove button', () => {
    const index = poolInputsSource.indexOf('<MemberRateRow')
    expect(index).toBeGreaterThan(-1)
    const firstRow = poolInputsSource.slice(index, index + 320)
    expect(firstRow).toMatch(/name=\{poolSignalName\}/)
    // An absent key means rate 1 (memberRate), so the row shows 1 by default.
    expect(firstRow).toMatch(/rates\[poolSignalId\] \?\? 1/)
    expect(firstRow).not.toMatch(/onRemove=/)
  })

  it('lists every creditRates key except the pool signal itself', () => {
    expect(poolInputsSource).toMatch(
      /Object\.keys\(rates\)\.filter\(\(id\) => id !== poolSignalId\)/
    )
  })

  it('offers only metrics that are not already members', () => {
    expect(poolInputsSource).toMatch(/!\(option\.id in rates\)/)
  })

  it('renders an ineligible metric disabled with its reason, never hidden', () => {
    expect(poolInputsSource).toMatch(/disabled=\{!!option\.disabledReason\}/)
    expect(poolInputsSource).toMatch(/\{option\.disabledReason \?/)
  })

  it('relabels pool size and overage in credits once any RATE is in play', () => {
    // Not `hasMembers`: a single-metric pool whose own rate is 4 is denominated
    // in credits too (1,000 there buys 250 reports), and row 1's rate box is
    // editable, so that state is one keystroke away. Labelling it "units" would
    // have an operator size the pool wrong by a factor of the rate.
    expect(poolInputsSource).toMatch(
      /const hasRates =\s*hasMembers \|\| \(rates\[poolSignalId\] \?\? 1\) !== 1/
    )
    expect(poolInputsSource).toMatch(
      /const poolUnitLabel = hasRates \? 'credits' : lowerUnitLabel/
    )
    expect(poolInputsSource).toMatch(/const overageUnitLabel = hasRates/)
    expect(poolInputsSource).toMatch(
      /Pool size \(\{poolUnitLabel\} per cycle\)/
    )
    expect(poolInputsSource).toMatch(
      /Overage rate \(per \{overageUnitLabel\}\)/
    )
  })

  it('reuses the local-string-state pattern for each rate input', () => {
    const index = poolInputsSource.indexOf('function MemberRateRow')
    expect(index).toBeGreaterThan(-1)
    const body = poolInputsSource.slice(index)
    expect(body).toMatch(/useState\(rate > 0 \? String\(rate\) : ''\)/)
    expect(body).toMatch(/step='any'/)
    // An emptied box commits 0 so validation can name it, rather than silently
    // holding the last good number.
    expect(body).toMatch(/onRateChange\(0\)/)
  })

  it('shows the mid-period caution only when the plan has subscriptions', () => {
    expect(poolInputsSource).toMatch(/\{showMidPeriodCaution && \(/)
    expect(poolInputsSource).toMatch(/has active subscriptions/)
    expect(indexSource).toMatch(
      /pricingPlan\?\.activeSubscriptionCount \?\? 0\) > 0/
    )
  })
})

describe('Configure Pricing — membership is wired to the plan, not the row', () => {
  it('builds the candidate list from every OTHER signal on the plan', () => {
    const index = indexSource.indexOf('const memberOptionsFor')
    expect(index).toBeGreaterThan(-1)
    const body = indexSource.slice(index, index + 600)
    expect(body).toMatch(/sp\.signalId === poolSignalId \|\| !sp\.signal/)
    expect(body).toMatch(/disabledReason: sp\.enabled/)
  })

  it('threads the rates and the three handlers down to the pool card', () => {
    expect(itemSource).toMatch(/creditRates=\{creditRates\}/)
    expect(itemSource).toMatch(/memberOptions=\{memberOptions\}/)
    expect(itemSource).toMatch(/onCreditRateChange=\{onCreditRateChange\}/)
    expect(itemSource).toMatch(/onAddPoolMember=\{onAddPoolMember\}/)
    expect(itemSource).toMatch(/onRemovePoolMember=\{onRemovePoolMember\}/)
    expect(itemSource).toMatch(/poolSignalId=\{signal\.id\}/)
  })

  it('wires both signal sections, not only the first', () => {
    const occurrences = indexSource.split('onAddPoolMember=').length - 1
    expect(occurrences).toBe(2)
  })
})
