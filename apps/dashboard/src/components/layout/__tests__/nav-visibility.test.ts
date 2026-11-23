/**
 * Sidebar visibility rules for the finance/FinOps role.
 *
 * This repo's dashboard jest runs in a NODE environment and only matches
 * *.test.ts (see apps/dashboard/jest.config.ts) — it does NOT render React
 * components or client hooks (useSidebar / useAuth). So, like the
 * SetupMethodModal test, this doesn't render <NavGroup>. It tests
 * the pure function it delegates to — getVisibleNavItems in
 * ../nav-visibility.ts — which is the single source of the role rules.
 *
 * The behavior this guards: FinOps items (requiredRoles: finance/admin/owner) are visible to
 * finance/admin/owner and HIDDEN from a plain member.
 */

import { getVisibleNavItems, resolveCurrentUserRole } from '../nav-visibility'
import type { NavItem } from '../types'

// A representative slice of the real sidebar:
//  - operate:    no role restriction -> always visible
//  - finopsCost: requiredRoles       -> the FinOps gate
const operate: NavItem = { title: 'Command Center', url: '/build' }
const finopsCost: NavItem = {
  title: 'Cost Management',
  url: '/cost-management',
  requiredRoles: ['finance', 'admin', 'owner'] as const,
}

const ALL: NavItem[] = [operate, finopsCost]

// Convenience: collect the titles that survive the filter, for clean asserts.
const visibleTitles = (items: NavItem[], role: string | undefined) =>
  getVisibleNavItems(items, role).map((i) => i.title)

describe('getVisibleNavItems — finance/FinOps visibility', () => {
  it('finance sees Command Center + FinOps', () => {
    const titles = visibleTitles(ALL, 'finance')
    expect(titles).toEqual(['Command Center', 'Cost Management'])
  })

  it('a plain member sees Command Center but NOT FinOps', () => {
    const titles = visibleTitles(ALL, 'member')
    expect(titles).toContain('Command Center')
    expect(titles).not.toContain('Cost Management') // FinOps hidden from member
  })

  it('admin sees FinOps', () => {
    const titles = visibleTitles(ALL, 'admin')
    expect(titles).toContain('Cost Management')
  })

  it('owner sees FinOps', () => {
    const titles = visibleTitles(ALL, 'owner')
    expect(titles).toContain('Cost Management')
  })

  // Edge: role comparison is case-insensitive (DB could store 'Finance').
  it('treats the role case-insensitively', () => {
    const titles = visibleTitles(ALL, 'FINANCE')
    expect(titles).toContain('Cost Management')
  })

  // Edge: undefined role falls back to member (least privilege) — no FinOps.
  it('an undefined role is treated as member (no FinOps)', () => {
    const titles = visibleTitles(ALL, undefined)
    expect(titles).not.toContain('Cost Management') // not finance/admin/owner
  })
})

// The 'developer' (build/operations) role.
// A developer SEES the no-role-restriction items and is HIDDEN from the
// FinOps (money) requiredRoles item. This is the nav side of "developer owns
// the build, not the numbers".
describe('getVisibleNavItems — developer role', () => {
  it('developer sees Command Center but is HIDDEN from FinOps (money) items', () => {
    const titles = visibleTitles(ALL, 'developer')
    expect(titles).toContain('Command Center') // no requiredRoles -> visible
    expect(titles).not.toContain('Cost Management') // FinOps role-gated to finance/admin/owner
  })

  it('resolveCurrentUserRole returns developer for a developer who is members[1]', () => {
    const owner = { userId: 'user-owner', role: 'owner' }
    const developer = { userId: 'user-dev', role: 'developer' }
    const members = [owner, developer]
    const role = resolveCurrentUserRole(members, 'user-dev')
    expect(role).toBe('developer') // not 'owner', which members[0] holds
    // End-to-end: that developer never sees FinOps.
    const titles = getVisibleNavItems(ALL, role).map((i) => i.title)
    expect(titles).toContain('Command Center')
    expect(titles).not.toContain('Cost Management') // money item hidden from developer
  })
})

// nav-group must not feed useAuth().user.role,
// which app-wide resolves to activeOrg.members[0].role — the org's FIRST member
// (creator/owner), NOT the logged-in user. These tests exercise the per-user
// lookup. The finance user is deliberately NOT the first member, so reading
// members[0] would fail them.
describe('resolveCurrentUserRole — viewer-scoped role lookup', () => {
  // Realistic org: the creator/owner is members[0]; the finance user is second.
  const owner = { userId: 'user-owner', role: 'owner' }
  const financeUser = { userId: 'user-finance', role: 'finance' }
  const plainMember = { userId: 'user-member', role: 'member' }
  const org = [owner, financeUser, plainMember]

  it('returns the FINANCE user’s own role even though members[0] is the owner', () => {
    expect(resolveCurrentUserRole(org, 'user-finance')).toBe('finance')
  })

  it('returns a plain member’s own role, NOT the owner from members[0]', () => {
    expect(resolveCurrentUserRole(org, 'user-member')).toBe('member')
  })

  it('returns owner only for the actual owner', () => {
    expect(resolveCurrentUserRole(org, 'user-owner')).toBe('owner')
  })

  it('falls back to member when the user is not in the org list', () => {
    expect(resolveCurrentUserRole(org, 'user-stranger')).toBe('member')
  })

  it('falls back to member for empty / missing members or missing user id', () => {
    expect(resolveCurrentUserRole([], 'user-finance')).toBe('member')
    expect(resolveCurrentUserRole(undefined, 'user-finance')).toBe('member')
    expect(resolveCurrentUserRole(null, 'user-finance')).toBe('member')
    expect(resolveCurrentUserRole(org, undefined)).toBe('member')
    expect(resolveCurrentUserRole(org, null)).toBe('member')
  })
})

// End-to-end of the FinOps rule using the REAL wiring path
// (member list -> resolveCurrentUserRole -> getVisibleNavItems), with the
// finance/member user NOT being the org creator. Passing a role string
// straight to the helper would skip the lookup this exercises.
describe('end-to-end: viewer is NOT the org creator', () => {
  const owner = { userId: 'user-owner', role: 'owner' }

  it('a finance teammate (members[1]) sees Command Center + FinOps', () => {
    const members = [owner, { userId: 'user-finance', role: 'finance' }]
    const role = resolveCurrentUserRole(members, 'user-finance')
    expect(role).toBe('finance') // not 'owner'
    const titles = getVisibleNavItems(ALL, role).map((i) => i.title)
    expect(titles).toEqual(['Command Center', 'Cost Management'])
  })

  it('a plain member (members[1]) does NOT see FinOps', () => {
    const members = [owner, { userId: 'user-member', role: 'member' }]
    const role = resolveCurrentUserRole(members, 'user-member')
    expect(role).toBe('member') // not 'owner', which would show FinOps
    const titles = getVisibleNavItems(ALL, role).map((i) => i.title)
    expect(titles).toContain('Command Center')
    expect(titles).not.toContain('Cost Management') // FinOps hidden from member
  })
})
