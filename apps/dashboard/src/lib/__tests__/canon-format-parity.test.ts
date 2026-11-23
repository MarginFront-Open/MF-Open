import {
  formatCurrency as canonFormatCurrency,
  formatCost as canonFormatCost,
  formatPct as canonFormatPct,
} from '../canon-format'

/**
 * Canon-format parity / standardization spec.
 *
 * canon-format.ts is the one money/percent formatter. This file compares it
 * with the hand-rolled formatter shapes it stands in for, in two classes:
 *
 *   PARITY CLASS: shapes canon reproduces exactly. Each is inlined below and
 *   asserted byte-identical to canon's output across the battery. If this
 *   ever fails, canon's behavior drifted from what its callers rely on.
 *
 *   STANDARDIZED CLASS: shapes canon deliberately renders differently,
 *   mostly sub-$1 values gaining precision (3dp/2dp → 4dp) and
 *   thousands-grouping. Both expected strings are asserted here so the
 *   difference is visible in the test data itself.
 *
 * Battery covers the zero/near-zero/band-boundary/negative cases that
 * expose every rounding and tier difference between those shapes and
 * canon's magnitude-aware rule.
 */

const BATTERY = [
  0, 0.0025, 0.006, 0.0099, 0.01, 0.5, 0.99, 1, 12.5, 99.99, 100, 250, 1234.56,
  -0.006, -50,
]

describe('canon-format parity — pure import swaps (byte-identical)', () => {
  // Org-currency formatCurrency: Intl currency at fixed precision. With no
  // stored org currency it uses DEFAULT_CURRENCY='USD'; asserting with an
  // explicit 'USD' arg reproduces that exactly.
  function oldUseOrgCurrencyFormatCurrency(
    amount: number | string,
    precision = 2
  ): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(Number(amount))
  }

  it.each(BATTERY)(
    'formatCurrency(%s, "USD") matches the org-currency Intl formatter',
    (n) => {
      expect(canonFormatCurrency(n, 'USD')).toBe(
        oldUseOrgCurrencyFormatCurrency(n)
      )
    }
  )

  // The magnitude-aware formatCost formula canon-format.ts's formatCost uses.
  function oldCommandCenterSharedFormatCost(n: number, decimals = 2): string {
    const magnitude = Math.abs(n)
    const minDecimals =
      magnitude === 0 ? 0 : magnitude < 1 ? 4 : magnitude < 100 ? 2 : 0
    const fractionDigits = Math.max(decimals, minDecimals)
    return `$${n.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })}`
  }

  it.each(BATTERY)(
    'formatCost(%s) matches the magnitude-aware formatCost formula',
    (n) => {
      expect(canonFormatCost(n)).toBe(oldCommandCenterSharedFormatCost(n))
    }
  )

  // One-decimal formatPct, incl. null.
  function oldCommandCenterSharedFormatPct(n: number | null): string {
    return n === null ? '—' : `${n.toFixed(1)}%`
  }

  it.each([...BATTERY, null])(
    'formatPct(%s) matches the one-decimal formatPct formula',
    (n) => {
      expect(canonFormatPct(n)).toBe(oldCommandCenterSharedFormatPct(n))
    }
  )
})

