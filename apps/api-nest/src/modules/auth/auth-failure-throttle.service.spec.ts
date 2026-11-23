/**
 * Unit tests for AuthFailureThrottleService.
 *
 * Pins the five properties the whole control rests on:
 *   - counting is ONE atomic round trip that always arms a TTL (a counter that
 *     loses its TTL never expires, so the IP is blocked forever and the Slack
 *     auth-failure alert goes dark for it — see AUTH_FAILURE_COUNT_SCRIPT),
 *   - the window stays anchored to the first failure, so a steady drip expires,
 *   - the threshold boundary (block strictly ABOVE it, never at or below),
 *   - fail-open on every degraded path: no Redis, disabled, an error, a HANG,
 *   - exactly one engagement log line per window, never one per
 *     blocked request during a storm.
 *
 * MODELED ON: customer-failure-alert.service.spec.ts (jest.mock("ioredis") +
 *   a stubbed ConfigService).
 *
 * MUTATION CONTROL: split the script into INCR + a conditional EXPIRE and
 *   both round-trip tests go red; delete the Promise.race and the hang test
 *   times out; drop the `TTL < 0` guard from the script and the self-healing
 *   test goes red.
 */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  AuthFailureThrottleService,
  AUTH_FAILURE_COUNT_SCRIPT,
} from './auth-failure-throttle.service';

const mockRedis = {
  eval: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn().mockResolvedValue(1),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
};
jest.mock('ioredis', () => jest.fn().mockImplementation(() => mockRedis));

const REDIS_URL = 'redis://localhost:6379';
const IP = '1.2.3.4';
const COUNT_KEY = `auth-failure-throttle:count:ip:${IP}`;

function buildService(env: Record<string, string | undefined> = {}) {
  const config = {
    get: (key: string) => ({ REDIS_URL, ...env })[key],
  } as unknown as ConfigService;
  return new AuthFailureThrottleService(config);
}

