// Pin a NEGATIVE-offset zone BEFORE the formatter runs: that's what makes
// this test able to fail. A naive `format(new Date(value), fmt)`
// renders one calendar day early ONLY in a negative-offset zone; under UTC the
// error is invisible. Node honors a runtime process.env.TZ change for Dates
// created afterward, and every Date here is built inside the test bodies.
process.env.TZ = 'America/New_York'

import { formatDisplayDate } from '@/lib/canon-date'

describe('formatDisplayDate — renders the stored UTC calendar date, timezone-stable', () => {
  it('a bare UTC date string keeps its day (invoice list / table)', () => {
    expect(formatDisplayDate('2026-07-03', 'MMM dd, yyyy')).toBe('Jul 03, 2026')
    expect(formatDisplayDate('2026-07-03', 'dd MMM yyyy')).toBe('03 Jul 2026')
  })

  it('a UTC ISO timestamp keeps its calendar day (invoice.invoiceDate is a full timestamp)', () => {
    // A UTC midnight read in a western timezone would otherwise print "Jul 2".
    expect(formatDisplayDate('2026-07-03T00:00:00.000Z')).toBe('Jul 3, 2026')
  })

  it('a Date instance is treated by its UTC calendar date', () => {
    expect(formatDisplayDate(new Date('2026-07-03T00:00:00.000Z'))).toBe(
      'Jul 3, 2026'
    )
  })

  it('the chart formats used by the timeseries tile', () => {
    expect(formatDisplayDate('2026-07-02', 'MMM d')).toBe('Jul 2')
    expect(formatDisplayDate('2026-07-05', 'MMM d')).toBe('Jul 5')
    expect(formatDisplayDate('2026-07-02', 'MMM d, yyyy')).toBe('Jul 2, 2026')
  })

  it('null / empty / unparseable input renders the em-dash placeholder', () => {
    expect(formatDisplayDate(null)).toBe('—')
    expect(formatDisplayDate(undefined)).toBe('—')
    expect(formatDisplayDate('')).toBe('—')
    expect(formatDisplayDate('not-a-date')).toBe('—')
  })

  it('a run of consecutive days each render their own calendar date', () => {
    const days = [
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
    ]
    expect(days.map((d) => formatDisplayDate(d, 'MMM d'))).toEqual([
      'Jul 1',
      'Jul 2',
      'Jul 3',
      'Jul 4',
      'Jul 5',
    ])
  })
})