describe('canon-format standardization — deliberate rendering changes', () => {
  // 3-tier cost formatter (4dp under a cent, 3dp under a dollar, else 2dp).
  // Note the tier comparisons are on the raw signed value, not magnitude,
  // so a large negative like -50 falls into the 4-decimal tier below.
  function old3TierDialogFormatCost(n: number): string {
    if (n === 0) return '$0.00'
    if (n < 0.01) return `$${n.toFixed(4)}`
    if (n < 1) return `$${n.toFixed(3)}`
    return `$${n.toFixed(2)}`
  }

  // [input, 3-tier output, canon output]
  const threeTierCases: Array<[number, string, string]> = [
    [0, '$0.00', '$0.00'],
    [0.0025, '$0.0025', '$0.0025'],
    [0.006, '$0.0060', '$0.0060'],
    [0.0099, '$0.0099', '$0.0099'],
    [0.01, '$0.010', '$0.0100'], // 3dp -> 4dp
    [0.5, '$0.500', '$0.5000'], // 3dp -> 4dp
    [0.99, '$0.990', '$0.9900'], // 3dp -> 4dp
    [1, '$1.00', '$1.00'],
    [12.5, '$12.50', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [100, '$100.00', '$100.00'],
    [250, '$250.00', '$250.00'],
    [1234.56, '$1234.56', '$1,234.56'], // no grouping -> thousands grouping
    [-0.006, '$-0.0060', '$-0.0060'],
    [-50, '$-50.0000', '$-50.00'], // raw sign compare falls into the 4dp tier
  ]

  it.each(threeTierCases)(
    'formatCost(%s): a 3-tier formatter gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(old3TierDialogFormatCost(n)).toBe(oldExpected)
      expect(canonFormatCost(n)).toBe(newExpected)
    }
  )

  // 2-tier cost formatter (4dp under a cent, else 2dp).
  function oldMetricsWizardFormatCost(n: number): string {
    if (n < 0.01) return `$${n.toFixed(4)}`
    return `$${n.toFixed(2)}`
  }

  const metricsWizardCases: Array<[number, string, string]> = [
    [0, '$0.0000', '$0.00'], // canon renders true zero clean, not 4dp
    [0.0025, '$0.0025', '$0.0025'],
    [0.006, '$0.0060', '$0.0060'],
    [0.0099, '$0.0099', '$0.0099'],
    [0.01, '$0.01', '$0.0100'], // 2dp -> 4dp
    [0.5, '$0.50', '$0.5000'], // 2dp -> 4dp
    [0.99, '$0.99', '$0.9900'], // 2dp -> 4dp
    [1, '$1.00', '$1.00'],
    [12.5, '$12.50', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [100, '$100.00', '$100.00'],
    [250, '$250.00', '$250.00'],
    [1234.56, '$1234.56', '$1,234.56'], // no grouping -> thousands grouping
    [-0.006, '$-0.0060', '$-0.0060'],
    [-50, '$-50.0000', '$-50.00'], // raw sign compare falls into the 4dp tier
  ]

  it.each(metricsWizardCases)(
    'formatCost(%s): a 2-tier formatter gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(oldMetricsWizardFormatCost(n)).toBe(oldExpected)
      expect(canonFormatCost(n)).toBe(newExpected)
    }
  )

  // Flat toFixed(2) shapes, e.g. `$${v.toFixed(2)}`: a sub-cent cost rounds
  // away to "$0.00" instead of showing up.
  const flat2Cases: Array<[number, string, string]> = [
    [0, '$0.00', '$0.00'],
    [0.0025, '$0.00', '$0.0025'], // rounds to zero -> visible in canon
    [0.006, '$0.01', '$0.0060'],
    [0.0099, '$0.01', '$0.0099'],
    [0.01, '$0.01', '$0.0100'],
    [0.5, '$0.50', '$0.5000'],
    [0.99, '$0.99', '$0.9900'],
    [1, '$1.00', '$1.00'],
    [12.5, '$12.50', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [100, '$100.00', '$100.00'],
    [250, '$250.00', '$250.00'],
    [1234.56, '$1234.56', '$1,234.56'],
    [-0.006, '$-0.01', '$-0.0060'],
    [-50, '$-50.00', '$-50.00'],
  ]

  it.each(flat2Cases)(
    'formatCost(%s): flat toFixed(2) gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(`$${n.toFixed(2)}`).toBe(oldExpected)
      expect(canonFormatCost(n)).toBe(newExpected)
    }
  )

  // Flat toFixed(3) shapes, e.g. `$${Math.abs(x).toFixed(3)}`.
  const flat3Cases: Array<[number, string, string]> = [
    [0, '$0.000', '$0.00'],
    [0.0025, '$0.003', '$0.0025'],
    [0.006, '$0.006', '$0.0060'],
    [0.0099, '$0.010', '$0.0099'],
    [0.01, '$0.010', '$0.0100'],
    [0.5, '$0.500', '$0.5000'],
    [0.99, '$0.990', '$0.9900'],
    [1, '$1.000', '$1.00'],
    [12.5, '$12.500', '$12.50'],
    [99.99, '$99.990', '$99.99'],
    [100, '$100.000', '$100.00'],
    [250, '$250.000', '$250.00'],
    [1234.56, '$1234.560', '$1,234.56'],
    [-0.006, '$-0.006', '$-0.0060'],
    [-50, '$-50.000', '$-50.00'],
  ]

  it.each(flat3Cases)(
    'formatCost(%s): flat toFixed(3) gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(`$${n.toFixed(3)}`).toBe(oldExpected)
      expect(canonFormatCost(n)).toBe(newExpected)
    }
  )

  // Flat toFixed(4) shapes, e.g. `$${v.toFixed(4)}`. Differs from canon at
  // zero and from $1 up, where canon drops to 2 decimals for the clean-tile
  // look.
  const flat4Cases: Array<[number, string, string]> = [
    [0, '$0.0000', '$0.00'],
    [0.0025, '$0.0025', '$0.0025'],
    [0.006, '$0.0060', '$0.0060'],
    [0.0099, '$0.0099', '$0.0099'],
    [0.01, '$0.0100', '$0.0100'],
    [0.5, '$0.5000', '$0.5000'],
    [0.99, '$0.9900', '$0.9900'],
    [1, '$1.0000', '$1.00'],
    [12.5, '$12.5000', '$12.50'],
    [99.99, '$99.9900', '$99.99'],
    [100, '$100.0000', '$100.00'],
    [250, '$250.0000', '$250.00'],
    [1234.56, '$1234.5600', '$1,234.56'],
    [-0.006, '$-0.0060', '$-0.0060'],
    [-50, '$-50.0000', '$-50.00'],
  ]

  it.each(flat4Cases)(
    'formatCost(%s): flat toFixed(4) gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(`$${n.toFixed(4)}`).toBe(oldExpected)
      expect(canonFormatCost(n)).toBe(newExpected)
    }
  )
})

