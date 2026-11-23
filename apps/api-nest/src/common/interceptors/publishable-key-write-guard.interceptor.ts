import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PublishableKeyWriteForbiddenException } from '../exceptions/publishable-key-write-forbidden.exception';

/**
 * Global interceptor that rejects write operations made with a publishable
 * API key.
 *
 * Why:
 *   Publishable keys (mf_pk_*) are designed to be safe to embed in browser
 *   code — they have scoped read permissions. Writes from a publishable key
 *   would let any visitor to a customer's site create/update/delete data,
 *   which is a catastrophic security hole.
 *
 * Policy (matches Stripe):
 *   - Secret keys (mf_sk_*):   all HTTP methods allowed
 *   - Publishable keys (mf_pk_*): GET only; any write (POST/PUT/PATCH/DELETE)
 *     returns 403 Forbidden
 *   - JWT / session (dashboard users): all HTTP methods allowed
 *
 * Runs after guards have populated request.user, so it can inspect
 * request.user.keyType. Non-API-key requests pass through unchanged.
 */
@Injectable()
export class PublishableKeyWriteGuardInterceptor implements NestInterceptor {
  private static readonly WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  private readonly logger = new Logger(PublishableKeyWriteGuardInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const method = request.method;

    if (
      user &&
      user.authMethod === 'api-key' &&
      user.keyType === 'publishable' &&
      PublishableKeyWriteGuardInterceptor.WRITE_METHODS.has(method)
    ) {
      // Attribution log for the SDK-ingest 403. Unlike the 401 path
      // in CombinedAuthGuard, request.user here is a VALIDATED publishable key,
      // so the identity is trusted (not attacker-controlled body content) and
      // we can log it directly. This keeps "a 4xx at the SDK ingest endpoint"
      // traceable to a real account for this 403 too. No raw key is logged —
      // apiKeyId is the api_keys row id, not the secret.
      this.logger.warn(
        `[PublishableKeyWriteGuard] publishable-key write rejected (403) — ` +
          `org=${user.organizationId ?? 'unknown'} ` +
          `email=${user.email || 'none'} ` +
          `apiKeyId=${user.apiKeyId ?? 'none'} ` +
          `method=${method} ` +
          `path=${request.url ?? request.originalUrl ?? 'unknown'}`,
      );
      // Distinguishable subclass (not a bare ForbiddenException) so the
      // customer-failure alert filter can page on ONLY this 403 and ignore the
      // 10+ other ForbiddenException sources (RBAC/owner-only denials). The
      // client still sees an identical 403 response.
      throw new PublishableKeyWriteForbiddenException(
        'Publishable keys cannot perform write operations (POST/PUT/PATCH/DELETE). ' +
          'Use a secret key (mf_sk_*) for operations that create, update, or delete data.',
      );
    }

    return next.handle();
  }
}
