import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../modules/auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../modules/auth/auth.service';
import { IngestKeyScopeForbiddenException } from '../exceptions/ingest-key-scope-forbidden.exception';
import { INGEST_ROUTE_KEY } from './route-metadata-keys';

/**
 * Metadata key marking a route an ingest-role key is deliberately allowed to reach.
 * Internal plumbing — controllers use the @IngestKeyAllowed() decorator below.
 * Exported for the route-sweep spec, which reads the same metadata Nest reads.
 */
export const INGEST_KEY_ALLOWED_KEY = 'ingestKeyAllowed';

/**
 * Mark a route an ingest-role key is DELIBERATELY allowed to reach. This and
 * @IngestRoute are the ONLY two ways such a key reaches any
 * authenticated route — everything else denies by default.
 *
 * TWO NUMBERS, both correct, and they count different things. THIS decorator marks SIX
 * handlers, listed below. The reachable surface for an ingest key is EIGHT:
 * those six plus the two @IngestRoute usage POSTs the guard honors without a decorator
 * (see the closing paragraph). Every other doc on this feature says eight because eight
 * is what a customer's key can call; six is only the size of this decorator's set.
 *
 * The six, each called by a shipped ingest client:
 *   GET /v1/verify + GET /v1/sdk/verify — both verify doors, pinned as behaviourally
 *     identical, so an SDK build in the field may hit either.
 *   GET /v1/me/key — the key-identity contract, and the highest risk to omit:
 *     code-cost-clarity's auth-hold recovery probes it every 5 minutes, so a 403 wedges the hold
 *     permanently and parks the customer's usage on disk with no alarm.
 *   GET /v1/control/caps — the busiest ingest-key route; a 403 disarms every
 *     deployed spend cap an hour later, when the brake's state goes stale.
 *   GET /v1/control/spend — the brake reads it for enforce-mode all-provider caps.
 *   GET /v1/control/coverage — the MCP fans caps + spend + coverage through one
 *     Promise.all, so a 403 here takes all three down, and denying an aggregate read to
 *     a key that can already read both buys no security.
 *
 * The two usage-record POSTs need NO decorator: they carry @IngestRoute and the guard
 * honors that metadata directly. Adding this decorator anywhere else fails the
 * route-sweep spec on purpose.
 */
export const IngestKeyAllowed = () => SetMetadata(INGEST_KEY_ALLOWED_KEY, true);

/**
 * IngestKeyScopeGuard — the key-ROLE boundary for the ingest floor.
 *
 * The dashboard promises an "Ingest-only" key can send usage and do nothing else.
 * OrgRoleGuard alone cannot keep that promise: it is ROUTE-SCOPED via @UseGuards and so
 * runs only where a route opts in, which would leave most authenticated routes, many
 * returning money or customer data, open to an ingest-role SECRET key. POST
 * /v1/portal-sessions is worse than a read: its SecretKeyGuard validates keyType and
 * never role, so an ingest key could mint a customer portal token there.
 * This guard is ONE global choke point with a small allowlist, not a decorator per route.
 *
 * Touches ONLY api-key requests whose role is 'ingest'. parseKeyRole floors null / [] /
 * {} / an unrecognized role to 'ingest', so a key that states no role is confined
 * exactly like one minted ingest-only. Sessions, JWTs, portal tokens, every higher role,
 * and unauthenticated requests pass untouched.
 *
 * The role is never cached. validateApiKey does a fresh api_keys.findFirst per
 * request and derives the role inline, and CombinedAuthGuard spreads the result onto
 * request.user. No column, no JWT claim, no Redis entry, so every existing key is bound
 * by this guard on its next request.
 *
 * Works alongside OrgRoleGuard's ingest floor: defense in depth.
 *
 * REGISTRATION IS LOAD-BEARING: this lives in auth.module.ts's providers, LAST — after
 * CombinedAuthGuard and after PublishableKeyReadGuard — never in app.module.ts.
 * Root-module APP_GUARDs run BEFORE imported modules' (Nest scans the root first), so an
 * app.module.ts registration would see request.user undefined, return true for
 * everything, and ship green: a silent fail-open no-op. App B of this guard's http spec
 * proves it; the same trap is written up in PublishableKeyReadGuard's header.
 */
@Injectable()
export class IngestKeyScopeGuard implements CanActivate {
  private readonly logger = new Logger(IngestKeyScopeGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;

    // No authenticated principal: a @Public route (CombinedAuthGuard never sets user
    // there) or an unauthenticated request some other layer will answer.
    if (!user) {
      return true;
    }

    // Only API keys carry a role. A human session, a JWT, and a portal token have no
    // permissions blob at all, so `role` is undefined for them — flooring that to
    // 'ingest' would 403 the entire dashboard.
    if (user.authMethod !== 'api-key') {
      return true;
    }

    if (user.role !== 'ingest') {
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

    // The two usage-record POSTs. Honored as metadata rather than as a
    // second decorator so the ingest path cannot drift from the marker every
    // other guard already reads on it.
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
    throw new IngestKeyScopeForbiddenException(user.role);
  }

  /** Mirrors PublishableKeyReadGuard.recordDenial. Ids only, never key material. */
  private recordDenial(
    user: AuthenticatedUser,
    request: { method?: string; route?: { path?: string }; url?: string },
  ): void {
    const route = this.describeRoute(request);
    this.logger.warn(
      `[ingest-key-scope] denied keyId=${user.apiKeyId ?? 'unknown'} route="${route}"`,
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
