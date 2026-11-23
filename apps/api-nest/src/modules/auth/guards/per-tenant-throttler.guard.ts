import {
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as Sentry from '@sentry/nestjs';
import {
  isUpstashQuotaError,
  shouldReportUpstashQuotaError,
  UPSTASH_QUOTA_SENTRY_FINGERPRINT,
} from '../../../lib/upstash-quota-sentry-gate';
import { resolveLimiterFailureMode } from '../../../common/config/app-config';
import {
  buildThrottlerBuckets,
  isAuthenticatedRequest,
} from '../../../common/throttler/throttler.config';

// Same value as THROTTLER_SKIP in @nestjs/throttler, which its entry point does not export.
const THROTTLER_SKIP_METADATA_PREFIX = 'THROTTLER:SKIP';
const THROTTLER_BUCKET_NAMES = buildThrottlerBuckets().map((bucket) => bucket.name);

// Rate-limit tracker:
// - Authenticated requests are bucketed by organizationId so customers behind
//   shared corporate NATs don't share a rate-limit budget.
// - Unauthenticated requests fall back to IP. req.ips is populated by Express
//   when "trust proxy" is set in main.ts; we take the leftmost (client) IP.
// - If neither is available we use a constant "unknown" bucket as a safety
//   net — better to throttle aggressively than to silently disable limits.
@Injectable()
export class PerTenantThrottlerGuard extends ThrottlerGuard {
  // A request over its limit arrives in the catch below as a ThrottlerException
  // (an HttpException, status 429). That is the limiter working, so it is
  // re-thrown untouched; turning it into `true` would switch enforcement off.
  //
  // Anything else means the limiter itself broke (usually its Redis store is
  // unreachable). RATE_LIMIT_STORE_FAILURE_MODE decides what happens then:
  //   closed-anonymous (default): refuse anonymous requests with a 503 (the
  //     public endpoints, which have no other protection) and let authenticated
  //     ones through, so usage ingest and the dashboard keep working.
  //   closed: refuse every throttled request with a 503.
  //   open: let everything through.
  // Routes that skip every bucket (cron jobs, payment webhooks) are never refused.
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      const error = err as Error;
      const req = context.switchToHttp().getRequest();
      const path: string | null = req?.url ?? req?.originalUrl ?? null;
      const method: string | null = req?.method ?? null;
      const failureMode = resolveLimiterFailureMode(process.env.RATE_LIMIT_STORE_FAILURE_MODE);
      const refuse =
        !this.routeSkipsEveryBucket(context) &&
        (failureMode === 'closed' ||
          (failureMode === 'closed-anonymous' && !isAuthenticatedRequest(context)));
      console.warn(
        `[PerTenantThrottlerGuard] throttler crashed, ${refuse ? 'refusing the request' : 'failing open'} ` +
          `(RATE_LIMIT_STORE_FAILURE_MODE=${failureMode}): ${error?.message} (${method} ${path})`,
      );
      const isQuotaError = isUpstashQuotaError(error);
      if (!isQuotaError || shouldReportUpstashQuotaError()) {
        try {
          Sentry.captureException(error, {
            tags: {
              component: 'PerTenantThrottlerGuard',
              failMode: refuse ? 'fail-closed' : 'fail-open',
            },
            extra: { path, method },
            ...(isQuotaError && { fingerprint: UPSTASH_QUOTA_SENTRY_FINGERPRINT }),
          });
        } catch {
          // Sentry capture itself failed — last-resort log already happened above.
        }
      }
      if (refuse) {
        throw new ServiceUnavailableException(
          'This endpoint is temporarily refusing requests because the rate limiter is not ' +
            'working (its store, usually Redis, is not responding). Please retry in a minute. ' +
            'Operators: check REDIS_URL, or see RATE_LIMIT_STORE_FAILURE_MODE in .env.example.',
        );
      }
      return true;
    }
  }

  private routeSkipsEveryBucket(context: ExecutionContext): boolean {
    if (!this.reflector || typeof context.getHandler !== 'function') return false;
    const targets = [context.getHandler(), context.getClass()];
    return THROTTLER_BUCKET_NAMES.every((name) =>
      Boolean(this.reflector.getAllAndOverride(THROTTLER_SKIP_METADATA_PREFIX + name, targets)),
    );
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const orgId = req?.user?.organizationId;
    if (orgId) return `org:${orgId}`;
    const ip =
      (Array.isArray(req?.ips) && req.ips.length > 0 ? req.ips[0] : undefined) ??
      req?.ip ??
      'unknown';
    return `ip:${ip}`;
  }
}
