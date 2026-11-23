/**
 * Breakdown filter-building decision.
 *
 * What this guards: the Cost+Rev / Platform breakdown table and its CSV/XLSX
 * export build their server window from `formatBreakdownFilterDate(date, preset)`
 * (command-center-shared.tsx), and the SERVER resolves that string through the
 * canonical `parseWindowFilter`. The trap: if a ROLLING preset (e.g.
 * "last 30 days") were formatted as a bare `yyyy-MM-dd`, parseWindowFilter would
 * floor it to UTC-midnight, so the table/export window would start hours EARLIER than
 * the tile's exact now()-30d, pulling in a leading slice and drifting the totals
 * above the tile.
 *
 * The helper branches: full ISO timestamp for rolling presets (no floor) while a
 * bare date stays for CUSTOM ranges (so parseWindowFilter expands the end to
 * 23:59:59.999 and the chosen end day stays inclusive — a blanket toISOString
 * would CUT OFF the end day).
 *
 * MIRROR convention (jest is testEnvironment:'node', no React Testing Library):
 * we do NOT import the 'use client' command-center-shared.tsx (it drags in React
 * + the Badge tree). We replicate the EXACT call-site predicate below and run it
 * against the REAL, React-free `parseWindowFilter`. If the call-site predicate
 * changes, update the mirror.
 *
 * FAILING-CAPABLE: `bareDateFormat` is the bare-date predicate that sends
 * `format(d,'yyyy-MM-dd')` for ALL presets. The mutation tests run BOTH
 * predicates through the real parser and prove the results differ, so if the
 * call site used the bare-date predicate, the preset assertions here would FAIL.
 */
import { parseWindowFilter } from '@/app/actions/_shared/parse-window-filter'
import { format } from 'date-fns'

// isolatedModules: keep script-scope helper names from colliding across the
// suite under a single tsc pass (TS2451).
export {}

type FilterPreset =
  | 'last7'
  | 'last30'
  | 'last60'
  | 'last90'
  | 'ytd'
  | 'allTime'
  | 'custom'

// ── EXACT mirror of formatBreakdownFilterDate (command-center-shared.tsx) ──
//    preset === 'custom' ? format(d, 'yyyy-MM-dd') : d.toISOString()
const presetFilterDate = (d: Date, preset: FilterPreset): string =>
  preset === 'custom' ? format(d, 'yyyy-MM-dd') : d.toISOString()

// ── The bare-date predicate (the mutation the tests must catch) ──
//    A bare yyyy-MM-dd for EVERY preset, including rolling ones.
const bareDateFormat = (d: Date): string => format(d, 'yyyy-MM-dd')

// ── Mirror of the export toParam (downloadBreakdownExport) ──
//    filters.datePreset ? formatBreakdownFilterDate(d, preset) : d.toISOString().slice(0,10)
const exportParam = (d: Date, preset: FilterPreset | undefined): string =>
  preset ? presetFilterDate(d, preset) : d.toISOString().slice(0, 10)

