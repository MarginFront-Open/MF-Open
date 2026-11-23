import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The first-event nudge on the Unit Economics page
 * (source-assertion, node-only jest, no RTL; same pattern as
 * repo-spend-wiring.test.ts). Unit Economics (/money) is the default landing
 * for finance/admin/owner, so a zero-event org must see the path to
 * instrumentation there, not only on Build.
 */
const moneySrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
const nudgeSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'build',
    'components',
    'getting-started-nudge.tsx'
  ),
  'utf8'
)
const buildSrc = readFileSync(
  join(__dirname, '..', '..', 'build', 'index.tsx'),
  'utf8'
)

describe('Unit Economics first-event nudge', () => {
  it('renders the shared GettingStartedNudge above the tab bar', () => {
    expect(moneySrc).toMatch(
      /import \{ GettingStartedNudge \} from '@\/features\/build\/components\/getting-started-nudge'/
    )
    const nudgeIndex = moneySrc.indexOf('<GettingStartedNudge')
    const tabsIndex = moneySrc.indexOf('<Tabs value=')
    expect(nudgeIndex).toBeGreaterThan(-1)
    expect(tabsIndex).toBeGreaterThan(-1)
    expect(nudgeIndex).toBeLessThan(tabsIndex)
  })

  it('passes page-specific copy while Build keeps the default', () => {
    expect(moneySrc).toMatch(/<GettingStartedNudge description=/)
    expect(nudgeSrc).toMatch(/description = '/)
    expect(buildSrc).toMatch(/<GettingStartedNudge \/>/)
  })
})
