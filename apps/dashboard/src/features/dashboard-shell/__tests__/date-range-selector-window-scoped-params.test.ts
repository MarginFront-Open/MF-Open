import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The selector must build its next URL through the pure
 * helper, not by copying the whole query string itself. Source-asserted
 * because dashboard jest is node-only (no RTL): the behaviour is covered in
 * date-range.test.ts, and this pins that the component actually calls it, so
 * a refactor cannot quietly reintroduce `new URLSearchParams(searchParams)`
 * and carry the customer's count into a window they never counted.
 */
const SRC = readFileSync(
  join(__dirname, '..', 'date-range-selector.tsx'),
  'utf8'
)

describe('DateRangeSelector — commit() builds its URL through nextUrlParams', () => {
  const start = SRC.indexOf('const commit = (')
  const commitBody = SRC.slice(start, SRC.indexOf('\n  }', start))

  it('the anchor exists — commit has not moved or been renamed', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('calls nextUrlParams with the current params, the selection and the page config', () => {
    expect(SRC).toMatch(
      /import \{[^}]*\bnextUrlParams\b[^}]*\} from '\.\/date-range'/s
    )
    expect(commitBody).toMatch(
      /nextUrlParams\(\s*searchParams,\s*next,\s*config\s*\)/
    )
  })

  it('does not copy the whole query string, and sets no date param by hand', () => {
    expect(commitBody).not.toMatch(/new URLSearchParams\(searchParams\)/)
    expect(commitBody).not.toMatch(/\.set\('startDate'/)
    expect(commitBody).not.toMatch(/\.set\('endDate'/)
    expect(commitBody).not.toMatch(/\.set\('range'/)
  })
})
