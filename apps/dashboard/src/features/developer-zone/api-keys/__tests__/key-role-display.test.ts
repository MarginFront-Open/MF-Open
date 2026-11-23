/**
 * key-role-display: the pure view-model behind the role-mirrored mint dialog
 * and key list. Drives the real functions — no mocking
 * the thing under test.
 */

import {
  KEY_ROLE_DETAIL_LINES,
  KEY_ROLE_LABELS,
  KEY_ROLE_ORDER,
  KEY_ROLE_TEACHING_COPY,
  orderKeyRoles,
  defaultMintRole,
  unavailableRoleReason,
  touchesMoney,
  keyRoleBadgeClassName,
  needsMinterReview,
} from '../key-role-display'

describe('KEY_ROLE_LABELS / KEY_ROLE_TEACHING_COPY — every role is covered', () => {
  it('has a label for all six key roles', () => {
    for (const role of KEY_ROLE_ORDER) {
      expect(KEY_ROLE_LABELS[role]).toEqual(expect.any(String))
      expect(KEY_ROLE_LABELS[role].length).toBeGreaterThan(0)
    }
  })

  it('has a plain-language teaching line for all six key roles', () => {
    for (const role of KEY_ROLE_ORDER) {
      expect(KEY_ROLE_TEACHING_COPY[role]).toEqual(expect.any(String))
      expect(KEY_ROLE_TEACHING_COPY[role].length).toBeGreaterThan(10)
    }
  })

  it('every teaching line stays ONE line — six render at once inside radio labels', () => {
    // Each line renders at text-xs inside a radio-option label with all six
    // visible, and defaultMintRole preselects ingest, so the ingest line is the
    // first thing every minter sees. Longer detail belongs in
    // KEY_ROLE_DETAIL_LINES. 200 is the ceiling, not a target.
    for (const role of KEY_ROLE_ORDER) {
      expect(KEY_ROLE_TEACHING_COPY[role].length).toBeLessThanOrEqual(200)
    }
  })

  it('the ingest-only line names the MONEY its reads return, not only cap settings', () => {
    // GET /v1/control/spend is on the IngestKeyScopeGuard allowlist and returns the org's
    // actual AI spend for the period plus, when customerExternalId is given, one named
    // teammate's spend (cost-control.controller.ts getSpend). Describing that as "spend
    // caps" reads as cap CONFIGURATION, so the customer deciding how carefully to guard
    // this key would under-read what a leak exposes. Pin the money words.
    const copy = KEY_ROLE_TEACHING_COPY.ingest.toLowerCase()
    expect(copy).toMatch(/ai spend/)
    expect(copy).toMatch(/teammate/)
    expect(copy).not.toMatch(/reads your spend caps/)
  })

  it('the ingest-only line names its one write and never claims the key changes nothing', () => {
    // POST /v1/usage/record is on the IngestKeyScopeGuard allowlist, so any absolute
    // "read-only" / "can't change anything" claim would be a false scope promise.
    // Pin its ABSENCE, plus the write said out loud.
    const copy = KEY_ROLE_TEACHING_COPY.ingest.toLowerCase()
    expect(copy).not.toMatch(/read[- ]only/)
    expect(copy).not.toMatch(/(can't|cannot|can not) change anything/)
    expect(copy).toMatch(/write/)
  })

  it("the ingest-only detail carries the write's blast radius and the leak consequence", () => {
    // recordUsage auto-provisions customer, agent and signal rows (sdk.service.ts) and
    // that usage bills. These three facts are why it needs the longer copy,
    // which the option label can't hold. The detail renders under the role
    // group for the selected role, and ingest is the default selection.
    const detail = KEY_ROLE_DETAIL_LINES.ingest
    expect(detail).toEqual(expect.any(Array))
    const text = (detail ?? []).join(' ').toLowerCase()
    expect(text).toMatch(/creat/)
    expect(text).toMatch(/customer/)
    expect(text).toMatch(/agent/)
    expect(text).toMatch(/signal/)
    expect(text).toMatch(/leak/)
    expect(text).toMatch(/invoices/)
    expect(text).toMatch(/payouts/)
  })

  it('every KEY_ROLE_DETAIL_LINES entry is a non-empty list of non-empty lines', () => {
    for (const [role, lines] of Object.entries(KEY_ROLE_DETAIL_LINES)) {
      expect(KEY_ROLE_ORDER).toContain(role)
      expect(lines?.length ?? 0).toBeGreaterThan(0)
      for (const line of lines ?? []) {
        expect(line.trim().length).toBeGreaterThan(10)
      }
    }
  })
})

describe('orderKeyRoles — canonical floor-to-ceiling order regardless of input order', () => {
  it('reorders a scrambled input to ingest→...→owner', () => {
    expect(orderKeyRoles(['admin', 'ingest', 'finance'])).toEqual([
      'ingest',
      'finance',
      'admin',
    ])
  })

  it('drops anything not in the canonical set', () => {
    expect(orderKeyRoles(['member', 'root', 'owner'])).toEqual([
      'member',
      'owner',
    ])
  })
})

describe('defaultMintRole — doctrine: default to the floor', () => {
  it('picks ingest whenever it is on the table', () => {
    expect(defaultMintRole(['ingest', 'member', 'finance'])).toBe('ingest')
    expect(
      defaultMintRole([
        'owner',
        'admin',
        'developer',
        'finance',
        'member',
        'ingest',
      ])
    ).toBe('ingest')
  })

  it('falls back to the lowest available role when ingest is absent', () => {
    expect(defaultMintRole(['finance', 'admin'])).toBe('finance')
  })

  it('returns null when the minter can mint nothing', () => {
    expect(defaultMintRole([])).toBeNull()
  })
})

describe('unavailableRoleReason — mirrors mintableKeyRoles exactly, never lies', () => {
  it('is null for every role an owner can mint (owner can mint everything)', () => {
    for (const role of KEY_ROLE_ORDER) {
      expect(unavailableRoleReason(role, 'owner')).toBeNull()
    }
  })

  it('developer is refused finance/admin/owner with a build-lane-specific reason', () => {
    expect(unavailableRoleReason('finance', 'developer')).toMatch(/money-lane/i)
    expect(unavailableRoleReason('admin', 'developer')).toMatch(/admin/i)
    expect(unavailableRoleReason('developer', 'developer')).toBeNull()
  })

  it('finance is refused developer/admin/owner with a money-lane-specific reason', () => {
    expect(unavailableRoleReason('developer', 'finance')).toMatch(/build-lane/i)
    expect(unavailableRoleReason('finance', 'finance')).toBeNull()
  })

  it('a member (or unknown/undefined role) is refused every role', () => {
    for (const role of KEY_ROLE_ORDER) {
      expect(unavailableRoleReason(role, 'member')).toEqual(expect.any(String))
    }
    expect(unavailableRoleReason('ingest', undefined)).toMatch(/not signed in/i)
  })
})

describe('touchesMoney — the money-capable filter predicate', () => {
  it('finance/admin/owner touch money', () => {
    expect(touchesMoney('finance')).toBe(true)
    expect(touchesMoney('admin')).toBe(true)
    expect(touchesMoney('owner')).toBe(true)
  })

  it('ingest/member/developer do not', () => {
    expect(touchesMoney('ingest')).toBe(false)
    expect(touchesMoney('member')).toBe(false)
    expect(touchesMoney('developer')).toBe(false)
  })
})

describe('keyRoleBadgeClassName — every role renders a distinct, non-empty class', () => {
  it('returns a non-empty className for all six roles', () => {
    for (const role of KEY_ROLE_ORDER) {
      expect(keyRoleBadgeClassName(role).length).toBeGreaterThan(0)
    }
  })

  it('roles get visually distinct classNames', () => {
    const classNames = KEY_ROLE_ORDER.map(keyRoleBadgeClassName)
    expect(new Set(classNames).size).toBe(classNames.length)
  })
})

describe('needsMinterReview — the demotion-review trigger', () => {
  it('false when the minter still holds a role that could mint this key', () => {
    expect(needsMinterReview('finance', 'finance')).toBe(false)
    expect(needsMinterReview('developer', 'owner')).toBe(false)
  })

  it('true when the minter has since been demoted below the key it minted', () => {
    expect(needsMinterReview('finance', 'member')).toBe(true)
    expect(needsMinterReview('admin', 'developer')).toBe(true)
  })

  it('true when the minter moved to the OTHER lane (developer -> finance, or vice versa)', () => {
    expect(needsMinterReview('developer', 'finance')).toBe(true)
    expect(needsMinterReview('finance', 'developer')).toBe(true)
  })

  it('true when the minter is unknown/gone (null/undefined current role)', () => {
    expect(needsMinterReview('ingest', null)).toBe(true)
    expect(needsMinterReview('ingest', undefined)).toBe(true)
  })
})