describe('AuthFailureThrottleService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // incr and expire stay on the double purely so the "never a second round
    // trip" test can assert they are untouched.
    mockRedis.quit.mockResolvedValue('OK');
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('counting', () => {
    it('counts and arms the TTL in ONE atomic round trip, never INCR then EXPIRE', async () => {
      const service = buildService();
      mockRedis.eval.mockResolvedValueOnce(1);

      await service.recordFailureAndCheckLimit(IP);

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      expect(mockRedis.eval).toHaveBeenCalledWith(AUTH_FAILURE_COUNT_SCRIPT, 1, COUNT_KEY, '900');
      // A second round trip can leave a counter with no TTL. See AUTH_FAILURE_COUNT_SCRIPT.
      expect(mockRedis.incr).not.toHaveBeenCalled();
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('arms the TTL on EVERY failure, so a counter that lost its TTL heals itself', async () => {
      const service = buildService();
      mockRedis.eval.mockRejectedValueOnce(new Error('READONLY replica'));

      await service.recordFailureAndCheckLimit(IP);

      mockRedis.eval.mockResolvedValueOnce(2);
      await service.recordFailureAndCheckLimit(IP);

      expect(mockRedis.eval).toHaveBeenCalledTimes(2);
      for (const call of mockRedis.eval.mock.calls) {
        expect(call[0]).toBe(AUTH_FAILURE_COUNT_SCRIPT);
        expect(call[3]).toBe('900');
      }
    });

    it('re-arms the TTL only when the key has none, so the window stays anchored', () => {
      // Structural, because Jest cannot run Lua. The guard is what makes the
      // arming above a repair rather than a window reset.
      expect(AUTH_FAILURE_COUNT_SCRIPT).toContain("redis.call('INCR', KEYS[1])");
      expect(AUTH_FAILURE_COUNT_SCRIPT).toContain("redis.call('TTL', KEYS[1]) < 0");
      expect(AUTH_FAILURE_COUNT_SCRIPT).toContain("redis.call('EXPIRE', KEYS[1], ARGV[1])");
    });

    it('blocks strictly ABOVE the threshold, never at or below it', async () => {
      const service = buildService({ AUTH_FAILURE_THROTTLE_THRESHOLD: '10' });

      mockRedis.eval.mockResolvedValueOnce(9);
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(false);

      mockRedis.eval.mockResolvedValueOnce(10);
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(false);

      mockRedis.eval.mockResolvedValueOnce(11);
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(true);

      mockRedis.eval.mockResolvedValueOnce(400);
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(true);
    });

    it('honors the threshold and window env knobs', async () => {
      const service = buildService({
        AUTH_FAILURE_THROTTLE_THRESHOLD: '3',
        AUTH_FAILURE_THROTTLE_WINDOW_SECONDS: '60',
      });

      mockRedis.eval.mockResolvedValueOnce(1);
      await service.recordFailureAndCheckLimit(IP);
      expect(mockRedis.eval).toHaveBeenCalledWith(AUTH_FAILURE_COUNT_SCRIPT, 1, COUNT_KEY, '60');

      mockRedis.eval.mockResolvedValueOnce(4);
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(true);
    });

    it.each([
      ['non-numeric', 'abc'],
      ['zero', '0'],
      ['negative', '-5'],
    ])('falls back to the default threshold for a %s value', async (_label, raw) => {
      const service = buildService({ AUTH_FAILURE_THROTTLE_THRESHOLD: raw });

      mockRedis.eval.mockResolvedValueOnce(50);
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(false);

      mockRedis.eval.mockResolvedValueOnce(51);
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(true);
    });
  });

  describe('engagement reporting (the ONLY signal a blocked storm produces)', () => {
    it('reports exactly once, at threshold + 1, and stays quiet on later blocked hits', async () => {
      const service = buildService({ AUTH_FAILURE_THROTTLE_THRESHOLD: '3' });
      warn.mockClear();

      mockRedis.eval.mockResolvedValueOnce(3);
      await service.recordFailureAndCheckLimit(IP);
      expect(warn).not.toHaveBeenCalled();

      mockRedis.eval.mockResolvedValueOnce(4);
      await service.recordFailureAndCheckLimit(IP, {
        path: '/v1/verify',
        method: 'GET',
        userAgent: 'curl/8.4.0',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0][0] as string;
      expect(line).toContain(IP);
      expect(line).toContain('4 failed api-key attempts');
      expect(line).toContain('(threshold 3)');
      expect(line).toContain('GET /v1/verify');
      expect(line).toContain('user-agent="curl/8.4.0"');

      mockRedis.eval.mockResolvedValueOnce(5);
      await service.recordFailureAndCheckLimit(IP);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('treats a string reply as a number, so the threshold is never compared as text', async () => {
      const service = buildService({ AUTH_FAILURE_THROTTLE_THRESHOLD: '3' });
      warn.mockClear();

      mockRedis.eval.mockResolvedValueOnce('4');
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('4 failed api-key attempts');
    });
  });

  describe('starvation guard', () => {
    it('WARNs at construction when the throttle threshold is at or below the alert threshold', () => {
      warn.mockClear();
      buildService({ AUTH_FAILURE_THROTTLE_THRESHOLD: '5', AUTH_FAILURE_ALERT_THRESHOLD: '5' });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('AUTH_FAILURE_ALERT_THRESHOLD');
    });

    it('stays quiet when the throttle threshold sits above the alert threshold', () => {
      warn.mockClear();
      buildService({ AUTH_FAILURE_THROTTLE_THRESHOLD: '50', AUTH_FAILURE_ALERT_THRESHOLD: '5' });

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('fail-open posture', () => {
    it('returns false and touches Redis ZERO times with no REDIS_URL', async () => {
      const service = buildService({ REDIS_URL: undefined });

      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(false);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('returns false and touches Redis ZERO times when disabled by env', async () => {
      const service = buildService({ AUTH_FAILURE_THROTTLE_ENABLED: 'false' });

      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(false);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('returns false and never throws when the count round trip rejects', async () => {
      const service = buildService();
      mockRedis.eval.mockRejectedValueOnce(new Error('READONLY replica'));

      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(false);
    });

    it('returns false inside the timeout budget when Redis HANGS, instead of holding the response', async () => {
      // The scenario this exists for: lazyConnect + enableOfflineQueue means a
      // hard-down Redis can hold a command until ioredis's ~10s connect timeout,
      // which would land on every failed-auth response during an outage.
      const service = buildService({ AUTH_FAILURE_THROTTLE_TIMEOUT_MS: '5' });
      mockRedis.eval.mockReturnValueOnce(new Promise(() => undefined));

      const started = Date.now();
      await expect(service.recordFailureAndCheckLimit(IP)).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it('quits the Redis client on shutdown', async () => {
    const service = buildService();

    await service.onModuleDestroy();

    expect(mockRedis.quit).toHaveBeenCalledTimes(1);
  });
});
