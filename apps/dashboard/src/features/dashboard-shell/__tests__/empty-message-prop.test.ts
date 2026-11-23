import { readFileSync } from 'fs'
import { join } from 'path'

const SHELL_DIR = join(__dirname, '..')

/**
 * Optional prop: an alert-list with nothing to flag
 * reads as "Nothing needs attention," not the generic "No data for this
 * period" every other tile shares. Source-assert only (dashboard jest is
 * node-only, no RTL) — this checks the prop threads through
 * without a full render.
 */
describe('TileFrame/AlertList: emptyMessage prop is optional', () => {
  it('TileFrame accepts an emptyMessage prop, with a default copy', () => {
    const src = readFileSync(join(SHELL_DIR, 'tiles', 'tile-frame.tsx'), 'utf8')
    expect(src).toMatch(/emptyMessage\?:\s*string/)
    expect(src).toMatch(/emptyMessage\s*=\s*'No data for this period'/)
  })

  it('AlertList forwards emptyMessage to TileFrame', () => {
    const src = readFileSync(join(SHELL_DIR, 'tiles', 'alert-list.tsx'), 'utf8')
    expect(src).toMatch(/emptyMessage\?:\s*string/)
    expect(src).toMatch(/emptyMessage=\{emptyMessage\}/)
  })
})
