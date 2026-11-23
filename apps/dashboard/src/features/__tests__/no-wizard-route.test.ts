import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * The only create-agent flow is /agents/new
 * (src/features/agents/new-agent.tsx). These checks fail if a second
 * /wizard/agent route or a features/wizards directory appears.
 */

const APP_DIR = join(__dirname, '..', '..', '..', 'app')
const SRC_DIR = join(__dirname, '..', '..')

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('there is no /wizard/agent create flow', () => {
  it('there is no /wizard route', () => {
    expect(existsSync(join(APP_DIR, '(dashboard)', 'wizard'))).toBe(false)
  })

  it('there is no src/features/wizards/ directory', () => {
    expect(existsSync(join(SRC_DIR, 'features', 'wizards'))).toBe(false)
  })

  it('no source file under app/ or src/ imports or links /wizard/agent', () => {
    const offenders = [
      ...walkSourceFiles(APP_DIR),
      ...walkSourceFiles(SRC_DIR),
    ].filter((f) => {
      const contents = readFileSync(f, 'utf8')
      return (
        /\/wizard\/agent/.test(contents) ||
        /features\/wizards\/agent/.test(contents)
      )
    })
    expect(offenders).toEqual([])
  })

  it("middleware's protected-routes list does not reserve a /wizard prefix", () => {
    const middlewareSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'middleware.ts'),
      'utf8'
    )
    expect(middlewareSrc).not.toMatch(/'\/wizard'/)
  })
})
