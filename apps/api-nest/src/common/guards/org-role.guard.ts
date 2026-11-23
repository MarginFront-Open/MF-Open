import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../../modules/auth/auth.service';
import { InsufficientKeyRoleException } from '../exceptions/insufficient-key-role.exception';
import { INGEST_ROUTE_KEY, ORG_ROLES_KEY } from './route-metadata-keys';

/**
 * Metadata key that tells the guard to resolve the target org from the AUTHENTICATED
 * USER's own org (`user.organizationId`) instead of from a URL param.
 * Internal plumbing — controllers use the @OrgFromUser() decorator below.
 */
const ORG_FROM_USER_KEY = 'orgFromUser';

// When an API key hits an @IngestRoute (INGEST_ROUTE_KEY), this guard short-circuits to
// allow BEFORE it reads the key's role — ingest is structurally unblockable regardless of
// what role (or malformed permissions blob) a key carries.

/**
 * Metadata key that marks a control-plane route NO API KEY may ever reach — not even an
 * admin/owner-role key. These are the human-only surfaces (team management, payout routing,
 * org lifecycle): an API key is a server credential, and redirecting payouts or re-roling a
 * teammate is a person's decision, never a script's. Internal plumbing — use @HumanOnly().
 */
const HUMAN_ONLY_KEY = 'humanOnly';

/**
 * The roles allowed to perform "manage my org" writes: create/rotate/revoke API keys,
 * connect/disconnect a payout provider, update/delete the org, flip the dashboard mode,
 * re-role/remove team members — and the dashboard org-settings writes
 * (branding, logo, onboarding, setup-method).
 *
 * WHY A LOCAL CONST AND NOT A RE-EXPORT FROM @marginfront/db:
 * the canonical value also lives in `@marginfront/db` (packages/db/src/lib/org-roles.ts), which
 * the dashboard's assert-org-manager helper reads — same value, ['owner','admin']. We keep
 * this api-nest copy as a value-identical TWIN rather than re-exporting the package version,
 * for one hard operational reason: every `@OrgRoles(...ORG_MANAGE_ROLES)` decorator below
 * SPREADS this array at MODULE-LOAD time (organizations.controller, team.controller). If the
 * value came from `@marginfront/db` and that package's BUILT dist were stale or missing (a
 * fresh clone that hasn't been rebuilt), the import would be `undefined`, and `...undefined` throws "is not iterable" at load, so
 * api-nest would refuse to BOOT, not merely deny a request. A plain local const can never be
 * undefined, so api-nest always boots. The two definitions are kept in sync by value, not by a
 * runtime import; if they ever need to change, change both (there are only two).
 *
 * Why a named constant instead of inlining ['owner','admin'] everywhere: org settings are
 * OWNER/ADMIN ONLY. Finance owns the books and developer owns the meters, and neither joins
 * THIS set. Naming it keeps that intent legible at every call site.
 */
export const ORG_MANAGE_ROLES = ['owner', 'admin'];

/**
 * Decorator that tags a route with the roles allowed to call it.
 *
 *   @OrgRoles()                        -> any MEMBER of the org (read-level)
 *   @OrgRoles(...ORG_MANAGE_ROLES)     -> only owner/admin (write-level)
 *
 * Pair it with @UseGuards(OrgRoleGuard). The guard figures out WHICH org from the
 * URL itself, so the decorator only ever carries roles — never an org id.
 */
export const OrgRoles = (...roles: string[]) => SetMetadata(ORG_ROLES_KEY, roles);

/**
 * Mark a route whose target org is the CALLER'S OWN org, not an org named in the URL.
 *
 * Why this exists: the money controllers (invoices, subscriptions,
 * pricing plans, pricing strategies, signal events) are mounted param-less
 * (@Controller() with route arrays like ['invoices', 'org/:orgId/invoices']). Their
 * service layer ALWAYS scopes the write to `user.organizationId` and never reads the
 * `:orgId` alias from the URL. So the role MUST be checked in `user.organizationId`
 * — the org actually being written — on BOTH the canonical and the alias path.
 *
 * Without this flag the guard would read the alias `:orgId` and check the role in the
 * URL-named org while the write landed in the caller's own org — letting a user who is a
 * money manager in org A but a plain member of their active org B pass the gate via
 * POST /v1/org/A/... and have the row written to B. The flag makes the guard ignore the
 * URL org entirely for these routes, so authz is checked in exactly the org mutated.
 *
 * Do NOT put this on the api-keys/stripe/organizations routes — those genuinely
 * act on the URL org, so their role check must stay URL-org-based.
 */
