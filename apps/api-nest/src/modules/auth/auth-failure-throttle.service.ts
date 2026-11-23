/**
 * WHAT THIS FILE DOES:
 *   Counts FAILED api-key attempts per caller IP in Redis and tells the guard
 *   when one network has burned through its budget, so the guard can answer 429
 *   instead of handing out another free valid/invalid verdict.
 *
 * WHY IT EXISTS:
 *   The guard chain is CombinedAuthGuard → PerTenantThrottlerGuard, and a failed
 *   credential throws in guard 1 — so the tenant throttler never runs on a bad
 *   key, and the SDK controllers @SkipThrottle besides. Without this service,
 *   key-validity probing is unthrottled at the app layer.
 *
 * WHAT THIS IS, STATED HONESTLY:
 *   An enumeration-rate cap plus backpressure. NOT brute-force protection (a
 *   distributed attacker rotates IPs) and NOT a database shield: the check runs
 *   AFTER the credential verdict, so a blocked request has already paid its
 *   lookup. That placement is forced by the requirement that a VALID key from a
 *   blocked IP is never throttled.
 *
 * WHY NOT REUSE CustomerFailureAlertService's COUNTER: recordFailure drops every
 *   untrusted failure that fails its scanner-noise gate, so anonymous floods —
 *   exactly the traffic this must throttle — never increment it at all.
 *
 * MODELED ON: customer-failure-alert.service.ts (Redis resolution, connection
 *   options, anchored window, no-in-memory-Map rule). It counts with a separate
 *   INCR then EXPIRE; this service must not — see the script below.
 *
 * DEGRADED POSTURE — FAIL OPEN, ALWAYS: missing Redis, disabled by env, a Redis
 *   error, or a slow Redis all return "not blocked". A defence-in-depth control
 *   must never become an availability risk.
 *
 * WHY THE HARD TIMEOUT (the one divergence from the alert service): that service
 *   is fire-and-forget, so its connect latency never touches a response. This
 *   call is awaited, and with lazyConnect + enableOfflineQueue a hard-down Redis
 *   can hold a command until ioredis's ~10s connect timeout. ACCEPTED
 *   DEGRADATION: a serverless cold start pays TCP + TLS, so the first few
 *   failures after one can lose the race and go UNCOUNTED — never half-counted,
 *   because the count is one atomic script (see AUTH_FAILURE_COUNT_SCRIPT).
 *
 * BUCKET SPOOFING: main.ts sets `trust proxy = 1`, so req.ips holds exactly one
 *   entry, written by the trusted edge proxy, which a client cannot forge. Raising trust
 *   proxy above 1 would make req.ips[0] attacker-controlled and silently turn
 *   this control into decoration.
 *
 * ONE COUNT PER FAILED REQUEST even on the five controllers that ALSO apply
 *   CombinedAuthGuard at controller scope: Nest runs global guards first and
 *   stops at the first throw, so the scoped instance never re-counts.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Redis key namespace for the per-IP failed-attempt counter. */
const KEY_NAMESPACE = 'auth-failure-throttle';

/**
 * Count one failure and arm the counter's TTL atomically, in ONE round trip.
 *
 * DO NOT split this into an INCR plus an `if count === 1` EXPIRE. A second
 * round trip can reject on its own, or still be in flight when the serverless
 * instance is reclaimed (the hazard customer-failure-alert.filter.ts wraps in
 * `waitUntil`). Either way the counter survives with no
 * TTL, so it never expires: that IP answers 429 forever, and the Slack
 * auth-failure alert goes dark for it because a 429 is not a 401.
 *
 * `TTL < 0` covers -1 and -2, so a counter that lost its TTL heals on the next
 * failure. Arming only when there is none keeps the window anchored to the
 * first failure, so a steady drip still expires instead of sliding forever.
 */
export const AUTH_FAILURE_COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * Deliberately 10x the auth_401 alert threshold (5), for two independent
 * reasons:
 *   1. The Slack auth-failure alert must fire well BEFORE the block engages, or
 *      throttling would starve the very signal that says an attack is
 *      underway.
 *   2. apps/dashboard's "send a test event" server action POSTs a user-pasted
 *      key from the dashboard host's egress IP, which a serverless host shares
 *      across every user, so every customer who fat-fingers a key during
 *      onboarding lands in ONE bucket. 50 buys headroom against blocking an
 *      onboarding customer for someone else's typo, and still caps enumeration
 *      at 200 verdicts per IP per hour.
 */
const DEFAULT_THRESHOLD = 50;
const DEFAULT_WINDOW_SECONDS = 900;
const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_ALERT_THRESHOLD = 5;

