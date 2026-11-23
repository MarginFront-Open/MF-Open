import {
  BREAKDOWN_CSV_COLUMNS,
  columnsAvailableForBasis,
  isBreakdownCsvColumn,
} from '../csv-columns'

/**
 * The column-availability gate the CSV dialog
 * (checkbox rendering) and the export route (which columns actually get
 * built into the CSV) both read. Locks the honest-null behavior: a dimension
 * with no honest revenue basis drops Revenue/Margin/Margin % entirely.
 */
describe('columnsAvailableForBasis', () => {
  it('offers only Usage events + Cost when there is no revenue basis (model/environment)', () => {
    expect(columnsAvailableForBasis(null)).toEqual(['tasks', 'cost'])
  })

  it('offers all 5 columns for an earned basis (agent/signal)', () => {
    expect(columnsAvailableForBasis('earned')).toEqual([
      ...BREAKDOWN_CSV_COLUMNS,
    ])
  })

  it('offers all 5 columns for a billed basis (customer/plan)', () => {
    expect(columnsAvailableForBasis('billed')).toEqual([
      ...BREAKDOWN_CSV_COLUMNS,
    ])
  })
})

describe('isBreakdownCsvColumn', () => {
  it('accepts every declared column id', () => {
    for (const column of BREAKDOWN_CSV_COLUMNS) {
      expect(isBreakdownCsvColumn(column)).toBe(true)
    }
  })

  it('rejects an unknown/typo column id (defensive parsing of the ?columns= query param)', () => {
    expect(isBreakdownCsvColumn('revenu')).toBe(false)
    expect(isBreakdownCsvColumn('')).toBe(false)
    expect(isBreakdownCsvColumn('cost; DROP TABLE')).toBe(false)
  })
})
