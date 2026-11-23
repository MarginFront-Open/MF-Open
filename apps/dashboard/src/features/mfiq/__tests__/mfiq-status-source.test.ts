/**
 * Mfiq-status.ts is composition glue, proven
 * at the source level (jest is node-only; the 'use server' export landmine is
 * invisible to tsc/jest at runtime, so we grep for it — the
 * finops-close-status-source.test.ts pattern). The DB-gated half (facts
 * deep-equal the composed reads against a seeded org) lives in
 * app/actions/__tests__/mfiq-status.integration.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const actionSrc = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'app', 'actions', 'mfiq-status.ts'),
  'utf8'
)

const derivationSrc = readFileSync(
  join(__dirname, '..', 'iq-derivation.ts'),
  'utf8'
)

describe('mfiq-status.ts — composes exactly the six shipped reads', () => {
  it("is a 'use server' file", () => {
    expect(actionSrc.startsWith("'use server'")).toBe(true)
  })

  it.each([
    ['getFinopsCloseStatus', './finops-close-status'],
    ['getPeriodLockStatus', './finance-period-lock'],
    ['getBuildAgentsOverview', './build-agents-overview'],
    ['getNeedsCostBackfillGroups', './signal-events'],
    ['getMissingVolumeGroups', './signal-events'],
    // The sixth — the SAME read the needs-attention page's
    // credit-pool section uses, so the two counts cannot disagree.
    ['getExhaustedCreditPools', './credit-pools'],
  ])('imports %s from %s', (name, module_) => {
    const importRegex = new RegExp(
      `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'${module_.replace('/', '\\/')}'`,
      's'
    )
    expect(actionSrc).toMatch(importRegex)
  })

  it('imports monthPeriod — windows are pinned inside the zero-param action', () => {
    expect(actionSrc).toMatch(
      /import\s*\{[^}]*\bmonthPeriod\b[^}]*\}\s*from\s*'@\/features\/_shared\/billing-period'/
    )
    expect(actionSrc).toMatch(
      /export async function getMfiqStatus\(\): Promise/
    )
  })

  it('composes via Promise.allSettled — never Promise.all (one failing domain must not blank the page)', () => {
    expect(actionSrc).toMatch(/Promise\.allSettled\(/)
    expect(actionSrc).not.toMatch(/Promise\.all\(/)
  })

  it('never imports or calls resolveMetrics — MF IQ facts do not come from the resolver', () => {
    expect(actionSrc).not.toMatch(
      /import\s*(?:type\s*)?\{[^}]*\bresolveMetrics\b[^}]*\}\s*from/
    )
    expect(actionSrc).not.toMatch(/\bresolveMetrics\s*\(/)
  })

  it('adds no SQL of its own — no PrismaClient, no db import, no @marginfront/db', () => {
    expect(actionSrc).not.toMatch(/PrismaClient/)
    expect(actionSrc).not.toMatch(/from\s*'@\/app\/lib\/db'/)
    expect(actionSrc).not.toMatch(/\bdb\./)
    expect(actionSrc).not.toMatch(/@marginfront\/db/)
  })

  it('never touches the per-event earned math or the command-center assembly', () => {
    expect(actionSrc).not.toMatch(/earnedForEvent/)
    expect(actionSrc).not.toMatch(/getFullCommandCenter/)
  })

  it('formats no money — no .toFixed (display is canon-format, downstream)', () => {
    expect(actionSrc).not.toMatch(/\.toFixed\(/)
  })
})

describe("mfiq-status.ts — 'use server' export landmine (only async functions + type declarations)", () => {
  it('has no export const', () => {
    expect(actionSrc).not.toMatch(/export const /)
  })

  it('has no non-async export function', () => {
    expect(actionSrc).not.toMatch(/export function /)
  })

  it('has no re-export — the `export { X } from` / `export type { X } from` shape crashes every action in the page bundle at runtime', () => {
    expect(actionSrc).not.toMatch(/export\s+(type\s+)?\{[^}]*\}\s*from/)
    expect(actionSrc).not.toMatch(/export \*/)
  })

  it('has no default export', () => {
    expect(actionSrc).not.toMatch(/export default/)
  })

  it('exports the one action', () => {
    expect(actionSrc).toMatch(/export async function getMfiqStatus/)
  })
})

describe('iq-derivation.ts — pure module, shared conventions never forked', () => {
  it('imports closeDeadline from close-derivation — R5 and the FinOps checklist share ONE deadline arithmetic', () => {
    expect(derivationSrc).toMatch(
      /import\s*\{[^}]*\bcloseDeadline\b[^}]*\}\s*from\s*'@\/features\/finops\/close-derivation'/
    )
  })

  it('imports the shared needs-attention builders — copy has one home', () => {
    expect(derivationSrc).toMatch(
      /import\s*\{[^}]*\bmismatchedSignalsItem\b[^}]*\bcostBackfillItem\b[^}]*\bmissingVolumeItem\b[^}]*\bcreditPoolItem\b[^}]*\}\s*from\s*'@\/features\/dashboard-shell\/needs-attention'/s
    )
  })

  it('spells no credit-pool copy of its own — the row comes from creditPoolItem', () => {
    expect(derivationSrc).toMatch(/creditPoolItem\(lowCreditPools\)/)
    expect(derivationSrc).not.toMatch(/running low/)
  })

  // The href assertion lives elsewhere on purpose: it is owned
  // by dashboard-shell/__tests__/needs-attention.test.ts and behavior-pinned
  // in iq-derivation.test.ts.
  it('does not fork the credit-pool href — it takes the builder unmodified', () => {
    expect(derivationSrc).not.toMatch(/tab=credit-pools/)
    expect(derivationSrc).toMatch(
      /needsAttention\.push\(creditPoolItem\(lowCreditPools\)\)/
    )
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

  it('never touches the resolver or per-event earned math', () => {
    expect(derivationSrc).not.toMatch(/resolveMetrics/)
    expect(derivationSrc).not.toMatch(/earnedForEvent/)
  })

  it('formats no money by hand — no .toFixed; canon-format only', () => {
    expect(derivationSrc).not.toMatch(/\.toFixed\(/)
    expect(derivationSrc).toMatch(
      /import\s*\{[^}]*\bformatCost\b[^}]*\}\s*from\s*'@\/lib\/canon-format'/
    )
  })
})

// The model-count facts must come from groups.length, never from
// totalEvents. Swapping them renders "38 models need cost backfill (38
// events)" and nothing else fails, so the mapping is pinned at the source.
describe('model-count facts map from groups.length', () => {
  it('backfillModels reads backfill.groups.length', () => {
    expect(actionSrc).toMatch(
      /backfillModels:\s*backfill\s*\?\s*backfill\.groups\.length\s*:\s*null/
    )
  })

  it('missingVolumeModels reads missingVolume.groups.length', () => {
    expect(actionSrc).toMatch(
      /missingVolumeModels:\s*missingVolume\s*\?\s*missingVolume\.groups\.length\s*:\s*null/
    )
  })
})
