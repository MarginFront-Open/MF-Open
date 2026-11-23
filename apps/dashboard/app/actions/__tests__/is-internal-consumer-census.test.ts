import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

/**
 * Locks the canon constraint behind the customer ↔ internal
 * flip: `isInternal` classifies a record for the internal/external COST
 * split only. Revenue, MRR, invoice, and margin math must never read it
 * (C1 cost totals, R1/R2, MRR1-3, I2/I3 all deliberately ignore the flag;
 * see the isInternal field on customers in packages/db/prisma/schema.prisma).
 *
 * Enforced as a census: every file under app/actions/ that mentions
 * isInternal must be on the explicit allowlist below. A revenue action
 * gaining the flag fails this test; a NEW legitimate consumer (another
 * cost-split surface) is added to the list consciously, in a reviewed diff.
 */
const ACTIONS_DIR = join(__dirname, '..')

// The complete legitimate set:
//   get-filters.ts                        — feeds the Users tab the flag
//   customers.ts                          — the flip write path
//   _shared/initiative-actuals.ts         — ROI internal/external cost split
//   _shared/initiative-metric-values.ts   — ROI internal/external cost split
const ALLOWED_IS_INTERNAL_FILES = [
  'customers.ts',
  'get-filters.ts',
  '_shared/initiative-actuals.ts',
  '_shared/initiative-metric-values.ts',
].sort()

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('app/actions/** — isInternal never leaks into revenue/MRR/invoice math', () => {
  const files = walk(ACTIONS_DIR)

  it('has action files to check (guards against a silently-empty suite)', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('only the allowlisted cost-split + write-path files mention isInternal', () => {
    const mentioning = files
      .filter((f) => /\bisInternal\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ACTIONS_DIR, f))
      .sort()
    expect(mentioning).toEqual(ALLOWED_IS_INTERNAL_FILES)
  })
})
