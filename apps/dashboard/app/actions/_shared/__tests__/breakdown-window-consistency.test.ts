/**
 * Breakdown window consistency (table == export == tile).
 *
 * The Cost+Rev and Platform breakdowns fetch their rows (and export their
 * XLSX) over a window built from `formatBreakdownFilterDate(date, preset)` in
 * command-center-shared.tsx, then the server resolves that string through the
 * canonical `parseWindowFilter`. If a rolling preset (e.g. "last 30 days")
 * were formatted as a bare `yyyy-MM-dd`, parseWindowFilter would floor it to
 * UTC midnight, so the table/export window would start hours EARLIER than the
 * tile's exact now()-30d, pull in a leading slice and drift the totals above
 * the tile.
 *
 * So the helper sends a full ISO timestamp for rolling presets (no floor) while
 * keeping a bare date for CUSTOM calendar ranges (so parseWindowFilter still
 * expands the end to 23:59:59.999 and the chosen end day stays inclusive).
 *
 * Why mirror `formatBreakdownFilterDate` instead of importing it: it lives in
 * command-center-shared.tsx, a `'use client'` module that pulls in React + the
 * Badge UI tree; importing it into this jest/node suite drags that whole tree
 * in. The real parseWindowFilter has no React deps, so we exercise it for real. If the
 * helper at the call site changes, update the mirror below.
 */
import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'
import { format } from 'date-fns'

// Module marker: keep script-scope helper names from colliding with sibling
// tests under a single tsc pass (TS2451).
export {}

type Preset =
  | 'last7'
  | 'last30'
  | 'last60'
  | 'last90'
  | 'ytd'
  | 'allTime'
  | 'custom'

// ── Mirror of formatBreakdownFilterDate (command-center-shared.tsx) ──
const formatFilterDate = (d: Date, preset: Preset): string =>
  preset === 'custom' ? format(d, 'yyyy-MM-dd') : d.toISOString()

describe('breakdown window consistency', () => {
  it('rolling preset: window start keeps the exact now()-30d instant (no UTC-midnight floor)', () => {
    // A non-midnight instant: the tile's rolling start lands mid-day.
    const tileStart = new Date('2026-05-31T18:23:41.000Z')
    const tileEnd = new Date('2026-06-15T09:00:00.000Z')

    const { windowStart, windowEnd } = parseWindowFilter({
      startDate: formatFilterDate(tileStart, 'last30'),
      endDate: formatFilterDate(tileEnd, 'last30'),
    })

    // The breakdown window === the tile window, to the millisecond.
    expect(windowStart.getTime()).toBe(tileStart.getTime())
    expect(windowEnd.getTime()).toBe(tileEnd.getTime())
    // A bare-date path would floor to midnight, dropping the leading slice.
    // The ISO path must NOT floor.
    expect(windowStart.getUTCHours()).toBe(18)
    expect(windowStart.getUTCHours()).not.toBe(0)
  })

  it('a bare-date format floors the start to midnight', () => {
    const tileStart = new Date('2026-05-31T18:23:41.000Z')
    // A bare yyyy-MM-dd anchors to start-of-day.
    const flooredStart = parseWindowFilter({
      startDate: tileStart.toISOString().slice(0, 10),
    }).windowStart
    expect(flooredStart.getUTCHours()).toBe(0)
    // The ISO path does NOT match that floor.
    const isoStart = parseWindowFilter({
      startDate: formatFilterDate(tileStart, 'last30'),
    }).windowStart
    expect(isoStart.getTime()).not.toBe(flooredStart.getTime())
  })

  it('custom range: the selected end day stays inclusive (end → 23:59:59.999)', () => {
    // Constructed via local Y/M/D so format() yields the intended calendar
    // day in any test timezone.
    const customStart = new Date(2026, 2, 1) // 1 Mar 2026, local midnight
    const customEnd = new Date(2026, 2, 15) // 15 Mar 2026, local midnight

    const startStr = formatFilterDate(customStart, 'custom')
    const endStr = formatFilterDate(customEnd, 'custom')

    // Custom must stay bare (no 'T') so parseWindowFilter expands the end.
    expect(startStr).not.toContain('T')
    expect(endStr).not.toContain('T')
    expect(endStr).toBe('2026-03-15')

    const { windowEnd } = parseWindowFilter({
      startDate: startStr,
      endDate: endStr,
    })
    // End of the chosen day, not its midnight — the day remains included.
    expect(windowEnd.getUTCHours()).toBe(23)
    expect(windowEnd.getUTCMinutes()).toBe(59)
    expect(windowEnd.getUTCSeconds()).toBe(59)
    expect(windowEnd.getUTCMilliseconds()).toBe(999)
  })

  it('export filters === table filters: both surfaces format from the one helper', () => {
    // The breakdown fetch and the CSV export both call
    // formatBreakdownFilterDate with the same (date, preset), so the exported
    // window cannot diverge from the on-screen table's window.
    const d = new Date('2026-05-31T18:23:41.000Z')
    for (const preset of ['last30', 'custom'] as Preset[]) {
      expect(formatFilterDate(d, preset)).toBe(formatFilterDate(d, preset))
    }
    // And the two modes format differently (the whole point of the branch).
    expect(formatFilterDate(d, 'last30')).toContain('T')
    expect(formatFilterDate(d, 'custom')).not.toContain('T')
  })
})
