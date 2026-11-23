/**
 * WHAT THIS FILE DOES:
 *   Unit tests for WebhookDedupeService. Pins the SET NX semantics, the
 *   fail-closed posture (no Redis URL, Redis error), and the lazy/no-fallback
 *   wiring.
 *
 * WHY IT EXISTS:
 *   The whole point of this service is sharing dedupe state across api-nest
 *   instances via Redis. An in-process Map fallback or a 24h TTL would break
 *   that, and these tests stop a refactor from quietly reintroducing either.
 * CONNECTS TO:
 *   - webhook-dedupe.service.ts (the file under test)
 *   - webhooks.service.ts (calls claim() before any DB write)
 */

import { ConfigService } from '@nestjs/config';
import { WebhookDedupeService } from './webhook-dedupe.service';
import {
  resetUpstashQuotaReportGate,
  UPSTASH_QUOTA_SENTRY_FINGERPRINT,
} from '../../lib/upstash-quota-sentry-gate';

// Hoisted mock: every `new Redis(...)` in the service returns the same handle
// so the spec can stub `set` and assert call shape.
const mockRedisInstance = {
  set: jest.fn(),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
};
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedisInstance);
});

// Sentry is wired in production but we don't want real network calls. Stub
// the two functions the service actually calls.
jest.mock('@sentry/nestjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
import * as Sentry from '@sentry/nestjs';

function buildConfig(env: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

describe('WebhookDedupeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('claim() — happy path', () => {
    it('returns true when SET NX returns OK (first delivery wins the lock)', async () => {
      mockRedisInstance.set.mockResolvedValueOnce('OK');
      const svc = new WebhookDedupeService(buildConfig({ REDIS_URL: 'redis://localhost:6379' }));

      const got = await svc.claim('stripe', 'evt_test_1');

      expect(got).toBe(true);
      expect(mockRedisInstance.set).toHaveBeenCalledWith(
        'webhook-dedupe:stripe:evt_test_1',
        '1',
        'EX',
        30,
        'NX',
      );
    });

    it('returns false when SET NX returns null (second delivery sees existing lock)', async () => {
      mockRedisInstance.set.mockResolvedValueOnce(null);
      const svc = new WebhookDedupeService(buildConfig({ REDIS_URL: 'redis://localhost:6379' }));

      const got = await svc.claim('stripe', 'evt_test_2');

      expect(got).toBe(false);
      // The Sentry message lets us see in-flight overlap from production logs.
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Webhook dedupe blocked in-flight duplicate',
        expect.objectContaining({
          level: 'info',
          tags: expect.objectContaining({ provider: 'stripe' }),
        }),
      );
    });

    it('uses the default 30-second TTL (a long TTL would block retries after a failure)', async () => {
      mockRedisInstance.set.mockResolvedValueOnce('OK');
      const svc = new WebhookDedupeService(buildConfig({ REDIS_URL: 'redis://localhost:6379' }));

      await svc.claim('stripe', 'evt_test_3');

      const callArgs = mockRedisInstance.set.mock.calls[0];
      // SET key value EX <seconds> NX → seconds is index 3.
      expect(callArgs[3]).toBe(30);
      expect(callArgs[3]).not.toBe(86400); // a 24h TTL would block a failed event's retry
    });

    it('honors a custom TTL override on the public method signature', async () => {
      mockRedisInstance.set.mockResolvedValueOnce('OK');
      const svc = new WebhookDedupeService(buildConfig({ REDIS_URL: 'redis://localhost:6379' }));

      await svc.claim('stripe', 'evt_test_4', 15);

      expect(mockRedisInstance.set.mock.calls[0][3]).toBe(15);
    });

    it('honors REDIS_URL_REDIS_URL (hosted-integration double prefix) like the throttler', async () => {
      mockRedisInstance.set.mockResolvedValueOnce('OK');
      const svc = new WebhookDedupeService(
        // Only the double-prefix var is set. Service should still work.
        buildConfig({ REDIS_URL_REDIS_URL: 'redis://upstash.example.com:6379' }),
      );

      const got = await svc.claim('stripe', 'evt_test');
      expect(got).toBe(true);
    });
  });

  describe('claim() — fail-closed posture', () => {
    it('returns true (allow) and Sentry-flags when no REDIS_URL is configured', async () => {
      const svc = new WebhookDedupeService(buildConfig({}));

      const got = await svc.claim('stripe', 'evt_no_redis');

      expect(got).toBe(true);
      // At construction we should have flagged a degraded state. The per-call
      // path stays silent on purpose (don't spam Sentry with every request).
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'Webhook dedupe service started without Redis URL',
        expect.objectContaining({ level: 'error' }),
      );
      // No Redis client was constructed, so no SET should have run.
      expect(mockRedisInstance.set).not.toHaveBeenCalled();
    });

    it('returns true (allow) and Sentry-flags when Redis SET throws', async () => {
      mockRedisInstance.set.mockRejectedValueOnce(new Error('ECONNRESET'));
      const svc = new WebhookDedupeService(buildConfig({ REDIS_URL: 'redis://localhost:6379' }));

      const got = await svc.claim('stripe', 'evt_redis_down');

      // Fail-closed: blocking the webhook here would 5xx → Stripe retries
      // forever. Allow through; DB layer still catches stale duplicates.
      expect(got).toBe(true);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ silent_path: 'redis_set_failed' }),
        }),
      );
    });
  });
});

describe('WebhookDedupeService when Upstash is over its request cap', () => {
  const quotaError = () =>
    new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000.');

  beforeEach(() => {
    jest.clearAllMocks();
    resetUpstashQuotaReportGate();
  });

  it('allows every webhook through but reports the quota error to Sentry only once', async () => {
    mockRedisInstance.set.mockImplementation(() => Promise.reject(quotaError()));
    const svc = new WebhookDedupeService(buildConfig({ REDIS_URL: 'redis://localhost:6379' }));

    for (let i = 0; i < 50; i++) {
      await expect(svc.claim('stripe', `evt_quota_${i}`)).resolves.toBe(true);
    }

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        fingerprint: UPSTASH_QUOTA_SENTRY_FINGERPRINT,
        tags: expect.objectContaining({ silent_path: 'redis_set_failed' }),
      }),
    );
    mockRedisInstance.set.mockReset();
  });

  it('still captures every other Redis error, with no fingerprint, while the quota gate is closed', async () => {
    const svc = new WebhookDedupeService(buildConfig({ REDIS_URL: 'redis://localhost:6379' }));
    mockRedisInstance.set.mockRejectedValueOnce(quotaError());
    await svc.claim('stripe', 'evt_quota_first');
    (Sentry.captureException as jest.Mock).mockClear();

    mockRedisInstance.set
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    for (let i = 0; i < 3; i++) {
      await expect(svc.claim('stripe', `evt_reset_${i}`)).resolves.toBe(true);
    }

    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    for (const [, options] of (Sentry.captureException as jest.Mock).mock.calls) {
      expect(options).not.toHaveProperty('fingerprint');
    }
  });
});
