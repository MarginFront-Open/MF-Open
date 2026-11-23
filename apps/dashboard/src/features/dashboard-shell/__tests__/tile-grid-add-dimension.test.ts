/**
 * The add panel's default dimension is a
 * (page, component) lookup: FinOps additions open on Category, Money keeps
 * Customer, everything else keeps the base default. tile-grid.tsx imports
 * @dnd-kit/core, so — like tile-grid-drag.test.ts — this is a source-assert,
 * not a real import (dashboard jest is node-only, no RTL).
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', 'tile-grid.tsx'), 'utf8')

describe('tile-grid.tsx — per-page default add dimension', () => {
  it('declares the finops override: donut AND table open on costCategory', () => {
    const overrideIndex = src.indexOf('PAGE_ADD_DIMENSION')
    expect(overrideIndex).toBeGreaterThan(-1)
    const finopsBlockStart = src.indexOf('finops:', overrideIndex)
    expect(finopsBlockStart).toBeGreaterThan(-1)
    const finopsBlock = src.slice(
      finopsBlockStart,
      src.indexOf('}', finopsBlockStart)
    )
    expect(finopsBlock).toMatch(/'category-donut':\s*'costCategory'/)
    expect(finopsBlock).toMatch(/'breakdown-table':\s*'costCategory'/)
  })

  it('the base defaults are unchanged (money/overview keep customer/day)', () => {
    const baseIndex = src.indexOf('const DEFAULT_ADD_DIMENSION')
    expect(baseIndex).toBeGreaterThan(-1)
    const baseBlock = src.slice(baseIndex, src.indexOf('}', baseIndex))
    expect(baseBlock).toMatch(/'timeseries-chart':\s*'day'/)
    expect(baseBlock).toMatch(/'breakdown-table':\s*'customer'/)
  })

  it('defaultAddDimension resolves per-page first, then the base map', () => {
    expect(src).toMatch(
      /PAGE_ADD_DIMENSION\[page\]\?\.\[component\] \?\? DEFAULT_ADD_DIMENSION\[component\]/
    )
  })

  it('addOptionsFor routes through the lookup, not the base map directly', () => {
    expect(src).toMatch(/dimension:\s*defaultAddDimension\(page,\s*component\)/)
    expect(src).not.toMatch(/dimension:\s*DEFAULT_ADD_DIMENSION\[component\]/)
  })
})
