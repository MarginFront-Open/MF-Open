/**
 * WHAT THIS FILE GUARDS: the one-active-credit-pool-per-plan
 * rule is enforced server-side (validateSinglePoolPerPlan). The UI must stop
 * a second pool before the save, and must show the server's actionable
 * message instead of a generic "Failed to save pricing plan". These tests
 * pin the client mirror:
 *
 *  1. validatePricingForm blocks a second pool BEFORE the round-trip,
 *     preserves the server's grandfather clause (an existing two-pool plan
 *     stays savable), and catches pools hidden from this form.
 *  2. The save's catch block surfaces the server's actual error message.
 *  3. The CREDIT_POOL radio disables with a screen-reader-reachable reason.
 *
 * The validation tests are behavioral (useToast is mocked, so the hook is a
 * plain closure in node jest). The UI wiring is pinned with source
 * assertions — same idiom as strategy-deactivation-warning.test.ts, because
 * this jest slice is node-only (no RTL).
 */

import { readFileSync } from 'fs'
import path from 'path'

const mockToast = jest.fn()
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

import { usePricingValidation } from '../hooks/usePricingValidation'

const enabledPricingOptions = [
  {
    id: 'activity',
    name: 'Usage-Based',
    enabled: true,
    type: 'VARIABLE' as const,
    billingCycle: 'RECURRING' as const,
  },
]

// Valid pool + overage tier pair: 5,000 units for $99, then $0.03/unit.
const poolTiers = [
  { lower: 0, upper: 5000, rate: 99 },
  { lower: 5000, upper: null, rate: 0.03 },
]

const makePool = (id: string, name: string, enabled = true) => ({
  signalId: id,
  signal: { id, name },
  enabled,
  pricingType: 'CREDIT_POOL' as const,
  price: 0,
  billingFrequency: 'monthly' as const,
  tiers: poolTiers,
})

const makeFlat = (id: string, name: string) => ({
  signalId: id,
  signal: { id, name },
  enabled: true,
  pricingType: 'FLAT' as const,
  price: 5,
  billingFrequency: 'monthly' as const,
  tiers: [{ lower: 0, upper: null, rate: 5 }],
})

// useToast is mocked above, so the "hook" is a plain closure with no React
// state — safe to call outside a component in this node-only suite.
// eslint-disable-next-line react-hooks/rules-of-hooks -- the mocked hook is a plain closure
const { validatePricingForm } = usePricingValidation()
const validate = () => validatePricingForm

beforeEach(() => {
  mockToast.mockClear()
})

