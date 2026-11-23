import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

/** RFC 4122 shape, any version. Shape only — existence is OrgRoleGuard's question, not ours. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejects a `:orgId` URL segment that is not UUID-shaped, BEFORE OrgRoleGuard reads it
 *
 * WHY THIS IS A GUARD AND NOT `@Param('orgId', ParseUUIDPipe)`. The 500 being prevented is
 * raised inside OrgRoleGuard: `ba_member.findFirst({ organizationId: 'not-a-uuid' })` against a
 * `@db.Uuid` column (the ba_member model in packages/db/prisma/schema.prisma) makes Prisma throw P2023, which is
 * not an HttpException, so CustomerFailureAlertFilter hands it to super.catch and it leaves as a
 * 500 in the error tracker. Guards run before pipes, so a `ParseUUIDPipe` on the handler param never gets
 * the chance — the guard has already queried and thrown. Same reasoning, same shape, as
 * JsonBodyDepthGuard.
 *
 * MOUNT IT FIRST: route-scoped guards run in the order they are listed in `@UseGuards`, so this
 * has to precede OrgRoleGuard to be worth anything.
 *
 * The 400 it produces does not page anyone: CustomerFailureAlertFilter only classifies a 400 as
 * `bad_data` when the caller surface is sdk/mcp/ccc (see CustomerFailureAlertService), and
 * this is a dashboard surface.
 */
@Injectable()
export class OrgIdParamUuidGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // Typed `string` by express, but genuinely absent if this guard is ever mounted on a route
    // with no :orgId segment. Absent is not this guard's business; malformed is.
    const orgId: string | undefined = request.params?.orgId;
    if (typeof orgId === 'string' && !UUID_SHAPE.test(orgId)) {
      throw new BadRequestException(
        'The organization id in the URL is not a valid id. Check the address and try again.',
      );
    }
    return true;
  }
}
