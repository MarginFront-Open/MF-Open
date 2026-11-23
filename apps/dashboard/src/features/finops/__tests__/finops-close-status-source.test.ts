/**
 * Finops-close-status.ts is composition glue, checked at the source level.
 * Jest is node-only, and a 'use server' file with an illegal export fails
 * only at runtime, which tsc and jest can't see, so these tests grep the
 * source. The DB-gated half (facts deep-equal the composed reads against a
 * seeded org) lives in
 * app/actions/__tests__/finops-close-status.integration.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    'actions',
    'finops-close-status.ts'
  ),
  'utf8'
)

describe('finops-close-status.ts — composes exactly the four close-engine reads', () => {
  it("is a 'use server' file", () => {
    expect(src.startsWith("'use server'")).toBe(true)
  })

  it.each([
    ['getPeriodLockStatus', './finance-period-lock'],
    ['getDefensibilityScore', './finance-metrics'],
    ['getJournalExport', './journal-export'],
    ['getMismatchedSignalCount', './chart-of-accounts'],
  ])('imports %s from %s', (name, module_) => {
    const importRegex = new RegExp(
      `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'${module_}'`
    )
    expect(src).toMatch(importRegex)
  })

  it('never imports or calls resolveMetrics — close values do not come from the resolver', () => {
    // Same two shapes money's no-direct-resolver.test.ts bans.
    expect(src).not.toMatch(
      /import\s*(?:type\s*)?\{[^}]*\bresolveMetrics\b[^}]*\}\s*from/
    )
    expect(src).not.toMatch(/\bresolveMetrics\s*\(/)
  })

  it('adds no SQL of its own — no PrismaClient, no db import', () => {
    expect(src).not.toMatch(/PrismaClient/)
    expect(src).not.toMatch(/from\s*'@\/app\/lib\/db'/)
    expect(src).not.toMatch(/\bdb\./)
  })
})

describe("finops-close-status.ts — 'use server' export landmine (only async functions + type declarations)", () => {
  it('has no export const', () => {
    expect(src).not.toMatch(/export const /)
  })

  it('has no non-async export function', () => {
    // 'export function' would be a sync export; only 'export async function'
    // is legal in a 'use server' file.
    expect(src).not.toMatch(/export function /)
  })

  it('has no re-export — the `export { X } from` / `export type { X } from` shape crashes every action in the page bundle at runtime', () => {
    expect(src).not.toMatch(/export\s+(type\s+)?\{[^}]*\}\s*from/)
    expect(src).not.toMatch(/export \*/)
  })

  it('has no default export', () => {
    expect(src).not.toMatch(/export default/)
  })

  it('exports the one action', () => {
    expect(src).toMatch(/export async function getFinopsCloseStatus/)
  })
})
