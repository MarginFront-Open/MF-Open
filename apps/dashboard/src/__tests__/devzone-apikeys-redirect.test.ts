import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

/**
 * /developer-zone/api-keys only redirects; the Build page's keys tab
 * (/build?tab=keys) is the ONE key-management surface. Two things must stay
 * true:
 *
 * 1. next.config.ts keeps the redirect, so existing links never 404.
 * 2. No app/src source file navigates to that route: every link, push,
 *    or location assignment goes straight to /build?tab=keys instead of
 *    bouncing through the redirect.
 *
 * Source-assertion (this repo's dashboard jest is node-only, no RTL).
 * Comment mentions of the path are fine — only quoted string literals
 * (href='...', router.push('...'), window.location.href = '...') and
 * full-URL forms count as navigation. Imports of the KEPT feature modules
 * ('@/features/developer-zone/api-keys/...') don't match: the route path
 * starts with a quote then a slash.
 */

const DASHBOARD_ROOT = join(__dirname, '..', '..')

const REDIRECT_ONLY_ROUTE_LITERAL = /['"`]\/developer-zone\/api-keys/
const REDIRECT_ONLY_ROUTE_URL =
  /https?:\/\/[^\s'"`/]+\/developer-zone\/api-keys/

function navigatesToRedirectOnlyRoute(source: string): boolean {
  return (
    REDIRECT_ONLY_ROUTE_LITERAL.test(source) ||
    REDIRECT_ONLY_ROUTE_URL.test(source)
  )
}

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(fullPath))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      files.push(fullPath)
    }
  }
  return files
}

describe('the scanner itself understands navigation vs. mention', () => {
  it('flags every navigation form', () => {
    const violations = [
      "window.location.href = '/developer-zone/api-keys'",
      'href="/developer-zone/api-keys"',
      "router.push('/developer-zone/api-keys')",
      'fetch(`/developer-zone/api-keys`)',
      '"https://app.example.com/developer-zone/api-keys"',
    ]
    for (const snippet of violations) {
      expect(navigatesToRedirectOnlyRoute(snippet)).toBe(true)
    }
  })

  it('ignores comment mentions and imports of the kept feature modules', () => {
    const fine = [
      '// bouncing to /developer-zone/api-keys is only a redirect',
      ' * parity with /developer-zone/api-keys — the surface it replaced',
      "import { CreateKeyPairSheet } from '@/features/developer-zone/api-keys/create-key-pair-sheet'",
      "} from '@/features/developer-zone/api-keys/key-role-display'",
    ]
    for (const snippet of fine) {
      expect(navigatesToRedirectOnlyRoute(snippet)).toBe(false)
    }
  })
})

describe('/developer-zone/api-keys is a redirect only', () => {
  it('next.config.ts 307-redirects /developer-zone/api-keys to /build?tab=keys', () => {
    const nextConfig = readFileSync(
      join(DASHBOARD_ROOT, 'next.config.ts'),
      'utf8'
    )
    expect(nextConfig).toMatch(
      /\{\s*source:\s*'\/developer-zone\/api-keys',\s*destination:\s*'\/build\?tab=keys',\s*permanent:\s*false,?\s*\}/
    )
  })

  it('no app/ or src/ source file (tests excluded) navigates to the redirect-only route', () => {
    const violations: string[] = []
    for (const root of ['app', 'src']) {
      for (const file of sourceFilesUnder(join(DASHBOARD_ROOT, root))) {
        if (navigatesToRedirectOnlyRoute(readFileSync(file, 'utf8'))) {
          violations.push(relative(DASHBOARD_ROOT, file))
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `${violations.length} file(s) still navigate to the redirect-only ` +
          `/developer-zone/api-keys route:\n\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          `
          
          The Build page's keys tab is ` +
          `the one key-management surface. Point the link at '/build?tab=keys' ` +
          `instead of going through the redirect.`
      )
    }
  })
})
