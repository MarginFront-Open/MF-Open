/**
 * Build-agents-overview.ts is composition glue, checked at the source level.
 * Jest is node-only, and a 'use server' file that exports a non-async value
 * fails only at runtime, which tsc and jest can't see, so these tests grep
 * the source (same pattern as finops-close-status-source.test.ts). The DB-gated half (Σ rows
 * ≡ resolveMetrics scope-build tiles against a seeded org) lives in
 * app/actions/__tests__/build-agents-reconciliation.integration.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const actionSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    'actions',
    'build-agents-overview.ts'
  ),
  'utf8'
)

const derivationSrc = readFileSync(
  join(__dirname, '..', 'agents-derivation.ts'),
  'utf8'
)

describe('build-agents-overview.ts — composes exactly the three canon reads', () => {
  it("is a 'use server' file", () => {
    expect(actionSrc.startsWith("'use server'")).toBe(true)
  })

  it('imports getCostBreakdown, getAgentEarned, and ANALYTICS_MAX_ROWS from @marginfront/db', () => {
    const importRegex =
      /import\s*\{[^}]*\bgetCostBreakdown\b[^}]*\bgetAgentEarned\b[^}]*\bANALYTICS_MAX_ROWS\b[^}]*\}\s*from\s*'@marginfront\/db'/s
    expect(actionSrc).toMatch(importRegex)
  })

  it('imports the pure derivation from @/features/build/agents-derivation', () => {
    expect(actionSrc).toMatch(
      /import\s*\{[^}]*\bderiveAgentRows\b[^}]*\}\s*from\s*'@\/features\/build\/agents-derivation'/
    )
  })

  it('never imports or calls resolveMetrics — per-agent values do not come from the resolver', () => {
    expect(actionSrc).not.toMatch(
      /import\s*(?:type\s*)?\{[^}]*\bresolveMetrics\b[^}]*\}\s*from/
    )
    expect(actionSrc).not.toMatch(/\bresolveMetrics\s*\(/)
  })

  it('never touches the demoted per-event earned math', () => {
    expect(actionSrc).not.toMatch(/earnedForEvent/)
    expect(actionSrc).not.toMatch(/per-event-earned/)
    expect(actionSrc).not.toMatch(/getFullCommandCenter/)
    expect(actionSrc).not.toMatch(/getAgentEarningsBreakdown/)
  })

  it('requests every bucket in one page with the rollup off — includeOtherRollup: false + pageSize: ANALYTICS_MAX_ROWS', () => {
    expect(actionSrc).toMatch(/includeOtherRollup:\s*false/)
    expect(actionSrc).toMatch(/pageSize:\s*ANALYTICS_MAX_ROWS/)
  })

  it('bounds the agents inventory read (no unbounded findMany)', () => {
    expect(actionSrc).toMatch(/AGENTS_INVENTORY_MAX = 500/)
    expect(actionSrc).toMatch(/take:\s*AGENTS_INVENTORY_MAX/)
  })

  it('errors loudly past the breakdown cap instead of silently truncating', () => {
    expect(actionSrc).toMatch(/totalRowCount\s*>\s*ANALYTICS_MAX_ROWS/)
  })

  it("scopes reads to the session's active org", () => {
    expect(actionSrc).toMatch(
      /const orgId = session\.session\.activeOrganizationId/
    )
  })

  it('formats no money — no .toFixed anywhere (display is canon-format, downstream)', () => {
    expect(actionSrc).not.toMatch(/\.toFixed\(/)
  })
})

describe("build-agents-overview.ts — 'use server' export landmine (only async functions + type declarations)", () => {
  it('has no export const', () => {
    expect(actionSrc).not.toMatch(/export const /)
  })

  it('has no non-async export function', () => {
    expect(actionSrc).not.toMatch(/export function /)
  })

  it('has no re-export — the `export { X } from` / `export type { X } from` shape crashes every action in the page bundle at runtime (the 7cc3e33f landmine)', () => {
    expect(actionSrc).not.toMatch(/export\s+(type\s+)?\{[^}]*\}\s*from/)
    expect(actionSrc).not.toMatch(/export \*/)
  })

  it('has no default export', () => {
    expect(actionSrc).not.toMatch(/export default/)
  })

  it('exports the one action', () => {
    expect(actionSrc).toMatch(/export async function getBuildAgentsOverview/)
  })
})

describe('agents-derivation.ts — pure module, canon margin helper only', () => {
  it("imports safeMarginPercent from the client-safe canon-format port (never inline (a−b)/a — the canon lint bans the shape; never a value import of @marginfront/db — that's the node:fs browser crash)", () => {
    expect(derivationSrc).toMatch(
      /import\s*\{[^}]*\bsafeMarginPercent\b[^}]*\}\s*from\s*'@\/lib\/canon-format'/
    )
    expect(derivationSrc).toMatch(/safeMarginPercent\(/)
  })

  it('fetches nothing — no PrismaClient, no db import, no action value-imports', () => {
    expect(derivationSrc).not.toMatch(/PrismaClient/)
    expect(derivationSrc).not.toMatch(/from\s*'@\/app\/lib\/db'/)
    // Type-only imports from the 'use server' action are fine (erased at
    // build); a VALUE import would drag the action into every consumer.
    expect(derivationSrc).not.toMatch(
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/actions/
    )
  })

  it('never touches per-event earned math or the resolver', () => {
    expect(derivationSrc).not.toMatch(/earnedForEvent/)
    expect(derivationSrc).not.toMatch(/resolveMetrics/)
  })

  it('formats no money — no .toFixed', () => {
    expect(derivationSrc).not.toMatch(/\.toFixed\(/)
  })
})
