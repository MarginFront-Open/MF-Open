import { formatCurrency, formatCost, formatPct } from '../canon-format'

// Pure-function tests (dashboard jest is node-only, no RTL).
// storage-backed org-currency resolution is exercised via the explicit
// `currency` arg so these run without a localStorage shim.

describe('canon-format', () => {
  describe('formatCost — magnitude-aware', () => {
    it('keeps 2 decimals by default', () => {
      expect(formatCost(0)).toBe('$0.00')
    })
    it('renders a clean whole-dollar zero when decimals=0', () => {
      expect(formatCost(0, 0)).toBe('$0')
    })
    it('shows a sub-$1 cost with 4 decimals so it never reads as $0', () => {
      expect(formatCost(0.006)).toBe('$0.0060')
    })
    it('uses 2 decimals under $100', () => {
      expect(formatCost(12.5)).toBe('$12.50')
    })
    it('keeps 2 decimals by default even for large amounts', () => {
      expect(formatCost(1234.56)).toBe('$1,234.56')
    })
    it('rounds to whole dollars only when decimals=0 is passed', () => {
      expect(formatCost(1234.56, 0)).toBe('$1,235')
    })
  })

  describe('formatPct — canon M1 null handling', () => {
    it('renders null as an em dash, not 0.0%', () => {
      expect(formatPct(null)).toBe('—')
    })
    it('renders a value to one decimal', () => {
      expect(formatPct(64.2)).toBe('64.2%')
    })
  })

  describe('formatCurrency — fixed precision, explicit currency', () => {
    it('formats USD to 2 decimals with separators', () => {
      expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50')
    })
    it('honors an explicit precision', () => {
      expect(formatCurrency(1234.56, 'USD', 0)).toBe('$1,235')
    })
  })
})
