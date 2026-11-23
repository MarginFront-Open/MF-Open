/**
 * WHAT THIS FILE DOES:
 *   In-flight dedupe for incoming payment-provider webhooks. Holds a short-TTL
 *   Redis lock for each `(provider, event_id)` so two simultaneous deliveries
 *   of the SAME Stripe event id can't both dispatch their handlers
 *   in parallel.
 *
 * WHY:
 *   Stripe sometimes retries a webhook within 50-100ms because its first
 *   delivery attempt looked slow on their side. The DB-layer dedupe
 *   (`WebhooksService.createWebhookRecord`) covers retries that arrive
 *   AFTER the first attempt has finished writing its `inbound_webhooks` row,
 *   but not overlapping deliveries while attempt 1 is still running. This
 *   service closes that window with a Redis SET NX and a 30s TTL.
 *
 * CONNECTS TO:
 *   - `webhooks.service.ts` — called at the top of both `handleStripeWebhook` and
 *     `handleStripeWebhookFallback`, before any DB dedupe.
 *   - `webhooks.module.ts` — registered as a provider.
 *
 * TTL DESIGN NOTE:
 *   30 seconds is intentional; 24h would be wrong here.
 *   Two different problems:
 *     - In-flight overlap (this service): only needs to cover how long
 *       attempt 1 takes to finish. Typical handler runs in <1s. 30s is
 *       generous headroom for slow Prisma writes or email sends.
 *     - Stale retries hours/days later: handled by the DB layer.
 *       `inbound_webhooks` row in status=succeeded → DB returns
 *       isDuplicate=true. Row in status=failed → DB intentionally lets the
 *       retry reprocess.
 *   A 24h Redis TTL would mean a failed attempt holds the lock for 24h →
 *   the legitimate Stripe retry 5 minutes later would silently dedupe-skip
 *   → a failed event could never be reprocessed (poison-on-failure).
 *
 * FAIL-OPEN POSTURE:
 *   If REDIS_URL isn't set, or the Redis client errors during SET NX, we
 *   return `true` (allow the handler to proceed) and log + Sentry-capture
 *   loudly. Reasoning: blocking the webhook would mean 5xx → Stripe retries
 *   forever → cascading failure for every customer. The DB-layer dedupe is
 *   still in place as a backstop for everything except true in-flight
 *   overlap. Loud alerts make sure operators know dedupe is degraded so
 *   Redis can be restored. There is NO in-process Map fallback on purpose: a
 *   per-instance Map gives the illusion of dedupe without the reality
 *   (serverless cold-starts spawn fresh instances; attempt 1 hits instance A,
 *   attempt 2 hits instance B, neither knows about the other).
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import Redis from 'ioredis';
import {
  isUpstashQuotaError,
  shouldReportUpstashQuotaError,
  UPSTASH_QUOTA_SENTRY_FINGERPRINT,
} from '../../lib/upstash-quota-sentry-gate';

@Injectable()
export class WebhookDedupeService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDedupeService.name);
  private readonly redis: Redis | null;
  private readonly degraded: boolean;

  constructor(private readonly configService: ConfigService) {
    // Match the throttler's env-var resolution exactly. A hosting integration
    // with its env prefix set to "REDIS_URL" names the variable
    // REDIS_URL_REDIS_URL; accept either name so local dev with a bare
    // REDIS_URL works. app.module.ts uses the same pattern.
    const redisUrl =
      this.configService.get<string>('REDIS_URL_REDIS_URL') ||
      this.configService.get<string>('REDIS_URL');

    if (!redisUrl) {
      this.logger.error(
        '[WebhookDedupeService] no REDIS_URL configured — dedupe will degrade to DB-layer only. ' +
          'In-flight webhook race protection is OFF until Redis is restored.',
      );
      Sentry.captureMessage('Webhook dedupe service started without Redis URL', {
        level: 'error',
        tags: { service: 'WebhookDedupeService', state: 'degraded' },
      });
      this.redis = null;
      this.degraded = true;
      return;
    }

    try {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        // Tighter than the throttler's 3. Dedupe is best-effort: if Redis is
        // genuinely down we want to fail fast and let the request proceed
        // rather than queueing retries while Stripe's webhook timeout ticks.
        maxRetriesPerRequest: 2,
        // MUST be true on serverless + lazyConnect. The very first webhook
        // after a cold-start fires SET NX BEFORE the TCP handshake completes;
        // with the queue off, ioredis throws "Stream isn't writeable" and our
        // catch block returns true (allow) — silently bypassing the dedupe
        // exactly when we need it. The 30s TTL window is comfortably larger
        // than any plausible queue drain, and maxRetriesPerRequest still
        // bounds the worst case so a hard-down Redis fails fast. The throttler
        // in app.module.ts sets the same option for the same cold-start reason.
        enableOfflineQueue: true,
      });
      this.redis.on('error', (err) => {
        this.logger.warn(`[WebhookDedupeService] Redis error: ${err.message}`);
      });
      this.degraded = false;
    } catch (err) {
      this.logger.error(
        `[WebhookDedupeService] failed to construct Redis client: ${(err as Error).message}. ` +
          'Dedupe degraded to DB-layer only.',
      );
      Sentry.captureException(err, {
        tags: { service: 'WebhookDedupeService', state: 'construct_failed' },
      });
      this.redis = null;
      this.degraded = true;
    }
  }

  /**
   * Try to claim a webhook event for exclusive processing.
   * Returns true if the caller now "owns" the event and should proceed.
   * Returns false if another process already holds the lock for this
   * `(provider, eventId)` within the TTL window — caller treats as a
   * duplicate and short-circuits.
   *
   * Fail-open posture (see file header): on missing Redis or any error,
   * returns true (allow) and logs loudly. The DB layer is the backstop.
   */
  async claim(provider: string, eventId: string, ttlSeconds = 30): Promise<boolean> {
    if (!this.redis || this.degraded) {
      // Already logged at construction. Don't spam per-request logs.
      return true;
    }
    const key = `webhook-dedupe:${provider}:${eventId}`;
    try {
      // SET key "1" EX 30 NX → returns 'OK' if set, null if key existed.
      const result = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      if (result === 'OK') {
        return true;
      }
      this.logger.warn(
        `[WebhookDedupeService] in-flight duplicate caught: ${provider} event ${eventId}`,
      );
      Sentry.captureMessage('Webhook dedupe blocked in-flight duplicate', {
        level: 'info',
        tags: {
          service: 'WebhookDedupeService',
          provider,
          silent_path: 'in_flight_duplicate',
        },
        extra: { eventId, ttlSeconds },
      });
      return false;
    } catch (err) {
      this.logger.error(
        `[WebhookDedupeService] Redis SET NX failed for ${provider}:${eventId}: ${(err as Error).message}. ` +
          'Allowing through — DB layer will handle duplicates.',
      );
      const isQuotaError = isUpstashQuotaError(err);
      if (isQuotaError && !shouldReportUpstashQuotaError()) {
        return true;
      }
      Sentry.captureException(err, {
        tags: { service: 'WebhookDedupeService', silent_path: 'redis_set_failed' },
        extra: { provider, eventId },
        ...(isQuotaError && { fingerprint: UPSTASH_QUOTA_SENTRY_FINGERPRINT }),
      });
      return true;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
  }
}