export const OrgFromUser = () => SetMetadata(ORG_FROM_USER_KEY, true);

/**
 * Mark a route as the pure usage-INGEST path. An API key hitting it is allowed
 * BEFORE its role is ever read, so ingest can never be blocked. Put this on the usage-record
 * POSTs only. For THIS guard it is belt-and-suspenders (those routes don't carry
 * OrgRoleGuard); for the global PublishableKeyReadGuard it is live:
 * the deny-by-default carve-out that keeps the pk ingest 403 with the write interceptor.
 */
export const IngestRoute = () => SetMetadata(INGEST_ROUTE_KEY, true);

/**
 * Mark a route as HUMAN-ONLY: no API key of ANY role may reach it, including
 * admin/owner-role keys. Use on the control plane — team management, payout routing, org
 * lifecycle.
 *
 * A route carrying @HumanOnly MUST also carry @UseGuards(OrgRoleGuard) or the decorator does
 * nothing — org-role.route-coverage.spec.ts guarantees that pairing across the codebase.
 */
export const HumanOnly = () => SetMetadata(HUMAN_ONLY_KEY, true);

/**
 * OrgRoleGuard: the single lock against cross-tenant access.
 *
 * Without it, an endpoint that takes an org id straight from the URL would act on it
 * without checking the logged-in caller belongs to that org. A user from company A could
 * guess company B's id and read its keys or tear down its payout connection.
 *
 * What this guard does, in plain terms: before the route runs, it asks "is the person
 * calling actually a member of the org named in this URL, and do they have a high enough
 * role for what they're trying to do?" If not, it stops the request with a 403.
 *
 * The role source of truth is ba_member (the table Better Auth manages): membership is
 * looked up by (organizationId, userId) and the role is checked against an allowed set.
 */
