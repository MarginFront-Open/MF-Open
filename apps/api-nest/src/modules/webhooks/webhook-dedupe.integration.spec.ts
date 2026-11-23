/**
 * WHAT THIS FILE DOES:
 *   Integration test for WebhookDedupeService against a REAL local Redis
 *   (no mock of ioredis). Verifies that concurrent claim() calls for the
 *   same event id return exactly one true and one false — the actual race
 *   the service exists for. The unit spec uses mocked ioredis and can't catch
 *   regressions in the service's SET NX argument order or the underlying client API
 *   contract; this can.
 *
 * WHEN IT RUNS:
 *   Gated on Redis being reachable on localhost:6379. If Redis isn't up the
 *   suite skips with a loud console warning rather than failing CI. The skip
 *   is loud on purpose: a silently skipped dedupe test would look like a pass.
 *
 * WHY IT EXISTS:
 *   A refactor that swaps SET NX argument order, drops the NX flag,
 *   or replaces ioredis with a client that doesn't honor the same API would
 *   pass the unit spec (mocks return whatever we tell them) but break in
 *   production. This is the cheap belt to that suspenders.
 */

import { execSync } from 'child_process';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { WebhookDedupeService } from './webhook-dedupe.service';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Probe Redis SYNCHRONOUSLY at module-load time so the `describe.skip`
 * decision is made before Jest registers the tests. An async `beforeAll`
 * probe doesn't work for this — the condition has to be known when the
 * describe block is defined, not when its hooks fire.
 *
 * Two probes, in order:
 *   1. `redis-cli -u $REDIS_URL ping`, which works where redis-cli is
 *      installed.
 *   2. raw `nc -z $host $port` — fallback for CI / dockerized boxes
 *      where redis-cli isn't installed but a Redis instance IS reachable.
 *
 * If neither answers, we skip with a loud console.warn. This keeps CI
 * green on machines without Redis while still surfacing the skip clearly.
 */
function probeRedisSync(): boolean {
  try {
    const out = execSync(`redis-cli -u ${REDIS_URL} ping`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
      .toString()
      .trim();
    if (out === 'PONG') return true;
  } catch {
    /* fall through to nc probe */
  }
  try {
    // Parse host:port from REDIS_URL for the nc fallback. Defaults match
    // the local dev case (`redis://localhost:6379`).
    const url = new URL(REDIS_URL);
    const host = url.hostname || 'localhost';
    const port = url.port || '6379';
    execSync(`nc -z -w 1 ${host} ${port}`, { stdio: 'ignore', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

const redisAvailable = probeRedisSync();

if (!redisAvailable) {
  // eslint-disable-next-line no-console -- explains why the suite skipped
  console.warn(
    `[webhook-dedupe.integration] Redis at ${REDIS_URL} not reachable — integration tests SKIPPED. ` +
      'To run them: brew services start redis (or set REDIS_URL to a reachable instance).',
  );
}

function buildConfig(): ConfigService {
  return {
    get: (k: string) => (k === 'REDIS_URL' ? REDIS_URL : undefined),
  } as unknown as ConfigService;
}

const maybeDescribe = redisAvailable ? describe : describe.skip;

maybeDescribe('WebhookDedupeService — real Redis', () => {
  // Single shared service across the suite. Each test gets a fresh, unique
  // event id so they don't collide. Sharing the service avoids opening + tearing
  // down an ioredis socket per test (which makes Jest hang on open handles).
  let svc: WebhookDedupeService;
  const cleanupKeys: string[] = [];

  beforeAll(() => {
    svc = new WebhookDedupeService(buildConfig());
  });

  afterAll(async () => {
    // Best-effort cleanup so re-running the suite doesn't see stale keys.
    if (cleanupKeys.length > 0) {
      const client = new Redis(REDIS_URL, { lazyConnect: true });
      try {
        await client.connect();
        await client.del(...cleanupKeys);
      } catch {
        // swallow — we'll catch real failures via assertions in the tests above
      } finally {
        await client.quit().catch(() => undefined);
      }
    }
    if ((svc as any)?.onModuleDestroy) {
      await (svc as any).onModuleDestroy();
    }
  });

  it('two concurrent claims for the SAME event id → exactly one wins', async () => {
    const eventId = `evt_test_concurrent_${Date.now()}`;
    cleanupKeys.push(`webhook-dedupe:stripe:${eventId}`);

    const [a, b] = await Promise.all([svc.claim('stripe', eventId), svc.claim('stripe', eventId)]);

    // Exclusive lock. Order is not guaranteed, but one of them MUST be the
    // claimer and one MUST be the duplicate.
    expect([a, b].sort()).toEqual([false, true]);
  });

  it('two sequential claims for DIFFERENT event ids → both win', async () => {
    const a = `evt_test_distinct_a_${Date.now()}`;
    const b = `evt_test_distinct_b_${Date.now()}`;
    cleanupKeys.push(`webhook-dedupe:stripe:${a}`, `webhook-dedupe:stripe:${b}`);

    expect(await svc.claim('stripe', a)).toBe(true);
    expect(await svc.claim('stripe', b)).toBe(true);
  });

  it('two claims for the same event id PAST the TTL → second one wins again', async () => {
    const eventId = `evt_test_ttl_${Date.now()}`;
    cleanupKeys.push(`webhook-dedupe:stripe:${eventId}`);

    // Use a 1-second TTL via the override so the test doesn't sit for 30s.
    expect(await svc.claim('stripe', eventId, 1)).toBe(true);
    expect(await svc.claim('stripe', eventId, 1)).toBe(false);

    await new Promise((r) => setTimeout(r, 1100));

    // TTL expired. The legitimate retry can now claim again.
    expect(await svc.claim('stripe', eventId, 1)).toBe(true);
  });
});
