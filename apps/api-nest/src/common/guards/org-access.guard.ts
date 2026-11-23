import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrgAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const orgId = request.params.orgId;

    if (!user || !orgId) {
      throw new ForbiddenException('Invalid request');
    }

    // An api-key whose own organizationId equals the target org, or a human whose active org
    // is this org, is in.
    if (user.organizationId === orgId) {
      return true;
    }

    // Membership reads from the CANONICAL ba_member table, not team_members. The team API
    // writes ba_member only, so a member added through it has no team_members row.
    //
    // FAIL CLOSED if we can't identify the human. For api-key auth the same-org fast-path above
    // already decided; if we reach here without a userId the caller is an api-key acting on a
    // DIFFERENT org (or a malformed token), and we must NOT look up ba_member with
    // userId: undefined — Prisma silently DROPS an undefined `where` field, so the query would
    // degenerate to `WHERE organizationId = orgId` and match the first member of the TARGET org,
    // opening the cross-tenant hole OrgRoleGuard also closes with the same check.
    if (!user.userId) {
      throw new ForbiddenException('Could not identify the requesting user');
    }

    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId: orgId, userId: user.userId },
      select: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You do not have access to this organization');
    }

    return true;
  }
}
