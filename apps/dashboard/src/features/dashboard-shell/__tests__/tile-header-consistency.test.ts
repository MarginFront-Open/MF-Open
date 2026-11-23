/**
 * One header treatment and one content-tile frame class across the catalog
 * tiles (source-assert: dashboard jest is node-only, no RTL). Every tile has
 * the uppercase-label + info-icon header, and no bespoke min-height
 * misaligns shared rows.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

const SHELL_DIR = join(__dirname, '..')
const TILES_DIR = join(SHELL_DIR, 'tiles')

const read = (dir: string, file: string) =>
  readFileSync(join(dir, file), 'utf8')

const HEADER_CONSUMERS = [
  'kpi-tile.tsx',
  'alert-list.tsx',
  'checklist.tsx',
  'gauge.tsx',
  'category-donut.tsx',
  'breakdown-table.tsx',
]

describe('TileHeader — the one header treatment', () => {
  const headerSrc = read(TILES_DIR, 'tile-header.tsx')

  it('carries the kpi-tile uppercase treatment verbatim', () => {
    expect(headerSrc).toMatch(
      /text-\[10\.5px\] font-semibold uppercase tracking-\[\.05em\] text-mf-tx3/
    )
  })

  it('renders the info icon only when a tooltip is passed', () => {
    expect(headerSrc).toMatch(/\{tooltip && \(/)
    expect(headerSrc).toMatch(/InfoTooltip/)
  })

  it.each(HEADER_CONSUMERS)(
    '%s renders its title through TileHeader',
    (file) => {
      const src = read(TILES_DIR, file)
      expect(src).toMatch(/from ['"]\.\/tile-header['"]/)
      expect(src).toMatch(/<TileHeader/)
      // No tile keeps a bare 13px title span of its own.
      expect(src).not.toMatch(/text-\[13px\] font-semibold tracking/)
    }
  )

  it('AlertList takes an optional tooltipKey and resolves it from tooltip-definitions', () => {
    const src = read(TILES_DIR, 'alert-list.tsx')
    expect(src).toMatch(/tooltipKey\?: TooltipKey/)
    expect(src).toMatch(
      /tooltipKey \? tooltipDefinitions\[tooltipKey\] : undefined/
    )
  })
})

describe('needsAttention tooltip — plain-English copy on every alerts tile', () => {
  it('exists with title/description/details', () => {
    const tooltip = tooltipDefinitions.needsAttention
    expect(tooltip.title).toBe('Needs attention')
    expect(tooltip.description.length).toBeGreaterThan(0)
    expect(tooltip.details.length).toBeGreaterThan(0)
  })

  it('contains no em dash', () => {
    expect(JSON.stringify(tooltipDefinitions.needsAttention)).not.toMatch(/—/)
  })

  it.each([
    ['money', join(SHELL_DIR, '..', 'money', 'index.tsx')],
    ['build', join(SHELL_DIR, '..', 'build', 'index.tsx')],
    ['finops', join(SHELL_DIR, '..', 'finops', 'index.tsx')],
    ['mfiq', join(SHELL_DIR, '..', 'mfiq', 'index.tsx')],
  ])(
    "%s wires tooltipKey='needsAttention' on its Needs attention tile",
    (_page, path) => {
      const src = readFileSync(path, 'utf8')
      expect(src).toMatch(
        /title='Needs attention'\s*\n\s*tooltipKey='needsAttention'/
      )
    }
  )
})

describe('CONTENT_TILE_CLASS — one frame class for content-band card tiles', () => {
  it('tile-frame.tsx exports the single class (220 floor, shared padding)', () => {
    const src = read(TILES_DIR, 'tile-frame.tsx')
    expect(src).toMatch(
      /export const CONTENT_TILE_CLASS = 'h-full min-h-\[220px\] px-\[17px\] py-\[15px\]'/
    )
  })

  it.each([
    'alert-list.tsx',
    'checklist.tsx',
    'gauge.tsx',
    'category-donut.tsx',
  ])('%s uses CONTENT_TILE_CLASS — no per-tile magic min-height', (file) => {
    const src = read(TILES_DIR, file)
    expect(src).toMatch(/className=\{CONTENT_TILE_CLASS\}/)
    expect(src).not.toMatch(/min-h-\[220px\]/)
  })

  it('mfiq RulesList (the same card shape on the MF IQ grid) shares it too', () => {
    const src = readFileSync(
      join(SHELL_DIR, '..', 'mfiq', 'components', 'rules-list.tsx'),
      'utf8'
    )
    expect(src).toMatch(/className=\{CONTENT_TILE_CLASS\}/)
  })

  it('kpi-tile keeps its own fixed height (the KPI band is height-uniform by construction)', () => {
    const src = read(TILES_DIR, 'kpi-tile.tsx')
    expect(src).toMatch(/h-\[146px\]/)
  })
})
