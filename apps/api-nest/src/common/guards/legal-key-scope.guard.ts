import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../modules/auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../modules/auth/auth.service';
import { LegalKeyScopeForbiddenException } from '../exceptions/legal-key-scope-forbidden.exception';
import { INGEST_ROUTE_KEY, ORG_ROLES_KEY } from './route-metadata-keys';
import { INGEST_KEY_ALLOWED_KEY } from './ingest-key-scope.guard';

/**
 * LegalKeyScopeGuard — the key-ROLE boundary for the legal lane, a structural
 * twin of IngestKeyScopeGuard one role up.
 *
 * WHY A LEGAL KEY IS CONFINED LIKE AN INGEST KEY: the legal lane promises
 * least-privilege access. The human 'legal' seat sees the Law tab and nothing else; a
 * 'legal' API KEY must match it. Without
 * this guard, OrgRoleGuard's read floor (any non-ingest key clears an empty @OrgRoles)
 * would let a legal key list every customer, invoice, and analytics rollup — wider than
 * the human seat it mirrors, and exactly what a firm's security review checks. And the
 * floor mechanism can't be patched route-by-route: the customer/invoice/analytics/events/
 * pricing READ handlers carry no OrgRoleGuard at all (analytics.controller.ts has zero
 * guards controller-wide), so only a global choke point can hold the line. Same shape,
 * same reason, as the ingest guard's own header.
 *
 * Touches ONLY api-key requests whose parsed role is 'legal'. Sessions, JWTs, portal
 * tokens, every other key role, and unauthenticated requests pass untouched. The allowed
 * surface, all read from reflector metadata (no hardcoded paths):
 *   - routes whose @OrgRoles(...) metadata includes 'legal' — the Law routes,
 *     self-maintaining as the surface grows;
 *   - @IngestRoute usage POSTs — the firm's agent recording its own billable usage is
 *     the intended use of a legal key;
 *   - @IngestKeyAllowed identity/ops doors (both verify doors, GET /v1/me/key, the three
 *     control-cap reads) — the surface the weakest key already reaches;
 *   - @Public routes (defensive, same as the ingest guard).
 * Everything else 403s.
 *
 * REGISTRATION IS LOAD-BEARING: this lives in auth.module.ts's providers, LAST — after
 * IngestKeyScopeGuard — never in app.module.ts. Root-module APP_GUARDs run BEFORE
 * imported modules' (Nest scans the root first), so an app.module.ts registration would
 * see request.user undefined, return true for everything, and ship green: a silent
 * fail-open no-op. App B of this guard's http spec proves it, same as the ingest twin's.
 */
@Injectable()
export class LegalKeyScopeGuard implements CanActivate {
  private readonly logger = new Logger(LegalKeyScopeGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    // No authenticated principal: a @Public route (CombinedAuthGuard never sets user
    // there) or an unauthenticated request some other layer will answer.
    if (!user) {
      return true;
    }

    // Only API keys carry a role; sessions, JWTs, and portal tokens pass untouched.
    if (user.authMethod !== 'api-key') {
      return true;
    }

    if (user.role !== 'legal') {
      return true;
    }

    // Defensive: on a @Public route CombinedAuthGuard never sets request.user, so the
    // first check already returned. Kept so a future auth path that populates user on
    // public routes cannot turn this guard into an accidental gate on them.
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (isPublic) {
      return true;
    }

    // The Law surface itself: any route that names 'legal' in its @OrgRoles list. An
    // EMPTY @OrgRoles() (the any-member read floor) deliberately does NOT clear this —
    // the generic read floor is exactly what a legal key must not inherit.
    const orgRoles = this.reflector.getAllAndOverride<string[]>(ORG_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (Array.isArray(orgRoles) && orgRoles.includes('legal')) {
      return true;
    }

    // The two usage-record POSTs, honored as metadata like the ingest twin.
    const isIngestRoute =
      this.reflector.getAllAndOverride<boolean>(INGEST_ROUTE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (isIngestRoute) {
      return true;
    }

    const ingestKeyAllowed =
      this.reflector.getAllAndOverride<boolean>(INGEST_KEY_ALLOWED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (ingestKeyAllowed) {
      return true;
    }

    this.recordDenial(user, request);
    throw new LegalKeyScopeForbiddenException(user.role);
  }

  /** Mirrors IngestKeyScopeGuard.recordDenial. Ids only, never key material. */
  private recordDenial(
    user: AuthenticatedUser,
    request: { method?: string; route?: { path?: string }; url?: string },
  ): void {
    const route = this.describeRoute(request);
    this.logger.warn(
      `[legal-key-scope] denied keyId=${user.apiKeyId ?? 'unknown'} route="${route}"`,
    );
  }

  /** The url fallback is query-STRIPPED: query params carry PII and must never reach
   * logs. */
  private describeRoute(request: {
    method?: string;
    route?: { path?: string };
    url?: string;
  }): string {
    const path = request.route?.path ?? request.url?.split('?')[0] ?? '?';
    return `${request.method ?? '?'} ${path}`;
  }
}
