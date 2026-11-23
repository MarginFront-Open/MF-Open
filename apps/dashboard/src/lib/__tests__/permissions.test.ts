/**
 * CanManageMoney/canManageBuild are the pure,
 * client-side MIRRORS of the server's real gates (MANAGE_MONEY_ROLES /
 * MANAGE_BUILD_ROLES in packages/db/src/lib/org-roles.ts). They exist to
 * HIDE write controls a role would get refused for anyway; the server
 * remains the enforcer. Every role is exercised against both helpers so a
 * future edit that drifts the two sets apart fails here first.
 */

import {
  canManageBuild,
  canManageMoney,
  getVisibleSettingsTabKeys,
  UserRole,
} from '../permissions'
import { MANAGE_BUILD_ROLES, MANAGE_MONEY_ROLES } from '@marginfront/db'

const ALL_ROLES = Object.values(UserRole)

describe('canManageMoney — mirrors MANAGE_MONEY_ROLES (owner/admin/finance)', () => {
  it('locks the real @marginfront/db constant to the expected set (sanity)', () => {
    expect([...MANAGE_MONEY_ROLES].sort()).toEqual([
      'admin',
      'finance',
      'owner',
    ])
  })

  it.each(ALL_ROLES)('%s matches the server set exactly', (role) => {
    const expected = (MANAGE_MONEY_ROLES as readonly string[]).includes(role)
    expect(canManageMoney(role)).toBe(expected)
  })

  it('denies undefined / unknown roles', () => {
    expect(canManageMoney(undefined)).toBe(false)
    expect(canManageMoney('not-a-real-role')).toBe(false)
  })

  it('is case-insensitive, matching hasPermission()', () => {
    expect(canManageMoney('FINANCE')).toBe(true)
    expect(canManageMoney('Owner')).toBe(true)
  })
})

describe('canManageBuild — mirrors MANAGE_BUILD_ROLES (owner/admin/developer)', () => {
  it('locks the real @marginfront/db constant to the expected set (sanity)', () => {
    expect([...MANAGE_BUILD_ROLES].sort()).toEqual([
      'admin',
      'developer',
      'owner',
    ])
  })

  it.each(ALL_ROLES)('%s matches the server set exactly', (role) => {
    const expected = (MANAGE_BUILD_ROLES as readonly string[]).includes(role)
    expect(canManageBuild(role)).toBe(expected)
  })

  it('denies undefined / unknown roles', () => {
    expect(canManageBuild(undefined)).toBe(false)
    expect(canManageBuild('not-a-real-role')).toBe(false)
  })

  it('is case-insensitive, matching hasPermission()', () => {
    expect(canManageBuild('DEVELOPER')).toBe(true)
    expect(canManageBuild('Admin')).toBe(true)
  })
})

describe('the two capabilities are NOT interchangeable', () => {
  it('finance cannot manage build; developer cannot manage money', () => {
    expect(canManageBuild(UserRole.FINANCE)).toBe(false)
    expect(canManageMoney(UserRole.DEVELOPER)).toBe(false)
  })

  it('member and plain unauthenticated callers get neither', () => {
    expect(canManageMoney(UserRole.MEMBER)).toBe(false)
    expect(canManageBuild(UserRole.MEMBER)).toBe(false)
  })
})

/**
 * PROFILE and PREFERENCES have no SETTINGS_PERMISSIONS entry, so every role
 * sees them: getVisibleSettingsTabKeys treats a missing key as unrestricted.
 * TEAM/BILLING/INTEGRATIONS are admin/owner only, so an allow-list on
 * PROFILE/PREFERENCES that missed a role would render the settings tab bar
 * EMPTY for that viewer. Every real
 * settingsTabs key (see src/features/settings/index.tsx) is exercised here.
 */
describe('getVisibleSettingsTabKeys — the settings tab bar never goes empty', () => {
  const ALL_TAB_KEYS = [
    'PROFILE',
    'PREFERENCES',
    'TEAM',
    'BILLING',
    'INTEGRATIONS',
  ]

  it('a plain member sees Profile + Preferences, but not Team/Billing/Integrations', () => {
    const visible = getVisibleSettingsTabKeys(ALL_TAB_KEYS, UserRole.MEMBER)
    expect(visible).toContain('PROFILE')
    expect(visible).toContain('PREFERENCES')
    expect(visible).not.toContain('TEAM')
    expect(visible).not.toContain('BILLING')
    expect(visible).not.toContain('INTEGRATIONS')
  })

  it('a finance viewer sees at least Profile + Preferences', () => {
    const visible = getVisibleSettingsTabKeys(ALL_TAB_KEYS, UserRole.FINANCE)
    expect(visible).toContain('PROFILE')
    expect(visible).toContain('PREFERENCES')
  })

  it('a developer viewer sees at least Profile + Preferences', () => {
    const visible = getVisibleSettingsTabKeys(ALL_TAB_KEYS, UserRole.DEVELOPER)
    expect(visible).toContain('PROFILE')
    expect(visible).toContain('PREFERENCES')
  })

  it('owner and admin see every tab', () => {
    for (const role of [UserRole.OWNER, UserRole.ADMIN]) {
      const visible = getVisibleSettingsTabKeys(ALL_TAB_KEYS, role)
      expect(visible.sort()).toEqual([...ALL_TAB_KEYS].sort())
    }
  })

  it('an undefined role still sees Profile + Preferences (unrestricted keys ignore role entirely)', () => {
    const visible = getVisibleSettingsTabKeys(ALL_TAB_KEYS, undefined)
    expect(visible).toContain('PROFILE')
    expect(visible).toContain('PREFERENCES')
    expect(visible).not.toContain('TEAM')
  })
})
