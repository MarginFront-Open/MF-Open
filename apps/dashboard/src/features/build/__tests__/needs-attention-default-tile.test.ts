/**
 * The needs-attention alert tile must render
 * on Build by DEFAULT, not only after a user finds it in the add panel.
 *
 * DEFAULT_LAYOUTS.build carries fixed('alert-list') as its 4th tile.
 * This file closes the loop with REAL imports, not a mock:
 * dropping alert-list from the default array fails
 * here AND in default-layouts.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_LAYOUTS } from '@/features/dashboard-shell/default-layouts'
import { costBackfillItem } from '@/features/dashboard-shell/needs-attention'

const indexSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

describe('DEFAULT_LAYOUTS.build ships the needs-attention tile out of the box', () => {
  it('contains an alert-list tile (real import, not a test-local copy)', () => {
    expect(
      DEFAULT_LAYOUTS.build.some((tile) => tile.component === 'alert-list')
    ).toBe(true)
  })

  it('still links to the working Map/Fill fix page via costBackfillItem', () => {
    const item = costBackfillItem(2, 4)
    expect(item.href).toBe('/metrics-events/needs-attention')
  })
})

describe('the hasAlertListTile fetch-gate fires because the tile is now a default', () => {
  it('the page seeds its layout state from the REAL DEFAULT_LAYOUTS[PAGE], not an empty array', () => {
    expect(indexSrc).toMatch(
      /useReducer\(layoutReducer, DEFAULT_LAYOUTS\[PAGE\]\)/
    )
  })

  it('hasAlertListTile is derived from that same `tiles` state — since DEFAULT_LAYOUTS.build includes alert-list for real (asserted above), this evaluates true on first render, before any saved-layout fetch resolves', () => {
    expect(indexSrc).toMatch(
      /const hasAlertListTile = tiles\.some\(\(tile\) => tile\.component === 'alert-list'\)/
    )
  })

  it('the needs-attention fetch is gated on hasAlertListTile, so it fires whenever the tile is present (default or user-added)', () => {
    const effectStart = indexSrc.indexOf('if (!hasAlertListTile) return')
    expect(effectStart).toBeGreaterThan(-1)
    const effectBody = indexSrc.slice(effectStart, effectStart + 400)
    expect(effectBody).toMatch(/getNeedsCostBackfillGroups\(\)/)
  })
})
