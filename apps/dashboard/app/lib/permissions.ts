// MarginFront org roles, registered with the login system (Better Auth).
//
// WHY THIS FILE EXISTS
// Better Auth's organization plugin ships with only three built-in roles: owner, admin,
// member. So when someone is invited as "finance" or "developer", Better Auth rejects it
// with ROLE_NOT_FOUND — it has never heard of those roles. This file registers all five
// MarginFront roles with the login system so finance and developer can be invited by email
// like the other three.
//
// THIS IS NOT WHERE PERMISSIONS ARE ENFORCED
// MarginFront decides who can actually touch money, the build/ops area, or org settings in
// its OWN code — the api-nest OrgRoleGuard and the dashboard server-action helpers, which
// read ba_member.role. This file only makes the five role NAMES valid to the login library
// so the invite flow accepts them. At the login-library level, finance and developer are
// given the same low-power footprint as a member; their real powers come from MarginFront's
// own role checks, not from Better Auth.
//
// SHARED BY SERVER AND CLIENT
// Imported by both auth.ts (server) and auth-client.ts (client) so the two agree on the
// exact same role set. Keep this file free of any server-only imports.

import { createAccessControl } from 'better-auth/plugins/access'
import {
  ownerAc,
  adminAc,
  memberAc,
  defaultStatements,
} from 'better-auth/plugins/organization/access'

// One access controller, built on Better Auth's default org permission statements
// (organization / member / invitation / team / ac). All five roles share it.
export const ac = createAccessControl(defaultStatements)

// The three built-in roles, re-declared against our access controller with Better Auth's
// default permissions, so owner, admin, and member keep their stock behavior. Re-declaring
// them (rather than dropping them) is required: once you pass a custom `roles` map, it is the
// complete set of roles the login system knows about, so the built-ins must be present too.
export const owner = ac.newRole(ownerAc.statements)
export const admin = ac.newRole(adminAc.statements)
export const member = ac.newRole(memberAc.statements)

// The custom MarginFront roles. At the login-library level they mirror "member"
// (deliberately low power); their real MarginFront capabilities come from
// ba_member.role + the server-side guards, not from here. 'legal' is the
// matter seat: it exists so a firm's billing reviewer can be
// invited by email like everyone else.
export const finance = ac.newRole(memberAc.statements)
export const developer = ac.newRole(memberAc.statements)
export const legal = ac.newRole(memberAc.statements)

// The full role map handed to the organization plugin on BOTH server and client.
export const roles = { owner, admin, member, finance, developer, legal }