@Injectable()
export class OrgRoleGuard implements CanActivate {
  private readonly logger = new Logger(OrgRoleGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Every role denial is logged before the 403 is thrown — without this a denial would
   * produce no log line and no Sentry issue, since SentryGlobalFilter forwards only
   * non-HttpException 5xx. Keyed on the api-key id, the route, and the role the key carried.
   * Ids and role names only — never the key itself; there is no key material on this path
   * to begin with. The raw-url route fallback is stripped of its query string: query params
   * can carry secrets/PII and must never reach logs.
   */
  private recordRoleDenial(
    user: AuthenticatedUser,
    request: { method?: string; route?: { path?: string }; url?: string },
    keyRole: string,
    requiredRoles: string[],
  ): void {
    const path = request.route?.path ?? request.url?.split('?')[0] ?? '?';
    const route = `${request.method ?? '?'} ${path}`;
    this.logger.warn(
      `[api-key-role] denied keyId=${user.apiKeyId ?? 'unknown'} ` +
        `route="${route}" carriedRole=${keyRole} requiredRoles=[${requiredRoles.join(',')}]`,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Empty array (set by @OrgRoles() with no args) means "any member is fine".
    // Falls back to [] if a route forgot the decorator but still wired the guard.
    const requiredRoles =
      this.reflector.getAllAndOverride<string[]>(ORG_ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    // When set (@OrgFromUser), the target org is the caller's own org — see the decorator.
    const orgFromUser =
      this.reflector.getAllAndOverride<boolean>(ORG_FROM_USER_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    // No authenticated user at all -> nothing to authorize against. Deny.
    // (In practice the global CombinedAuthGuard runs first and sets req.user, so this is
    // a belt-and-suspenders check, not the normal path.)
    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }

    // Which org is this request trying to act on?
    //
    // Two distinct route families, two distinct answers:
    //
    //  - @OrgFromUser routes (invoices/subscriptions/pricing/signal-events writes): the
    //    service ALWAYS writes to `user.organizationId` and ignores the `:orgId`
    //    URL alias, so the role MUST be checked in `user.organizationId` — the org being
    //    written. We deliberately do NOT read the URL param here; otherwise a money manager
    //    in org A who is a plain member of their active org B could POST /v1/org/A/... and
    //    have the write land in B while passing the gate as "manager of A".
    //
    //  - everything else (api-keys/stripe routes name it ':orgId'; the organizations
    //    controller names it ':id'): these genuinely act on the URL org, so resolve it from
    //    the URL and fail closed if it's missing.
    const orgId: string | undefined = orgFromUser
      ? user.organizationId
      : (request.params?.orgId ?? request.params?.id);
    if (!orgId) {
      throw new ForbiddenException('No organization specified');
    }

    // API-key auth. The key is an org-scoped server credential
    // carrying a fixed organizationId and a dashboard role in user.role.
    // There is no human, so no ba_member row is ever looked up on this path.
    if (user.authMethod === 'api-key') {
      // (1) CROSS-TENANT — first. A key acting on an org that isn't its own is the exact
      // attack this guard exists to block.
      if (user.organizationId !== orgId) {
        throw new ForbiddenException('This API key does not belong to the requested organization');
      }

      const isIngestRoute =
        this.reflector.getAllAndOverride<boolean>(INGEST_ROUTE_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) ?? false;
      const isHumanOnly =
        this.reflector.getAllAndOverride<boolean>(HUMAN_ONLY_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) ?? false;

      // (2) INGEST short-circuit: BEFORE user.role is ever read, so a corrupt or malformed
      // permissions blob can never block usage ingestion.
      if (isIngestRoute) {
        return true;
      }

      // Role is read only AFTER the ingest short-circuit (order is load-bearing; the tests
      // pin that user.role is untouched on the ingest path).
      const keyRole = user.role ?? 'ingest';

      // (3) HUMAN-ONLY — no key of any role, ever (this is a control-plane surface, never
      // legitimate SDK traffic).
      if (isHumanOnly) {
        throw new ForbiddenException(
          'This endpoint can only be used by a signed-in user, not an API key',
        );
      }

      // (4) INGEST FLOOR — the 'ingest' role passes nothing but an @IngestRoute (handled
      // above). It sits BELOW member, so it fails even a read-open route.
      if (keyRole === 'ingest') {
        this.recordRoleDenial(user, request, keyRole, requiredRoles);
        throw new InsufficientKeyRoleException(requiredRoles, keyRole);
      }

      // (5) READ-OPEN — @OrgRoles() with no args = any member-and-above may read. A non-ingest
      // key clears this without a specific role.
      if (requiredRoles.length === 0) {
        return true;
      }

      // (6) ROLE GATE — the identical membership.role check the human path runs below,
      // applied to the key's carried role.
      if (!requiredRoles.includes(keyRole)) {
        this.recordRoleDenial(user, request, keyRole, requiredRoles);
        throw new InsufficientKeyRoleException(requiredRoles, keyRole);
      }

      return true;
    }

    // Portal users are CUSTOMERS, not members of the org. They have no business on any of
    // these "manage my org" surfaces. Deny outright.
    if (user.authMethod === 'portal') {
      throw new ForbiddenException('Portal sessions cannot access organization management');
    }

    // From here down: human auth (jwt/session). We MUST know who the human is before we can
    // look up their membership. If userId is missing (a malformed token, e.g. one
    // that carries the id in `sub` instead of `id`), we CANNOT identify them, so we fail
    // CLOSED. This is not paranoia: Prisma silently DROPS any `where` field whose value is
    // `undefined`, so a lookup with `userId: undefined` would degenerate to
    // `WHERE organizationId = orgId` and hand back the FIRST member of the TARGET org —
    // turning "we don't know who you are" into "you match someone in that org" and opening
    // the exact cross-tenant hole this guard exists to close. get-user-id.ts fails closed on
    // the same condition.
    if (!user.userId) {
      throw new ForbiddenException('Could not identify the requesting user');
    }

    const requiresSpecificRole = requiredRoles.length > 0;

    // MEMBER fast-path: for read-level routes (no specific role required), if the caller's
    // active org IS the org in the URL, they're a member by definition — allow without a DB
    // hit. We can ONLY take this shortcut when no role is required; a write-level route still
    // needs the real role from ba_member even on the caller's own active org (an active org
    // membership doesn't prove owner/admin).
    if (!requiresSpecificRole && user.organizationId === orgId) {
      return true;
    }

    // Look up the caller's membership in the TARGET org (the one from the URL), not the
    // caller's active org. This is the cross-tenant check: no row -> not a member -> blocked.
    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId: orgId, userId: user.userId },
      select: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You do not have access to this organization');
    }

    // Read-level route: membership alone is enough.
    if (!requiresSpecificRole) {
      return true;
    }

    // Write-level route: the caller's role must be in the allowed set.
    if (!requiredRoles.includes(membership.role)) {
      throw new ForbiddenException(
        'You do not have the required role to perform this action on this organization',
      );
    }

    return true;
  }
}
