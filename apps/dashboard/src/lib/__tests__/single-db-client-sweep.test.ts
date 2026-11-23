/**
 * Each `new PrismaClient()` opens its own connection pool, so server code must
 * use the shared client from `@/app/lib/db`. Zero server files are exempt.
 */
import { readFileSync, readdirSync, lstatSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '../../..')
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  '__tests__',
  'playwright',
  'scripts',
  '.git',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue
    const full = join(dir, entry)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) walk(full, out)
    else if (
      /\.(?:[cm]?js|tsx?)$/.test(entry) &&
      !/\.(?:test|spec)\.(?:[cm]?js|tsx?)$/.test(entry)
    )
      out.push(full)
  }
  return out
}

describe('single db client sweep', () => {
  it('no server file creates its own PrismaClient', () => {
    const offenders = walk(ROOT)
      .map((abs) => relative(ROOT, abs).split('\\').join('/'))
      .filter((rel) =>
        /new PrismaClient\s*\(/.test(readFileSync(join(ROOT, rel), 'utf8'))
      )
    expect(offenders).toEqual([])
  })
})