/** Request facts for the engagement log line. Never the key. */
export interface AuthFailureRequestFacts {
  path?: string | null;
  method?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthFailureThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthFailureThrottleService.name);
  private readonly redis: Redis | null;
  private readonly degraded: boolean;

  private readonly enabled: boolean;
  private readonly threshold: number;
  private readonly windowSeconds: number;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.configService.get<string>('AUTH_FAILURE_THROTTLE_ENABLED') !== 'false';
    this.threshold = this.readPositiveInt('AUTH_FAILURE_THROTTLE_THRESHOLD', DEFAULT_THRESHOLD);
    this.windowSeconds = this.readPositiveInt(
      'AUTH_FAILURE_THROTTLE_WINDOW_SECONDS',
      DEFAULT_WINDOW_SECONDS,
    );
    this.timeoutMs = this.readPositiveInt('AUTH_FAILURE_THROTTLE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

    const alertThreshold = this.readPositiveInt(
      'AUTH_FAILURE_ALERT_THRESHOLD',
      DEFAULT_ALERT_THRESHOLD,
    );
    if (this.threshold <= alertThreshold) {
      this.logger.warn(
        `[AuthFailureThrottleService] AUTH_FAILURE_THROTTLE_THRESHOLD (${this.threshold}) is at or ` +
          `below AUTH_FAILURE_ALERT_THRESHOLD (${alertThreshold}). The throttle will start blocking ` +
          'before the Slack auth-failure alert can reach its own threshold, so the alert goes dark. ' +
          'Raise the throttle threshold above the alert threshold.',
      );
    }

    if (!this.enabled) {
      this.logger.warn(
        '[AuthFailureThrottleService] AUTH_FAILURE_THROTTLE_ENABLED=false — failed api-key ' +
          'attempts are NOT throttled. Unset it to turn the throttle back on.',
      );
      this.redis = null;
      this.degraded = true;
      return;
    }

    const redisUrl =
      this.configService.get<string>('REDIS_URL_REDIS_URL') ||
      this.configService.get<string>('REDIS_URL');

    if (!redisUrl) {
      this.logger.error(
        '[AuthFailureThrottleService] no REDIS_URL configured — failed api-key attempts are ' +
          'NOT throttled until Redis is restored. Auth itself is unaffected.',
      );
      this.redis = null;
      this.degraded = true;
      return;
    }

    try {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        // MUST be true on serverless + lazyConnect: the first count after a cold
        // start fires before the TCP handshake completes, and with the queue off
        // ioredis throws "Stream isn't writeable" and the count is lost exactly
        // when a burst starts. The alert service uses the same setting.
        enableOfflineQueue: true,
      });
      this.redis.on('error', (err) => {
        this.logger.warn(`[AuthFailureThrottleService] Redis error: ${err.message}`);
      });
      this.degraded = false;
    } catch (err) {
      this.logger.error(
        `[AuthFailureThrottleService] failed to construct Redis client: ${(err as Error).message}. ` +
          'Failed api-key attempts are NOT throttled.',
      );
      this.redis = null;
      this.degraded = true;
    }
  }

  /**
   * Count one FAILED api-key attempt from `callerIp` and report whether that IP
   * is now over its budget. Call this ONLY once a credential verdict exists and
   * that verdict is a rejection — never on a successful auth (the hot path must
   * pay zero Redis calls) and never on an infrastructure fault.
   *
   * Returns false on every degraded path. Never throws.
   */
  async recordFailureAndCheckLimit(
    callerIp: string,
    facts: AuthFailureRequestFacts = {},
  ): Promise<boolean> {
    if (!this.redis || this.degraded) {
      return false;
    }

    try {
      const count = await this.withTimeout(this.countFailure(callerIp));
      if (count === null) {
        return false;
      }

      // INCR is atomic, so exactly one caller ever observes threshold + 1. That
      // makes this the engagement moment: log and report it once per window
      // instead of once per blocked request during a storm.
      if (count === this.threshold + 1) {
        this.reportEngagement(callerIp, count, facts);
      }

      return count > this.threshold;
    } catch (err) {
      this.logger.warn(
        `[AuthFailureThrottleService] failed counting an auth failure for ${callerIp}: ` +
          `${(err as Error).message}. Not throttling this request.`,
      );
      return false;
    }
  }

  private async countFailure(callerIp: string): Promise<number> {
    const countKey = `${KEY_NAMESPACE}:count:ip:${callerIp}`;
    const count = await this.redis!.eval(
      AUTH_FAILURE_COUNT_SCRIPT,
      1,
      countKey,
      String(this.windowSeconds),
    );
    return Number(count);
  }

  /**
   * Resolve to null rather than hang. See the file header: this is the only
   * thing standing between a Redis outage and ~10s added to every failed-auth
   * response.
   *
   * Safe to abandon `work` mid-flight only because it is a single atomic EXEC:
   * losing this race drops the RESULT, never leaves half of it applied.
   */
  private async withTimeout(work: Promise<number>): Promise<number | null> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });
    try {
      return await Promise.race([work, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The ONLY signal this control produces, in both directions: an attack being
   * capped, or a false positive being caused. Anonymous scanner
   * floods never reach the Slack auth_401 alert (the filter's customer-shape
   * gate drops them), so without this a blocked storm would be invisible.
   */
  private reportEngagement(callerIp: string, count: number, facts: AuthFailureRequestFacts): void {
    this.logger.warn(
      `[AuthFailureThrottleService] failed-auth throttle engaged for ${callerIp} — ` +
        `${count} failed api-key attempts in the last ${this.windowSeconds}s ` +
        `(threshold ${this.threshold}). Further failed attempts from this IP answer 429 ` +
        'until the window expires. A valid key from this IP is unaffected. ' +
        `Last attempt: ${facts.method ?? '?'} ${facts.path ?? '?'} ` +
        `user-agent="${facts.userAgent ?? 'none'}".`,
    );
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
  }
}