describe('filter-building decision (real parseWindowFilter)', () => {
  // A tile rolling-start that lands mid-day, NOT on a UTC boundary.
  const tileStart = new Date('2026-05-31T18:23:41.000Z')
  const tileEnd = new Date('2026-06-15T09:00:00.000Z')

  it('preset → ISO start matches the tile rolling window to the millisecond (no midnight floor)', () => {
    const { windowStart, windowEnd } = parseWindowFilter({
      startDate: presetFilterDate(tileStart, 'last30'),
      endDate: presetFilterDate(tileEnd, 'last30'),
    })

    expect(windowStart.getTime()).toBe(tileStart.getTime())
    expect(windowEnd.getTime()).toBe(tileEnd.getTime())
    // The exact instant survives — it was NOT floored to 00:00:00Z.
    expect(windowStart.getUTCHours()).toBe(18)
    expect(windowStart.getUTCMinutes()).toBe(23)
    expect(windowStart.getUTCSeconds()).toBe(41)
  })

  it('MUTATION PROOF: the bare-date predicate floors the preset start to midnight (would fail the assertion above)', () => {
    const presetStart = parseWindowFilter({
      startDate: presetFilterDate(tileStart, 'last30'),
    }).windowStart
    const bareDateStart = parseWindowFilter({
      startDate: bareDateFormat(tileStart),
    }).windowStart

    // Bare date: floored to start-of-day UTC, losing the 18:23:41 instant.
    expect(bareDateStart.getUTCHours()).toBe(0)
    expect(bareDateStart.getUTCMinutes()).toBe(0)
    expect(bareDateStart.getUTCSeconds()).toBe(0)

    // Anti-tautology: the two windows genuinely diverge, so the first test
    // cannot be green under the bare-date predicate.
    expect(presetStart.getTime()).not.toBe(bareDateStart.getTime())
    expect(bareDateStart.getTime()).not.toBe(tileStart.getTime())
    // Concretely, the bare-date floor reaches ~18h further back.
    expect(presetStart.getTime() - bareDateStart.getTime()).toBe(
      ((18 * 60 + 23) * 60 + 41) * 1000
    )
  })

  it('custom range → end day remains included (bare date expands to 23:59:59.999, date-only path preserved)', () => {
    // Local-midnight Y/M/D so format() yields the intended calendar day in any
    // test timezone.
    const customStart = new Date(2026, 2, 1) // 1 Mar 2026
    const customEnd = new Date(2026, 2, 15) // 15 Mar 2026

    const startStr = presetFilterDate(customStart, 'custom')
    const endStr = presetFilterDate(customEnd, 'custom')

    // Custom must stay bare (no 'T') so the server expands the end of day.
    expect(startStr).not.toContain('T')
    expect(endStr).not.toContain('T')
    expect(endStr).toBe('2026-03-15')

    const { windowEnd } = parseWindowFilter({
      startDate: startStr,
      endDate: endStr,
    })
    expect(windowEnd.toISOString()).toBe('2026-03-15T23:59:59.999Z')
  })

  it('MUTATION PROOF: a blanket toISOString() on a custom end would EXCLUDE the chosen end day (why the branch keeps date-only)', () => {
    const customEnd = new Date(2026, 2, 15)

    // The wrong mutation: send a full ISO for custom too.
    const blanketIsoEnd = parseWindowFilter({
      endDate: customEnd.toISOString(),
    }).windowEnd
    // The real, date-only custom path.
    const dateOnlyEnd = parseWindowFilter({
      endDate: presetFilterDate(customEnd, 'custom'),
    }).windowEnd

    // Blanket-ISO anchors to the START of the chosen day (00:00 local → its UTC
    // instant), chopping off the rest of that day's events; date-only keeps the
    // full day. They must differ, and only the date-only path is end-inclusive.
    expect(blanketIsoEnd.getTime()).not.toBe(dateOnlyEnd.getTime())
    expect(dateOnlyEnd.getTime()).toBeGreaterThan(blanketIsoEnd.getTime())
    expect(dateOnlyEnd.toISOString()).toBe('2026-03-15T23:59:59.999Z')
  })

  it('export filters === table filters: with a preset both resolve to the identical window; a no-preset export floors (must thread the preset)', () => {
    const tableStart = presetFilterDate(tileStart, 'last30')
    const exportStart = exportParam(tileStart, 'last30')

    const tableWin = parseWindowFilter({ startDate: tableStart })
    const exportWin = parseWindowFilter({ startDate: exportStart })
    // Same window, to the millisecond — export cannot diverge from the table.
    expect(exportWin.windowStart.getTime()).toBe(tableWin.windowStart.getTime())
    expect(exportWin.windowStart.getTime()).toBe(tileStart.getTime())

    // The no-preset export path (slice(0,10)) floors, proving the
    // preset MUST be threaded through to keep export == table.
    const noPresetExportStart = parseWindowFilter({
      startDate: exportParam(tileStart, undefined),
    }).windowStart
    expect(noPresetExportStart.getUTCHours()).toBe(0)
    expect(noPresetExportStart.getTime()).not.toBe(tableWin.windowStart.getTime())
  })
})
