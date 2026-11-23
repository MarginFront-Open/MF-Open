import { readdirSync } from 'fs'
import { join, relative } from 'path'

/**
 * Keeps unauthenticated diagnostics off the deployed app: no route or page in
 * a debug-named segment (one can leak env and DB state), and the public /api/ping says only "ok".
 */
const APP_DIR = join(__dirname, '..', '..')

const ROUTE_FILE = /^(route|page)\.(t|j)sx?$/

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(full))
    else if (ROUTE_FILE.test(entry.name)) out.push(relative(APP_DIR, full))
  }
  return out
}

describe('app/ — no debug routes are deployed', () => {
  const files = routeFiles(APP_DIR)

  it('finds route files to check (guards against a silently-empty suite)', () => {
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain(join('api', 'ping', 'route.ts'))
  })

  it('has no route or page under a debug-named segment', () => {
    // Route groups `(x)` and dynamic `[x]` segments are matched on their
    // inner name, so `(debug)` or `[debug-id]` would be caught too.
    const debug = files.filter((f) =>
      f
        .split(/[\\/]/)
        .slice(0, -1)
        .some((segment) => /^[([]*debug/i.test(segment))
    )
    expect(debug).toEqual([])
  })
})

describe('GET /api/ping', () => {
  it('returns only { status: "ok" }', async () => {
    const { GET } = await import('../ping/route')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