describe('validatePricingForm — one active credit pool per plan', () => {
  it('passes with no pools and with a single pool', () => {
    expect(
      validate()('plan-1', enabledPricingOptions, [
        makeFlat('s1', 'API Calls'),
        makeFlat('s2', 'Storage'),
      ])
    ).toBe(true)
    expect(
      validate()('plan-1', enabledPricingOptions, [
        makePool('s1', 'API Calls'),
        makeFlat('s2', 'Storage'),
      ])
    ).toBe(true)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('blocks a second pool on a fresh plan and names both signals', () => {
    const ok = validate()(
      'plan-1',
      enabledPricingOptions,
      [makePool('s1', 'API Calls'), makePool('s2', 'Storage')],
      0,
      null
    )
    expect(ok).toBe(false)
    expect(mockToast).toHaveBeenCalledTimes(1)
    const { variant, description } = mockToast.mock.calls[0][0]
    expect(variant).toBe('destructive')
    expect(description).toContain('API Calls')
    expect(description).toContain('Storage')
    expect(description).toContain('Keep one')
  })

  it('accepts a plan that already holds two pools', () => {
    const ok = validate()(
      'plan-1',
      enabledPricingOptions,
      [makePool('s1', 'API Calls'), makePool('s2', 'Storage')],
      2,
      null
    )
    expect(ok).toBe(true)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('still blocks a grandfathered plan from adding a THIRD pool', () => {
    const ok = validate()(
      'plan-1',
      enabledPricingOptions,
      [
        makePool('s1', 'API Calls'),
        makePool('s2', 'Storage'),
        makePool('s3', 'Tokens'),
      ],
      2,
      null
    )
    expect(ok).toBe(false)
  })

  it('allows swapping which signal holds the pool in one save', () => {
    // Saved pool on s1 was switched to FLAT in the form; s2 takes the pool.
    // Server sees before=1, after=1 and allows it — so must we.
    const ok = validate()(
      'plan-1',
      enabledPricingOptions,
      [makeFlat('s1', 'API Calls'), makePool('s2', 'Storage')],
      1,
      null
    )
    expect(ok).toBe(true)
  })

  it('blocks a visible pool when a pool hidden from this form holds it', () => {
    const ok = validate()(
      'plan-1',
      enabledPricingOptions,
      [makePool('s1', 'API Calls')],
      1,
      'Legacy Ingest'
    )
    expect(ok).toBe(false)
    const { description } = mockToast.mock.calls[0][0]
    expect(description).toContain('Legacy Ingest')
  })

  it('a hidden pool alone does not block pool-free saves', () => {
    const ok = validate()(
      'plan-1',
      enabledPricingOptions,
      [makeFlat('s1', 'API Calls')],
      1,
      'Legacy Ingest'
    )
    expect(ok).toBe(true)
  })

  it('accepts the 3-argument call shape', () => {
    expect(
      validate()('plan-1', enabledPricingOptions, [makePool('s1', 'API Calls')])
    ).toBe(true)
    expect(
      validate()('plan-1', enabledPricingOptions, [
        makePool('s1', 'API Calls'),
        makePool('s2', 'Storage'),
      ])
    ).toBe(false)
  })
})

const operationsSource = readFileSync(
  path.join(__dirname, '../hooks/usePricingOperations.ts'),
  'utf-8'
)
const selectorSource = readFileSync(
  path.join(__dirname, '../components/PricingTypeSelector.tsx'),
  'utf-8'
)
const itemSource = readFileSync(
  path.join(__dirname, '../components/SignalPricingItem.tsx'),
  'utf-8'
)
const indexSource = readFileSync(path.join(__dirname, '../index.tsx'), 'utf-8')

describe('savePricingPlan — server rejections surface their real message', () => {
  it('toasts error.message instead of a hard-coded generic', () => {
    const catchIndex = operationsSource.indexOf(
      "console.error('Error saving pricing plan:'"
    )
    expect(catchIndex).toBeGreaterThan(-1)
    const catchBody = operationsSource.slice(catchIndex, catchIndex + 700)
    expect(catchBody).toMatch(/error instanceof Error && error\.message/)
    expect(catchBody).toMatch(/\? error\.message/)
  })

  it('keeps a generic fallback for non-Error throws', () => {
    expect(operationsSource).toMatch(/'Failed to save pricing plan'/)
  })
})

describe('PricingTypeSelector — disabled option is screen-reader reachable', () => {
  it('disables the radio and points aria-describedby at an sr-only reason', () => {
    expect(selectorSource).toMatch(/disabled=\{!!disabledReason\}/)
    expect(selectorSource).toMatch(/aria-describedby=/)
    expect(selectorSource).toMatch(/\$\{id\}-disabled-reason/)
    expect(selectorSource).toMatch(/sr-only/)
  })
})

describe('Configure Pricing — the block is wired at the point of choice', () => {
  it('threads a per-signal disabled reason down to the selector', () => {
    expect(itemSource).toMatch(/creditPoolDisabledReason/)
    expect(itemSource).toMatch(/CREDIT_POOL: creditPoolDisabledReason/)
    expect(indexSource).toMatch(
      /creditPoolDisabledReason=\{creditPoolReasonFor\(/
    )
  })

  it('never disables the option on the row that holds the pool', () => {
    expect(indexSource).toMatch(
      /row\?\.pricingType === 'CREDIT_POOL'\) return null/
    )
  })

  it('feeds the saved-pool count and hidden-pool name into validation', () => {
    const handleSaveIndex = indexSource.indexOf('const handleSave')
    expect(handleSaveIndex).toBeGreaterThan(-1)
    const handleSaveBody = indexSource.slice(
      handleSaveIndex,
      handleSaveIndex + 700
    )
    expect(handleSaveBody).toMatch(/savedLivePools\.length/)
    expect(handleSaveBody).toMatch(/hiddenPoolHolder\?\.name \?\? null/)
  })

  it('counts saved pools with the isLivePoolStrategy mirror', () => {
    // No deletedAt clause: the client PricingStrategy type doesn't carry the
    // field (deleted rows are filtered server-side before mapping), and the
    // dashboard build type-errors if one is added.
    const mirrorIndex = indexSource.indexOf('const savedLivePools')
    expect(mirrorIndex).toBeGreaterThan(-1)
    const mirrorBody = indexSource.slice(mirrorIndex, mirrorIndex + 400)
    expect(mirrorBody).toMatch(/pricingModel === 'credit_pool'/)
    expect(mirrorBody).toMatch(/chargeType === 'usage'/)
    expect(mirrorBody).toMatch(/s\.active/)
  })
})
