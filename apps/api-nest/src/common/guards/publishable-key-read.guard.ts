import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../modules/auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../modules/auth/auth.service';
import { PublishableKeyReadForbiddenException } from '../exceptions/publishable-key-read-forbidden.exception';
import { INGEST_ROUTE_KEY } from './route-metadata-keys';

/**
 * Metadata key marking a route a publishable key is deliberately allowed to reach.
 * Internal plumbing — controllers use the @PublishableKeyAllowed() decorator below.
 * Exported for the route-sweep spec, which reads the same metadata Nest reads.
 */
export const PUBLISHABLE_KEY_ALLOWED_KEY = 'publishableKeyAllowed';

/**
 * Mark a route a publishable key is DELIBERATELY allowed to reach. This
 * is the ONLY way an mf_pk_ key reaches any authenticated route — everything else denies
 * by default. The whole allowlist is three handlers: GET /v1/verify (both doors) and
 * GET /v1/me/key, the key-identity contract. The code-cost-clarity installer calls them at
 * init and depends on a 200 + {role, keyType} for a publishable key to print its "that
 * is the publishable key, paste the secret one" message; its auth-hold recovery probes
 * /v1/me/key on a cadence and a 403 there would wedge the hold permanently; and
 * @marginfront/sdk connect()/verify() uses /verify too. These routes expose only org
 * id+name and role/keyType — acceptable for a key we tell customers to embed. Adding
 * this decorator anywhere else fails the route-sweep spec on purpose.
 */
export const PublishableKeyAllowed = () => SetMetadata(PUBLISHABLE_KEY_ALLOWED_KEY, true);

/**
 * PublishableKeyReadGuard: the key-TYPE boundary.
 *
 * An api-key request whose keyType is 'publishable' is denied on EVERY method of every
 * authenticated route unless the route carries @PublishableKeyAllowed or @IngestRoute.
 * Without it, a publishable key could read the full customer roster, every invoice,
 * MRR/revenue/profitability analytics and credit balances. Despite the name it fires on
 * writes too, ahead of PublishableKeyWriteGuardInterceptor; see the ingest carve-out in
 * canActivate for why the interceptor still exists.
 *
 * Touches ONLY api-key requests whose keyType is 'publishable'. Sessions, JWTs, portal
 * tokens, secret keys, and unauthenticated requests pass untouched. Role floors for secret
 * keys are OrgRoleGuard's job, not this guard's.
 *
 * REGISTRATION IS LOAD-BEARING: this guard lives in auth.module.ts's providers, AFTER
 * CombinedAuthGuard — never in app.module.ts. Root-module APP_GUARDs run BEFORE imported
 * modules' guards (Nest scans the root first), so an app.module.ts registration would see
 * request.user undefined and silently allow every publishable key: a fail-open no-op.
 * Under deny-by-default that mistake un-gates the entire API.
 */
@Injectable()
export class PublishableKeyReadGuard implements CanActivate {
  private readonly logger = new Logger(PublishableKeyReadGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user || user.authMethod !== 'api-key' || user.keyType !== 'publishable') {
      return true;
    }

    // Defensive: on a @Public route CombinedAuthGuard never sets request.user, so the
    // check above already returned. Kept so a future auth path that populates user on
    // public routes cannot turn this guard into an accidental gate on them.
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (isPublic) {
      return true;
    }

    // The ingest POSTs (@IngestRoute) are deliberately left to the write interceptor:
    // a publishable key still gets a 403, but from
    // PublishableKeyWriteGuardInterceptor, whose distinct exception class is the ONLY
    // thing CustomerFailureAlertFilter pages the alerts channel on. Denying here instead
    // would silently retire that page on the one path where money actually moves.
    const isIngestRoute =
      this.reflector.getAllAndOverride<boolean>(INGEST_ROUTE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (isIngestRoute) {
      return true;
    }

    const publishableKeyAllowed =
      this.reflector.getAllAndOverride<boolean>(PUBLISHABLE_KEY_ALLOWED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (publishableKeyAllowed) {
      return true;
    }

    this.recordDenial(user, request);
    throw new PublishableKeyReadForbiddenException();
  }

  /**
   * Mirrors OrgRoleGuard.recordRoleDenial. Ids only — never key material. The route
   * fallback strips the query string: query params can carry PII and must never reach
   * logs. Publishable-key WRITES denied here page no one, so this log line is
   * their only trace.
   */
  private recordDenial(
    user: AuthenticatedUser,
    request: { method?: string; route?: { path?: string }; url?: string },
  ): void {
    const path = request.route?.path ?? request.url?.split('?')[0] ?? '?';
    const route = `${request.method ?? '?'} ${path}`;
    this.logger.warn(
      `[publishable-key-read] denied keyId=${user.apiKeyId ?? 'unknown'} route="${route}"`,
    );
  }
}
