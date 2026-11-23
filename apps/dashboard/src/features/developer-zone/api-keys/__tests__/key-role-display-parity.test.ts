import { mintableKeyRoles as clientPortImpl } from '../key-role-display'
import { mintableKeyRoles as dbCanonImpl } from '@marginfront/db'

/**
 * Anti-drift lock for the client-safe mintableKeyRoles port.
 *
 * key-role-display.ts carries a hand-port of MINTABLE_KEY_ROLES /
 * mintableKeyRoles from packages/db/src/lib/org-roles.ts. The client bundle
 * can't value-import @marginfront/db without dragging Prisma + node:fs into the
 * browser, where it crashes at runtime. Jest runs in Node, so
 * BOTH impls are importable here — this test asserts they agree for every
 * minter role so the copy can never silently drift from the source of truth.
 * Same pattern as canon-format-safe-margin.test.ts.
 */
describe('mintableKeyRoles — key-role-display port matches @marginfront/db exactly', () => {
  const minterRoles = ['owner', 'admin', 'developer', 'finance', 'member']

  it.each(minterRoles)('minter role %s — both impls agree', (minterRole) => {
    expect(clientPortImpl(minterRole)).toEqual(dbCanonImpl(minterRole))
  })

  it('unknown role fails closed to [] in both', () => {
    expect(clientPortImpl('intruder')).toEqual([])
    expect(dbCanonImpl('intruder')).toEqual([])
  })

  it('empty string fails closed to [] in both', () => {
    expect(clientPortImpl('')).toEqual([])
    expect(dbCanonImpl('')).toEqual([])
  })
})