describe('canon-format vs. more hand-rolled shapes', () => {
  // Dollar-prefixed toLocaleString, fixed 2dp. Byte-identical to canon for
  // every non-negative amount. Diverges only on the sign side for negatives
  // (profit/margin can go negative): this shape puts the literal "$" first
  // ("$-50.00"), canon's Intl currency formatting puts the sign first
  // ("-$50.00").
  const flatDollarCurrencyCases: Array<[number, string, string]> = [
    [0, '$0.00', '$0.00'],
    [0.0025, '$0.00', '$0.00'],
    [0.006, '$0.01', '$0.01'],
    [0.0099, '$0.01', '$0.01'],
    [0.01, '$0.01', '$0.01'],
    [0.5, '$0.50', '$0.50'],
    [0.99, '$0.99', '$0.99'],
    [1, '$1.00', '$1.00'],
    [12.5, '$12.50', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [100, '$100.00', '$100.00'],
    [250, '$250.00', '$250.00'],
    [1234.56, '$1,234.56', '$1,234.56'],
    [-0.006, '$-0.01', '-$0.01'], // sign-placement flip
    [-50, '$-50.00', '-$50.00'], // sign-placement flip
  ]

  it.each(flatDollarCurrencyCases)(
    'formatCurrency(%s): dollar-prefixed toLocaleString gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(
        `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      ).toBe(oldExpected)
      expect(canonFormatCurrency(n, 'USD')).toBe(newExpected)
    }
  )

  // Intl currency with minimumFractionDigits toggled 0/2 by whether the
  // amount is a whole number. Canon's formatCurrency is always fixed at 2dp
  // (the invoice/subscription-figure default), so whole dollar rates always
  // show ".00" instead of collapsing to bare dollars. Deliberate: a pricing
  // tier rate is a billed figure, and every billed-figure surface in the app
  // shows cents unconditionally.
  const pricingPlanCurrencyCases: Array<[number, string, string]> = [
    [0, '$0', '$0.00'],
    [1, '$1', '$1.00'],
    [29, '$29', '$29.00'],
    [100, '$100', '$100.00'],
    [250, '$250', '$250.00'],
    [1000, '$1,000', '$1,000.00'],
    [12.5, '$12.50', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [1234.56, '$1,234.56', '$1,234.56'],
    [-50, '-$50', '-$50.00'],
    [-0.006, '-$0.01', '-$0.01'],
    [0.0025, '$0.00', '$0.00'],
    [0.006, '$0.01', '$0.01'],
  ]

  it.each(pricingPlanCurrencyCases)(
    'formatCurrency(%s): variable-precision Intl gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(
        new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: n % 1 === 0 ? 0 : 2,
        }).format(n)
      ).toBe(oldExpected)
      expect(canonFormatCurrency(n)).toBe(newExpected)
    }
  )

  // Raw `$${n.toFixed(2)}`, no thousands grouping, as invoice line items and
  // totals would render it. Matches canon for every non-negative amount
  // under $1,000; diverges above that band, where canon's Intl formatting
  // adds the comma grouping every invoice surface in the dashboard has.
  const rawToFixed2CurrencyCases: Array<[number, string, string]> = [
    [0, '$0.00', '$0.00'],
    [0.0025, '$0.00', '$0.00'],
    [0.006, '$0.01', '$0.01'],
    [0.0099, '$0.01', '$0.01'],
    [0.01, '$0.01', '$0.01'],
    [0.5, '$0.50', '$0.50'],
    [0.99, '$0.99', '$0.99'],
    [1, '$1.00', '$1.00'],
    [12.5, '$12.50', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [100, '$100.00', '$100.00'],
    [250, '$250.00', '$250.00'],
    [1234.56, '$1234.56', '$1,234.56'], // no grouping -> thousands grouping
    [-0.006, '$-0.01', '-$0.01'], // sign-placement flip
    [-50, '$-50.00', '-$50.00'], // sign-placement flip
  ]

  it.each(rawToFixed2CurrencyCases)(
    'formatCurrency(%s): raw toFixed(2) (no grouping) gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(`$${n.toFixed(2)}`).toBe(oldExpected)
      expect(canonFormatCurrency(n)).toBe(newExpected)
    }
  )

  // Raw `$${n.toFixed(4)}`, as a Unit Price column renders sub-cent usage
  // rates. Canon's formatCurrency takes an explicit precision argument for
  // exactly this case (formatCurrency(amount, undefined, 4)): byte-identical
  // for every non-negative rate under $1,000, and a unit price is never
  // negative.
  const rawToFixed4CurrencyCases: Array<[number, string, string]> = [
    [0, '$0.0000', '$0.0000'],
    [0.0025, '$0.0025', '$0.0025'],
    [0.006, '$0.0060', '$0.0060'],
    [0.01, '$0.0100', '$0.0100'],
    [0.5, '$0.5000', '$0.5000'],
    [1, '$1.0000', '$1.0000'],
    [12.3456, '$12.3456', '$12.3456'],
    [99.99, '$99.9900', '$99.9900'],
    [1234.5678, '$1234.5678', '$1,234.5678'], // no grouping -> thousands grouping
    [-0.006, '$-0.0060', '-$0.0060'], // sign-placement flip
  ]

  it.each(rawToFixed4CurrencyCases)(
    'formatCurrency(%s, undefined, 4): raw toFixed(4) gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(`$${n.toFixed(4)}`).toBe(oldExpected)
      expect(canonFormatCurrency(n, undefined, 4)).toBe(newExpected)
    }
  )

  // Bare `$${n.toLocaleString()}`, no fraction-digit options at all, so
  // precision varies with whatever the number naturally carries.
  // Canon's magnitude-aware formatCost always shows a stable, predictable
  // precision instead.
  const bareLocaleStringCostCases: Array<[number, string, string]> = [
    [0, '$0', '$0.00'],
    [0.0025, '$0.003', '$0.0025'],
    [0.006, '$0.006', '$0.0060'],
    [0.0099, '$0.01', '$0.0099'],
    [0.01, '$0.01', '$0.0100'],
    [0.5, '$0.5', '$0.5000'],
    [0.99, '$0.99', '$0.9900'],
    [1, '$1', '$1.00'],
    [12.5, '$12.5', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [100, '$100', '$100.00'],
    [250, '$250', '$250.00'],
    [1234.56, '$1,234.56', '$1,234.56'],
    [-0.006, '$-0.006', '$-0.0060'],
    [-50, '$-50', '$-50.00'],
  ]

  it.each(bareLocaleStringCostCases)(
    'formatCost(%s): bare toLocaleString() (no options) gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(`$${n.toLocaleString()}`).toBe(oldExpected)
      expect(canonFormatCost(n)).toBe(newExpected)
    }
  )

  // Dollar-prefixed toLocaleString, fixed 2dp WITH thousands grouping. This
  // is canon's formatCost formula without the magnitude tiers, so it's
  // byte-identical to canon for every amount >= $1. The only difference is
  // canon's magnitude-aware bump to 4dp under $1, same as the other
  // formatCost tables above.
  const groupedFlat2CostCases: Array<[number, string, string]> = [
    [0, '$0.00', '$0.00'],
    [0.0025, '$0.00', '$0.0025'],
    [0.006, '$0.01', '$0.0060'],
    [0.0099, '$0.01', '$0.0099'],
    [0.01, '$0.01', '$0.0100'],
    [0.5, '$0.50', '$0.5000'],
    [0.99, '$0.99', '$0.9900'],
    [1, '$1.00', '$1.00'],
    [12.5, '$12.50', '$12.50'],
    [99.99, '$99.99', '$99.99'],
    [100, '$100.00', '$100.00'],
    [250, '$250.00', '$250.00'],
    [1234.56, '$1,234.56', '$1,234.56'],
    [-0.006, '$-0.01', '$-0.0060'],
    [-50, '$-50.00', '$-50.00'],
  ]

  it.each(groupedFlat2CostCases)(
    'formatCost(%s): dollar-prefixed toLocaleString(2dp, grouped) gives %s, canon gives %s',
    (n, oldExpected, newExpected) => {
      expect(
        `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      ).toBe(oldExpected)
      expect(canonFormatCost(n)).toBe(newExpected)
    }
  )
})
