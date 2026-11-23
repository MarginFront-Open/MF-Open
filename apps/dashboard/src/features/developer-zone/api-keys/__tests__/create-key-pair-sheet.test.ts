/**
 * create-key-pair-sheet.tsx: the mint dialog's role selector. The creation
 * flow must teach the difference at mint time and grayed-out roles must say
 * WHY. Source-assertion (this repo's jest is node-only, no RTL): the
 * behavioral rules here (default-to-floor, ceiling from mintableKeyRoles,
 * teaching copy wired in) are requirements, not polish.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(
  join(__dirname, '..', 'create-key-pair-sheet.tsx'),
  'utf8'
)

describe('create-key-pair-sheet.tsx — role selector capped at the minter ceiling', () => {
  it('computes the mint ceiling from mintableKeyRoles(organization.role)', () => {
    // The value comes from the client-safe port in key-role-display, NOT
    // @marginfront/db — a value import there drags Prisma + node:fs into the
    // browser bundle (see src/__tests__/no-client-value-imports-of-marginfront-db).
    expect(src).toMatch(/import type \{ KeyRole \} from '@marginfront\/db'/)
    expect(src).toMatch(
      /import \{[^}]*\bmintableKeyRoles\b[^}]*\} from '\.\/key-role-display'/
    )
    expect(src).toMatch(/mintableKeyRoles\(organization\?\.role \?\? ''\)/)
  })

  it('defaults the selection to the least-privilege role via defaultMintRole', () => {
    expect(src).toMatch(/defaultMintRole\(mintableRoles\)/)
  })

  it('renders every role option with its teaching copy, and the unavailable ones with a reason', () => {
    expect(src).toMatch(/KEY_ROLE_ORDER\.map\(/)
    expect(src).toMatch(
      /unavailableRoleReason\(\s*roleOption,\s*organization\?\.role\s*\)/
    )
    expect(src).toMatch(/KEY_ROLE_TEACHING_COPY\[roleOption\]/)
  })

  it("renders the selected role's detail lines under the group", () => {
    // The ingest write's blast radius and leak consequence live in
    // KEY_ROLE_DETAIL_LINES so the six option labels stay one line each. If this
    // block is dropped, the option copy alone stops naming the write's
    // consequences and the mint sheet under-states what a leaked key costs.
    expect(src).toMatch(
      /import \{[^}]*\bKEY_ROLE_DETAIL_LINES\b[^}]*\} from '\.\/key-role-display'/
    )
    expect(src).toMatch(/KEY_ROLE_DETAIL_LINES\[selectedRole\]/)
    expect(src).toMatch(/KEY_ROLE_DETAIL_LINES\[selectedRole\]\?\.map\(/)
  })

  it('disables the RadioGroupItem for unavailable roles — never lets you pick a role the server would refuse', () => {
    expect(src).toMatch(/disabled=\{isUnavailable\}/)
  })

  it('states the separation-of-duties line (Developer vs Finance)', () => {
    expect(src).toMatch(/Developer key can generate usage but can never touch/)
  })

  it('passes the selected role into the mint mutation', () => {
    expect(src).toMatch(
      /createKeyPairMutation\.mutate\(\s*\{ \.\.\.newKeyPair, role: selectedRole \}/
    )
  })

  it('the Create button is disabled when no role is selected (defensive — the door should already be gated)', () => {
    expect(src).toMatch(
      /!selectedRole \|\|\s*\n\s*createKeyPairMutation\.isPending/
    )
  })

  it('resets the picked role when the sheet closes, so the next open re-defaults', () => {
    expect(src).toMatch(/setPickedRole\(null\)/)
  })

  it('the sheet scrolls — its content is taller than a laptop viewport, so without overflow-y-auto the Create button is unreachable', () => {
    expect(src).toMatch(/<SheetContent[^>]*className='[^']*overflow-y-auto/)
  })
})
