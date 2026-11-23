import { readFileSync } from 'fs'
import { join } from 'path'

import { CCC_INIT_COMMAND } from '@/features/internal-ai-spend/install-kit'

/**
 * The walkthrough and the install kit must give the same install command,
 * and the labels here must say "AI spend".
 *
 * Node-only jest (no RTL), so the JSX is asserted against its source the way
 * setup-method-ccc.test.ts does; the command string itself is a real import.
 */
const gettingStartedSrc = readFileSync(
  join(__dirname, '..', 'index.tsx'),
  'utf8'
)

describe('Getting Started CCC tab — the install command', () => {
  it('builds the meter from source, never from a package registry', () => {
    expect(CCC_INIT_COMMAND).toContain(
      'npx turbo run build --filter=@marginfront/code-cost-clarity'
    )
    expect(CCC_INIT_COMMAND).toMatch(
      /&& node packages\/code-cost-clarity\/dist\/cli\.js init$/
    )
  })

  it('leaves no registry install line anywhere in the walkthrough', () => {
    expect(gettingStartedSrc).not.toMatch(
      /npx @marginfront|npm install @marginfront/
    )
    expect(gettingStartedSrc).not.toContain('marginfront.com')
  })

  it('uses the shared constant at all four command sites', () => {
    expect(gettingStartedSrc).toMatch(
      /import \{[\s\S]*?CCC_INIT_COMMAND[\s\S]*?\} from '@\/features\/internal-ai-spend\/install-kit'/
    )
    const uses = gettingStartedSrc.split('CCC_INIT_COMMAND').length - 1
    expect(uses).toBeGreaterThanOrEqual(5)
  })
})

describe('Getting Started CCC tab — the metric label', () => {
  it('calls the metric "AI spend"', () => {
    expect(gettingStartedSrc).toContain(
      '<CardTitle>AI spend (Code Cost Clarity)</CardTitle>'
    )
    expect(gettingStartedSrc).toContain("label: 'AI spend',")
  })

  it('never says "Coding-agent spend"', () => {
    expect(gettingStartedSrc).not.toContain('Coding-agent spend')
  })
})
