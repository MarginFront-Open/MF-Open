/**
 * Tests for the shared grant matrix (canGrantRole / GRANTABLE_ROLES) in @marginfront/db.
 *
 * This is the ONE helper that decides "may an actor with role X hand out role Y?", used by
 * add-member, send-invitation, and update-member-role. These tests drive the REAL function
 * (no stubs — it's pure) across every actor x target combination so the locked policy is
 * pinned down cell by cell, and a future edit that loosens it fails loudly here.
 */

import { canGrantRole, GRANTABLE_ROLES } from '@marginfront/db';

const ROLES = ['owner', 'admin', 'finance', 'developer', 'legal', 'member'] as const;

// The locked policy, written out as a truth table so the test reads like the spec.
// true = the actor (row) is allowed to grant the target role (column).
// owner/admin may grant 'developer'; finance/member cannot; and a developer-as-actor grants
// NOTHING (the whole row is false), because the build/operations seat does not manage the team.
// 'legal' has the same shape: owner/admin may grant it, and a legal-as-actor grants NOTHING
// (the matter seat does not manage the team).
const EXPECTED: Record<string, Record<string, boolean>> = {
  owner: { owner: true, admin: true, finance: true, developer: true, legal: true, member: true },
  admin: { owner: false, admin: true, finance: true, developer: true, legal: true, member: true },
  finance: {
    owner: false,
    admin: false,
    finance: true,
    developer: false,
    legal: false,
    member: true,
  },
  developer: {
    owner: false,
    admin: false,
    finance: false,
    developer: false,
    legal: false,
    member: false,
  },
  legal: {
    owner: false,
    admin: false,
    finance: false,
    developer: false,
    legal: false,
    member: false,
  },
  member: {
    owner: false,
    admin: false,
    finance: false,
    developer: false,
    legal: false,
    member: true,
  },
};

describe('canGrantRole — locked grant matrix', () => {
  for (const actor of ROLES) {
    for (const target of ROLES) {
      const expected = EXPECTED[actor][target];
      it(`${actor} ${expected ? 'CAN' : 'CANNOT'} grant ${target}`, () => {
        expect(canGrantRole(actor, target)).toBe(expected);
      });
    }
  }

  // "Only an owner can grant owner" must fall out of the matrix automatically.
  it('owner is the ONLY role whose set contains owner', () => {
    const grantsOwner = ROLES.filter((r) => canGrantRole(r, 'owner'));
    expect(grantsOwner).toEqual(['owner']);
  });

  // Admin can never grant owner — the single most important "no".
  it('admin can never grant owner', () => {
    expect(canGrantRole('admin', 'owner')).toBe(false);
  });

  // 'developer' is a KNOWN role that grants nothing (its
  // allowed-set is []). This is distinct from an UNKNOWN role, which also grants
  // nothing but via the `?? []` fail-closed path.
  it('a developer grants no role at all (known role, empty set)', () => {
    expect(canGrantRole('developer', 'member')).toBe(false);
    expect(canGrantRole('developer', 'developer')).toBe(false);
    expect(canGrantRole('developer', 'owner')).toBe(false);
  });

  // owner/admin CAN grant developer; finance/member CANNOT.
  it('only owner and admin can grant developer', () => {
    expect(canGrantRole('owner', 'developer')).toBe(true);
    expect(canGrantRole('admin', 'developer')).toBe(true);
    expect(canGrantRole('finance', 'developer')).toBe(false);
    expect(canGrantRole('member', 'developer')).toBe(false);
  });

  // Same shape for the matter seat.
  it('only owner and admin can grant legal, and legal grants nothing', () => {
    expect(canGrantRole('owner', 'legal')).toBe(true);
    expect(canGrantRole('admin', 'legal')).toBe(true);
    expect(canGrantRole('finance', 'legal')).toBe(false);
    expect(canGrantRole('member', 'legal')).toBe(false);
    expect(canGrantRole('legal', 'member')).toBe(false);
    expect(canGrantRole('legal', 'legal')).toBe(false);
  });

  // FAIL CLOSED: an unknown / empty actor role grants nothing.
  it('unknown actor role grants nothing', () => {
    expect(canGrantRole('', 'member')).toBe(false);
    expect(canGrantRole('superuser', 'owner')).toBe(false);
  });

  // FAIL CLOSED: an unknown target role is never grantable, even by an owner.
  it('unknown target role is never grantable', () => {
    expect(canGrantRole('owner', 'superuser')).toBe(false);
    expect(canGrantRole('owner', '')).toBe(false);
  });

  // The map shape itself matches the policy (catches an accidental key rename/removal).
  it('GRANTABLE_ROLES has exactly the six current roles, incl developer and legal', () => {
    expect(Object.keys(GRANTABLE_ROLES).sort()).toEqual(
      ['admin', 'developer', 'finance', 'legal', 'member', 'owner'].sort(),
    );
    // developer and legal are present and grant nothing.
    expect(GRANTABLE_ROLES).toHaveProperty('developer');
    expect(GRANTABLE_ROLES.developer).toEqual([]);
    expect(GRANTABLE_ROLES).toHaveProperty('legal');
    expect(GRANTABLE_ROLES.legal).toEqual([]);
  });
});
