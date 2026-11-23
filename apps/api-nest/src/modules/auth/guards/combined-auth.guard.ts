import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  CanActivate,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import * as jose from 'jose';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthService, AuthenticatedUser } from '../auth.service';
import { RevokedApiKeyException } from '../../../common/exceptions/revoked-api-key.exception';
import {
  AuthUnavailableException,
  AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from '../../../common/exceptions/auth-unavailable.exception';
import {
  TooManyAuthFailuresException,
  AUTH_FAILURE_THROTTLE_RETRY_AFTER_SECONDS,
} from '../../../common/exceptions/too-many-auth-failures.exception';
import { recognizedApiKeyPrefix, resolveCallerIp } from '../lib/extract-claimed-identity';
import { AuthFailureThrottleService } from '../auth-failure-throttle.service';

/**
 * Combined auth guard that supports:
 * 1. Better Auth session cookies (validated via Better Auth API)
 * 2. Better Auth JWT tokens (validated via JWKS)
 * 3. API keys (validated via database lookup)
 * 4. @Public() decorator for public routes
 */
@Injectable()
export class CombinedAuthGuard implements CanActivate {
  // This guard does NOT record auth_401 failures. The global
  // CustomerFailureAlertFilter owns 401 alongside 400/422/403/429: one recorder,
  // in one place, no double alert. The filter re-derives the same untrusted
  // attribution via extractClaimedIdentity and logs the per-request forensic WARN
  // for customer-shaped 401s; anonymous scanner 401s are not logged.
  //
  // The throttle dep GATES (429 instead of another 401) and records nothing.
  constructor(
    private reflector: Reflector,
    private configService: ConfigService,
    private authService: AuthService,
    private authFailureThrottle: AuthFailureThrottleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    const apiKeyHeader = request.headers['x-api-key'];
    const cookieHeader = request.headers.cookie;

    // A failed api-key attempt ends one of two ways, and
    // the choke point at the bottom answers for both. An HttpException is a
    // VERDICT — the lookup ran and rejected the credential (remember a revoked
    // key's honest rejection so it wins over the generic 401). Anything else
    // means validation COULD NOT RUN (DB down, pooler timeout, a crash in the
    // mapping) — no verdict exists, so a 401 would be a lie; that becomes a 503.
    // We still fall through in both cases: a browser can send a stale x-api-key
    // AND a valid cookie, and a successful method must still win. The
    // fall-through costs SDK and code-cost-clarity traffic nothing (x-api-key is their only
    // credential) and lets a live session cookie survive an api-nest-only DB
    // fault — Better Auth is a separate service with its own pool.
    let revokedKeyRejection: RevokedApiKeyException | null = null;
    let apiKeyValidationCouldNotRun = false;

    if (apiKeyHeader) {
      try {
        const user = await this.validateApiKey(apiKeyHeader);
        request.user = user;
        return true;
      } catch (error) {
        if (error instanceof RevokedApiKeyException) {
          // Tested BEFORE the HttpException gate — it IS an UnauthorizedException.
          revokedKeyRejection = error;
        } else if (!(error instanceof HttpException)) {
          // HttpException, not UnauthorizedException, is the verdict gate: it
          // matches PerTenantThrottlerGuard and the alert filter's own status
          // gate, and covers any HttpException a credential path may raise as
          // an intended verdict.
          apiKeyValidationCouldNotRun = true;
          this.captureAuthValidationFault(error, request, apiKeyHeader);
        }
        console.error('[CombinedAuthGuard] API key validation failed:', error);
      }
    }

    // Try JWT or portal session authentication via Authorization header
    if (authHeader) {
      const [type, token] = authHeader.split(' ');

      if (type === 'Bearer' && token) {
        if (token.startsWith('prtl_')) {
          try {
            const portalUser = await this.authService.validatePortalSessionToken(token);
            if (portalUser) {
              request.portalUser = portalUser;
              request.user = {
                id: portalUser.customerId,
                email: portalUser.customerEmail || '',
                name: portalUser.customerName || 'Customer',
                organizationId: portalUser.organizationId,
                isPortalSession: true,
                authMethod: 'portal' as const,
                userId: undefined, // Portal sessions are customers, not internal users
              };
              return true;
            }
          } catch (error) {
            console.error('[CombinedAuthGuard] Portal session validation failed:', error);
          }
        }

        try {
          const user = await this.validateJwt(token);
          request.user = user;
          return true;
        } catch (error) {
          console.error('[CombinedAuthGuard] JWT validation failed:', error);
        }
      }
    }

    if (cookieHeader) {
      try {
        const user = await this.validateBetterAuthSession(cookieHeader);
        if (user) {
          request.user = user;
          return true;
        }
      } catch (error) {
        console.error('[CombinedAuthGuard] Session validation failed:', error);
      }
    }

    // The single credential-rejection choke point. Every 401
    // funneling through CombinedAuthGuard lands here and the guard throws.
    // Attribution + repeated-failure alerting live in the global
    // CustomerFailureAlertFilter: it catches this thrown 401, runs the
    // cheap scanner-noise gate, and records 'auth_401' only for customer-shaped
    // failures. One recorder, no double-page.
    //
    // A remembered revoked-key rejection wins over the generic —
    // that exception's body carries code:'key_revoked' and the revocation date,
    // and its facts let the filter attribute the alert. Everything else gets
    // the generic 401.
    //
    // Except when api-key validation could not run — then no
    // credential verdict exists and any 401 would falsely blame the key, so
    // answer 503 + Retry-After. (503 is not in the filter's CANDIDATE_STATUSES,
    // so the customer-failure counter never sees it.)
    if (apiKeyValidationCouldNotRun) {
      this.setRetryAfterHeader(context, AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS);
      throw new AuthUnavailableException();
    }

    // Every line of this block's POSITION is load-bearing:
    //   - below the 503 branch, so infrastructure faults never count,
    //   - after the api-key success return, so a valid key pays zero Redis,
    //   - gated on apiKeyHeader, so only api-key probes count (bare/JWT/cookie
    //     401s and portal prtl_ tokens never touch api_keys, so they are not an
    //     enumeration vector and the 429 copy would be wrong for them),
    //   - above the revoked-key rethrow, so a dead-key hammer gets backpressure.
    if (apiKeyHeader) {
      const callerIp = resolveCallerIp(request);
      // A broken IP resolution would otherwise put every failed request in one
      // global bucket and block the whole internet at once.
      if (callerIp !== 'unknown' && (await this.overAuthFailureLimit(callerIp, request))) {
        this.setRetryAfterHeader(context, AUTH_FAILURE_THROTTLE_RETRY_AFTER_SECONDS);
        throw new TooManyAuthFailuresException();
      }
    }

    throw revokedKeyRejection ?? new UnauthorizedException('No valid authentication provided');
  }

  /**
   * Validate Better Auth session by calling the Better Auth API
   */
  private async validateBetterAuthSession(cookieHeader: string): Promise<AuthenticatedUser | null> {
    const betterAuthUrl = this.configService.get<string>('BETTER_AUTH_URL');

    if (!betterAuthUrl) {
      console.error('[CombinedAuthGuard] BETTER_AUTH_URL not configured');
      return null;
    }

    try {
      const response = await fetch(`${betterAuthUrl}/api/auth/get-session`, {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (!data?.session?.userId || !data?.user) {
        return null;
      }

      return {
        id: data.user.id,
        email: data.user.email,
        name: data.user.name || '',
        emailVerified: data.user.emailVerified,
        organizationId: data.session.activeOrganizationId,
        authMethod: 'session' as const,
        userId: data.user.id, // Session = real human, their user ID is data.user.id
      };
    } catch (error) {
      console.error('[CombinedAuthGuard] Error validating session:', error);
      return null;
    }
  }

  private async validateJwt(token: string): Promise<AuthenticatedUser> {
    const betterAuthUrl = this.configService.get<string>('BETTER_AUTH_URL');

    if (!betterAuthUrl) {
      throw new Error('BETTER_AUTH_URL not configured');
    }

    const JWKS = jose.createRemoteJWKSet(new URL(`${betterAuthUrl}/api/auth/jwks`));

    try {
      const { payload } = await jose.jwtVerify(token, JWKS, {
        // Better Auth may not set issuer/audience, so make them optional
      });

      return {
        id: payload.id as string,
        email: payload.email as string,
        name: payload.name as string,
        emailVerified: payload.emailVerified as boolean,
        authMethod: 'jwt' as const,
        userId: payload.id as string, // JWT = real human, their user ID is payload.id
      };
    } catch (error) {
      if (error instanceof jose.errors.JWTExpired) {
        throw new UnauthorizedException('Token expired');
      }
      if (error instanceof jose.errors.JWTClaimValidationFailed) {
        throw new UnauthorizedException('Token validation failed');
      }
      throw error;
    }
  }

  // SentryGlobalFilter deliberately skips HttpExceptions (isExpectedError), so
  // the thrown 503 reaches Sentry not at all on its own — this explicit capture
  // is the ONLY record of the fault. Gated on a recognized key prefix so
  // junk-token scanner floods during an outage cost zero Sentry events, while
  // every real customer key (mf_sk_/mf_pk_) is captured. Only the key
  // KIND is attached, never the key.
  private captureAuthValidationFault(error: unknown, request: any, apiKeyHeader: string): void {
    const keyPrefix = recognizedApiKeyPrefix(apiKeyHeader);
    if (!keyPrefix) {
      return;
    }
    try {
      Sentry.captureException(error, {
        tags: { component: 'CombinedAuthGuard', failMode: 'auth-unavailable' },
        extra: {
          path: request?.url ?? request?.originalUrl ?? null,
          method: request?.method ?? null,
          keyPrefix,
        },
      });
    } catch {
      // The console.error in the catch above already recorded it — observability
      // must never turn an outage into a crash.
    }
  }

  // A second fail-open layer on top of the service's own. A defence-in-depth
  // control must never be able to turn an honest 401 into a 500.
  private async overAuthFailureLimit(callerIp: string, request: any): Promise<boolean> {
    try {
      return await this.authFailureThrottle.recordFailureAndCheckLimit(callerIp, {
        path: request?.url ?? request?.originalUrl ?? null,
        method: request?.method ?? null,
        userAgent: request?.headers?.['user-agent'] ?? null,
      });
    } catch (error) {
      console.error('[CombinedAuthGuard] auth-failure throttle check failed:', error);
      return false;
    }
  }

  // A Nest HttpException cannot carry response headers, so the header goes on
  // the response BEFORE the throw. Feature-detected on purpose: unit-test
  // contexts may lack getResponse, and a missing header must never cost us the
  // honest status code.
  private setRetryAfterHeader(context: ExecutionContext, seconds: number): void {
    try {
      const response = context.switchToHttp().getResponse?.();
      response?.setHeader?.('Retry-After', String(seconds));
    } catch {
      // The header is a hint; the response body already tells the caller to retry.
    }
  }

  private async validateApiKey(apiKey: string): Promise<AuthenticatedUser> {
    // Spread the full result so keyType, apiKeyId and every other
    // AuthenticatedUser field reaches request.user.
    const result = await this.authService.validateApiKey(apiKey);

    if (!result) {
      throw new UnauthorizedException('Invalid API key');
    }

    return {
      ...result,
      email: result.email || '',
      name: result.name || 'API User',
    };
  }
}
