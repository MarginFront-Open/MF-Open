/**
 * Tests for TeamController's COARSE authorization wiring.
 *
 * No HTTP here. These are deterministic metadata assertions that prove each endpoint
 * carries the right @OrgRoles(...) tag and that the class is locked behind OrgRoleGuard.
 * The guard's actual deny behavior (cross-tenant, wrong-role) is already covered by
 * org-role.guard.spec.ts — we don't duplicate it; we just prove the controller asks for
 * the right level on the right routes, which is the part a refactor could silently break.
 */

import 'reflect-metadata';
import { TeamController } from './team.controller';
import { ORG_MANAGE_ROLES } from '../../common/guards/org-role.guard';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';

// The metadata key the @OrgRoles decorator writes (SetMetadata('orgRoles', roles)).
const ORG_ROLES_KEY = 'orgRoles';
// The key Nest's @UseGuards writes.
const GUARDS_KEY = '__guards__';

function orgRolesOf(method: keyof TeamController): string[] | undefined {
  return Reflect.getMetadata(ORG_ROLES_KEY, TeamController.prototype[method] as any);
}

describe('TeamController authorization metadata', () => {
  it('locks the whole controller behind OrgRoleGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_KEY, TeamController) ?? [];
    expect(guards).toContain(OrgRoleGuard);
  });

  it('owner/admin-only on re-role, remove, cancel, resend', () => {
    expect(orgRolesOf('updateMemberRole')).toEqual(ORG_MANAGE_ROLES);
    expect(orgRolesOf('removeMember')).toEqual(ORG_MANAGE_ROLES);
    expect(orgRolesOf('cancelInvitation')).toEqual(ORG_MANAGE_ROLES);
    expect(orgRolesOf('resendInvitation')).toEqual(ORG_MANAGE_ROLES);
    // sanity: the manage set is exactly owner/admin.
    expect(ORG_MANAGE_ROLES).toEqual(['owner', 'admin']);
  });

  it('any-member (empty role set) on reads and invite/add', () => {
    // @OrgRoles() with no args sets an empty array — "any member", with the grant cap
    // for add/invite enforced downstream in the service.
    expect(orgRolesOf('getTeamMembers')).toEqual([]);
    expect(orgRolesOf('getTeamMember')).toEqual([]);
    expect(orgRolesOf('addMember')).toEqual([]);
    expect(orgRolesOf('sendInvitation')).toEqual([]);
  });
});
