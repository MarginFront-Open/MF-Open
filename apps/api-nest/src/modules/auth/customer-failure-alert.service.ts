/**
 * WHAT THIS FILE DOES:
 *   Counts customer-facing failures (by FAILURE CLASS) in Redis and, once a
 *   given caller crosses that class's threshold inside its sliding window, fires
 *   a single Slack alert into the alerts channel so the operator sees "a customer is
 *   silently failing" the same day — instead of those 4xx dying in the logs.
 *
 *   It is the ONE alerter for every customer-shaped failure class the SDK
 *   ingest path can produce:
 *     - auth_401   — credential rejected (rotated/revoked/typo'd key).        [global filter]
 *     - bad_data   — 400/422 from a customer-integration surface (sdk/mcp/ccc) —
 *                    malformed ingest events dropped. The filter does NOT route a
 *                    dashboard/portal/raw-api 400 here.                       [global filter]
 *     - forbidden  — the publishable-key-write 403 ONLY (a distinguishable
 *                    ForbiddenException subclass); other 403s are ignored.    [global filter]
 *     - rate_limit — 429 throttle. A GROWTH signal, not an incident.          [global filter]
 *   Each class carries its OWN threshold / window / cooldown / message copy
 *   (ConfigService knobs with sane defaults) via FAILURE_CLASSES below.
 *
 * WHY IT EXISTS:
 *   A customer's integration can break (or strain) in ways that return a bare
 *   4xx and die silently: no log says WHO failed, and nothing pages the operator
 *   when a paying customer's events start bouncing. This service is the alerting half.
 *   The attribution half lives in PublishableKeyWriteGuardInterceptor (403, which
 *   throws the distinguishable exception) and CustomerFailureAlertFilter (the
 *   unified 401/400/403/429 catch, and it owns 401 too; CombinedAuthGuard
 *   records nothing). Crucially, this is Sentry-FREE: alerts must reach an
 *   operator even when Sentry is down or unconfigured, so it POSTs straight to a
 *   Slack incoming webhook.
 *
 * MODELED ON: webhook-dedupe.service.ts — same Redis resolution
 *   (REDIS_URL_REDIS_URL || REDIS_URL), same lazyConnect + enableOfflineQueue +
 *   maxRetriesPerRequest:2, same OnModuleDestroy quit, same NO-in-memory-Map
 *   rule. The one deliberate divergence: no Sentry (see above).
 *
 * DEGRADED POSTURE (mirrors webhook-dedupe's fail-CLOSED = never-block stance):
 *   webhook-dedupe is "fail-closed" meaning it never blocks the webhook. This
 *   service is the same shape applied to alerting: if Redis is missing/errors,
 *   or no Slack webhook is configured, we SKIP THE ALERT and return. We never
 *   block the request and never change the HTTP status; the caller (the global
 *   filter) already wraps our call so it cannot throw, and we are
 *   internally fail-open on top of that. Observability degrading must never
 *   become a customer-facing outage.
 *
 * KEYING & TRUST (mandatory):
 *   - PRE-auth failures (auth_401): there is no validated principal. We key the
 *     counter on the CALLER IP, NOT the claimed email. The claimed email is
 *     attacker-controlled body content on a rejected request; keying on it would
 *     (a) let a varying-email flood evade the threshold and (b) balloon Redis key
 *     cardinality. The email rides along as a LOGGED/ALERTED attribute only, and
 *     is already sanitized + length-capped + labeled "claimed/untrusted" by
 *     extract-claimed-identity.ts.
 *   - POST-auth failures (bad_data / forbidden / rate_limit): the request ALREADY
 *     passed the auth guard, so `organizationId` is a VALIDATED, trusted fact. We
 *     key on `org:<organizationId>` and surface the trusted org + email directly.
 *     A trusted failure skips the scanner-noise gate (it can't be anonymous
 *     internet noise — it authenticated).
 *   - The raw API key is never handled here; only the redacted fingerprint from
 *     the (untrusted) identity object is surfaced.
 *
 * The trust level is DERIVED, not passed: a context with `organizationId` set is
 * trusted (post-auth); without it, untrusted (pre-auth / fallback). That keeps
 * every call site a one-liner: the caller hands over whatever facts it has.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import type { Source } from '../../lib/request-source';
import {
  formatUtcDay,
  type RevokedKeyFacts,
} from '../../common/exceptions/revoked-api-key.exception';
import { RevokedKeyNoticeService } from './revoked-key-notice.service';

/**
 * The failure classes this service alerts on. Each maps to a config block in
 * FAILURE_CLASSES (own threshold / window / cooldown / Redis namespace / copy).
 *   - auth_401:   pre-auth credential rejection, recorded by the global filter.
 *   - bad_data:   400/422 validation failure on a customer-integration surface,
 *                 recorded by the global filter (which gates out non-ingest 400s).
 *   - forbidden:  the publishable-key-write 403 only, recorded by the filter.
 *   - rate_limit: 429 throttle — a GROWTH signal, recorded by the filter.
 */
export type CustomerFailureClass = 'auth_401' | 'bad_data' | 'forbidden' | 'rate_limit';

/**
 * Everything the alerter needs to count + attribute one failure. All fields are
 * optional and defensively read — a caller hands us whatever it has.
 *
 * Note the field names are a SUPERSET of ClaimedIdentity (claimedEmail,
 * callerIp, path, source, keyFingerprint, recognizedCredential), so the 401
 * path can pass its ClaimedIdentity straight through with no remapping.
 */
export interface CustomerFailureContext {
  // ---- TRUSTED attribution (present only post-auth) ----
  /**
   * Validated tenant id. Its PRESENCE is what makes this failure "trusted": we
   * bucket the counter on `org:<organizationId>` and skip the scanner gate.
   */
  organizationId?: string;
  organizationName?: string;
  /** Trusted, verified email of the authenticated principal (post-auth). */
  email?: string;

  // ---- UNTRUSTED / claimed attribution (pre-auth 401 + fallback) ----
  /** Email/customer-id the caller CLAIMED in the request body. Untrusted. */
  claimedEmail?: string;
  /** Redacted one-way fingerprint of the presented credential. NEVER the key. */
  keyFingerprint?: string;
  /** True only if the presented credential had a recognized MarginFront prefix. */
  recognizedCredential?: boolean;

  /**
   * Present ONLY when the rejected credential matched a REVOKED key row
   *Unlike every other field in this block, these facts come off
   * the validated DB row — trusted even though the request never
   * authenticated. They travel as ONE object (never flattened). They must NEVER
   * populate `organizationId` above: that field flips the trusted bucketing
   * path, and an unauthenticated caller must keep counting against its IP.
   */
  revokedKey?: RevokedKeyFacts;

  /**
   * Present ONLY when the caller authenticated with a login token (a JWT, or a
   * session with no active org) and hit an API-key-only endpoint.
   * Read off the VALIDATED principal. Same rule as revokedKey: these must never
   * populate `organizationId` — this principal has no org and the count must
   * stay on its IP.
   */
  authMethodMismatch?: { authMethod?: string; email?: string };

  // ---- SHARED facts (either path) ----
  /** Best-effort client IP — the bucket key for untrusted failures. */
  callerIp?: string;
  /** Request path ("which endpoint is failing"). */
  path?: string;
  /** HTTP method (handy for the 403 publishable-key-write case). */
  method?: string;
  /** Caller surface inferred from the User-Agent (sdk / ccc / api / ...). */
  source?: Source;
}

/** Per-class tunables resolved once at construction from ConfigService. */
interface ResolvedClassConfig {
  /** Redis key namespace, e.g. `auth-failure` or `customer-failure:bad-data`. */
  keyNamespace: string;
  /** How many failures inside the window before we page. */
  threshold: number;
  /** Sliding window length, anchored to the first failure. */
  windowSeconds: number;
  /** One alert per bucket per this many seconds (keeps Slack quiet in an outage). */
  cooldownSeconds: number;
}

/**
 * Static blueprint for every failure class: its Redis namespace, the env-var
 * prefix that overrides its tunables, and the sane defaults.
 *
 * auth_401 uses the `auth-failure` namespace and `AUTH_FAILURE_ALERT_*` env names
 * VERBATIM: other code and deployed config read those exact names.
 *
 * Defaults are tuned for "a real customer broke", not "block an attacker":
 *   - auth_401 / bad_data / forbidden: 5 failures in 15 min, one alert/hour.
 *     Well above the occasional fat-fingered request, trips fast when an
 *     integration is hard-down.
 *   - rate_limit is DELIBERATELY different: hitting a rate limit produces many
 *     429s fast and is GOOD news (the customer wants to send more), not an
 *     incident. A higher threshold (50) over a short window (5 min) with a long
 *     6-hour cooldown means "this customer is sustainably bumping the ceiling" —
 *     a capacity signal, surfaced at most a few times a day, never a page-storm.
 */
const FAILURE_CLASSES: Record<
  CustomerFailureClass,
  {
    keyNamespace: string;
    envPrefix: string;
    defaultThreshold: number;
    defaultWindowSeconds: number;
    defaultCooldownSeconds: number;
  }
> = {
  auth_401: {
    keyNamespace: 'auth-failure',
    envPrefix: 'AUTH_FAILURE_ALERT',
    defaultThreshold: 5,
    defaultWindowSeconds: 900, // 15 minutes
    defaultCooldownSeconds: 3600, // 1 hour
  },
  bad_data: {
    keyNamespace: 'customer-failure:bad-data',
    envPrefix: 'CUSTOMER_FAILURE_BAD_DATA',
    defaultThreshold: 5,
    defaultWindowSeconds: 900,
    defaultCooldownSeconds: 3600,
  },
  forbidden: {
    keyNamespace: 'customer-failure:forbidden',
    envPrefix: 'CUSTOMER_FAILURE_FORBIDDEN',
    defaultThreshold: 5,
    defaultWindowSeconds: 900,
    defaultCooldownSeconds: 3600,
  },
  rate_limit: {
    keyNamespace: 'customer-failure:rate-limit',
    envPrefix: 'CUSTOMER_FAILURE_RATE_LIMIT',
    defaultThreshold: 50,
    defaultWindowSeconds: 300, // 5 minutes
    defaultCooldownSeconds: 21600, // 6 hours
  },
};

// Caller surfaces that unambiguously mean "one of our SDK, MCP or code-cost-clarity packages is
// talking to us" — our own clients set these distinctive User-Agents. A failure
// from one of these is customer-integration traffic worth paging on.
// Deliberately EXCLUDES 'api' (the detectSource fallback for no/unknown UA —
// i.e. raw scanners and bots), 'dashboard' (expired browser sessions), and
// 'portal' (logged-out portal browsers). Those are the noise sources that would
// otherwise bury the real signal. This gate only matters for UNTRUSTED failures;
// trusted (post-auth) failures already proved they're a real account.
const CUSTOMER_INTEGRATION_SOURCES: ReadonlySet<string> = new Set(['sdk', 'mcp', 'ccc']);

/**
 * True when the caller surface is one of our customer-integration packages
 * (sdk/mcp/ccc) — i.e. real customer-integration traffic, not a browser/dashboard
 * session, a customer-portal browser, or an anonymous scanner.
 *
 * Exported as the SINGLE source of truth for "is this the customer-integration
 * path?" Used here by the untrusted scanner-noise gate (isCustomerShaped) AND by
 * the global filter, which uses it to decide whether a 400/422 is genuinely
 * "dropped ingest events" (bad_data) vs an unrelated dashboard/api 400 that must
 * NOT be paged with malformed-events copy.
 */
export function isCustomerIntegrationSource(source?: string): boolean {
  return !!source && CUSTOMER_INTEGRATION_SOURCES.has(source);
}

// Junk credentials internet scanners spray at every API. A match — when the
// request carried NO claimed identity (see buildAlertText) — swaps the auth_401 alert to
// calm scanner-noise copy; counting/threshold/cooldown are unchanged.
// Kept as PLAINTEXTS and hashed at module load with the exact fingerprint recipe of
// lib/extract-claimed-identity.ts (unrecognized prefix -> 'key_' + sha256 hex, 12 chars) so
// the set can never drift from the fingerprints the 401 path produces — and no hex to typo.
// No '' entry: readPresentedCredential returns undefined for an empty credential, so an
// empty-string fingerprint can never reach this gate.
const JUNK_CREDENTIAL_PLAINTEXTS = [
  'test',
  'null',
  'undefined',
  'demo',
  'example',
  'key',
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'changeme',
  'xxx',
  'YOUR_API_KEY',
  'sk-test',
];

const JUNK_CREDENTIAL_FINGERPRINTS: ReadonlySet<string> = new Set(
  JUNK_CREDENTIAL_PLAINTEXTS.map(
    (plaintext) => `key_${createHash('sha256').update(plaintext).digest('hex').slice(0, 12)}`,
  ),
);

function isJunkCredentialFingerprint(fingerprint?: string): boolean {
  return !!fingerprint && JUNK_CREDENTIAL_FINGERPRINTS.has(fingerprint);
}

@Injectable()
export class CustomerFailureAlertService implements OnModuleDestroy {
  private readonly logger = new Logger(CustomerFailureAlertService.name);
  private readonly redis: Redis | null;
  private readonly degraded: boolean;

  private readonly webhookUrl: string | null;
  /** Per-class tunables, resolved once at construction. */
  private readonly classConfig: Record<CustomerFailureClass, ResolvedClassConfig>;
  /** One owner email per org per this many seconds. */
  private readonly revokedKeyNoticeCooldownSeconds: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly revokedKeyNotice: RevokedKeyNoticeService,
  ) {
    this.webhookUrl = this.configService.get<string>('AUTH_FAILURE_SLACK_WEBHOOK_URL') || null;
    this.revokedKeyNoticeCooldownSeconds = this.readPositiveInt(
      'REVOKED_KEY_NOTICE_COOLDOWN_SECONDS',
      3600,
    );

    // Resolve every class's threshold/window/cooldown from its own env knobs,
    // falling back to the sane defaults in FAILURE_CLASSES.
    this.classConfig = (Object.keys(FAILURE_CLASSES) as CustomerFailureClass[]).reduce(
      (acc, failureClass) => {
        const blueprint = FAILURE_CLASSES[failureClass];
        acc[failureClass] = {
          keyNamespace: blueprint.keyNamespace,
          threshold: this.readPositiveInt(
            `${blueprint.envPrefix}_THRESHOLD`,
            blueprint.defaultThreshold,
          ),
          windowSeconds: this.readPositiveInt(
            `${blueprint.envPrefix}_WINDOW_SECONDS`,
            blueprint.defaultWindowSeconds,
          ),
          cooldownSeconds: this.readPositiveInt(
            `${blueprint.envPrefix}_COOLDOWN_SECONDS`,
            blueprint.defaultCooldownSeconds,
          ),
        };
        return acc;
      },
      {} as Record<CustomerFailureClass, ResolvedClassConfig>,
    );

    // Match the throttler's + webhook-dedupe's env-var resolution exactly.
    // A hosted Redis integration with an env prefix of "REDIS_URL" names the
    // variable REDIS_URL_REDIS_URL; accept either name so local dev with a bare
    // REDIS_URL works too.
    const redisUrl =
      this.configService.get<string>('REDIS_URL_REDIS_URL') ||
      this.configService.get<string>('REDIS_URL');

    if (!redisUrl) {
      // Degraded, but NON-fatal: the per-request attribution WARNs for the AUTH
      // classes still fire — auth_401 from the global CustomerFailureAlertFilter,
      // the publishable-key 403 from PublishableKeyWriteGuardInterceptor — so a
      // credential-shaped failure stays visible even with Redis down. (bad_data /
      // rate_limit are counting-only; they have no per-request line by design, so
      // they DO go dark here.) We can't COUNT across instances or alert. Log
      // once at construction; the per-request path stays silent so we don't spam.
      this.logger.error(
        '[CustomerFailureAlertService] no REDIS_URL configured — repeated-failure ' +
          'alerting is OFF until Redis is restored. Per-request 4xx attribution ' +
          'logs are unaffected.',
      );
      this.redis = null;
      this.degraded = true;
      return;
    }

    if (!this.webhookUrl) {
      // Redis is present but there's nowhere to send the alert. The webhook URL
      // is an operator env action (AUTH_FAILURE_SLACK_WEBHOOK_URL). Until it's
      // set, alerting can't fire — log once and treat alerting as degraded so
      // we don't accumulate counter keys for an alert that can never send.
      this.logger.warn(
        '[CustomerFailureAlertService] AUTH_FAILURE_SLACK_WEBHOOK_URL not set — ' +
          'customer-failure Slack alerts are disabled. Set it to an incoming-webhook URL for your alerts channel to turn them on.',
      );
    }

    try {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        // Best-effort, same as webhook-dedupe: if Redis is genuinely down we
        // want to fail fast and skip the alert rather than queue retries.
        maxRetriesPerRequest: 2,
        // MUST be true on serverless + lazyConnect: the first INCR after a
        // cold-start fires BEFORE the TCP handshake completes; with the queue
        // off, ioredis throws "Stream isn't writeable" and we'd silently lose
        // the count exactly when traffic spikes. Same setting as the throttler
        // and webhook-dedupe.
        enableOfflineQueue: true,
      });
      this.redis.on('error', (err) => {
        this.logger.warn(`[CustomerFailureAlertService] Redis error: ${err.message}`);
      });
      this.degraded = false;
    } catch (err) {
      this.logger.error(
        `[CustomerFailureAlertService] failed to construct Redis client: ${(err as Error).message}. ` +
          'Repeated-failure alerting is OFF.',
      );
      this.redis = null;
      this.degraded = true;
    }
  }

  /**
   * Record one failure of `failureClass` for the given caller. Atomically
   * increments a windowed per-bucket counter; when it crosses that class's
   * threshold and the per-bucket cooldown gate is open, posts a single Slack
   * alert in that class's copy.
   *
   * Fail-open on every path: missing Redis, missing webhook, or any Redis/HTTP
   * error → we SKIP the alert and return. We never throw and never change the
   * HTTP status the caller is about to send (callers also wrap this in
   * try/catch).
   */
  async recordFailure(
    failureClass: CustomerFailureClass,
    ctx: CustomerFailureContext,
  ): Promise<void> {
    // The owner-email decision sits ABOVE the webhook gate on
    // purpose — the customer must hear about their revoked key even in an
    // environment where the internal ops webhook is unset. It shares only the
    // Redis dependency (for its cooldown) and never throws.
    await this.maybeNotifyRevokedKeyOwner(ctx);

    // No Redis → can't count across instances. No webhook → nowhere to alert.
    // Either way there's nothing useful to do here. For the AUTH classes the
    // per-request attribution WARN already fired upstream (auth_401 in the global
    // filter, the publishable-key 403 in the interceptor); bad_data / rate_limit
    // are counting-only and leave no per-request line.
    if (!this.redis || this.degraded || !this.webhookUrl) {
      return;
    }

    // A validated org id means the request already passed auth — this is a real,
    // trusted account, not anonymous internet noise. Trust is DERIVED here, not
    // passed by the caller.
    const trusted = !!ctx.organizationId;

    // SCANNER-NOISE GATE — UNTRUSTED failures only. This gate governs
    // the COUNT and the Slack PAGE: they must only fire on failures that look like
    // a real customer's integration breaking, not anonymous internet noise. (The
    // filter applies the same customer-shape check even earlier for 401, so
    // scanner floods never build attribution OR emit a per-request log — see its
    // cheap pre-gate.) The global 401 choke
    // point in particular is hit by ALL unauthenticated traffic: expired
    // dashboard sessions, logged-out browsers, and — the dominant volume —
    // background bot/scanner traffic spraying garbage credentials. A single
    // scanner IP trivially clears the threshold; ungated, N scanner IPs => N
    // pages/hour and the alerts channel gets muted within a week. We only COUNT (and
    // therefore only ever alert on) customer-shaped failures.
    //
    // Trusted (post-auth) failures SKIP this gate: bad_data/forbidden/rate_limit
    // already authenticated, so they ARE a real account by definition — gating
    // them would drop genuine customer signal.
    if (!trusted && !this.isCustomerShaped(ctx)) {
      return;
    }

    const cfg = this.classConfig[failureClass];
    // Untrusted → bucket on the observed caller IP (can't be forged into another
    // tenant's bucket). Trusted → bucket on the validated org id.
    const bucket = trusted ? `org:${ctx.organizationId}` : ctx.callerIp || 'unknown';
    const countKey = `${cfg.keyNamespace}:count:${bucket}`;
    const cooldownKey = `${cfg.keyNamespace}:cooldown:${bucket}`;

    try {
      const count = await this.redis.incr(countKey);

      if (count === 1) {
        // First failure starts the sliding window. EXPIRE only on the first
        // increment so the window is anchored to the FIRST failure, not reset
        // by every subsequent one (otherwise a steady drip never expires).
        await this.redis.expire(countKey, cfg.windowSeconds);
      }

      if (count < cfg.threshold) {
        return;
      }

      // At/over threshold. The cooldown NX gate guarantees ONE alert per bucket
      // per cooldown window even though every failure beyond the threshold
      // reaches this branch — SET NX returns null while the cooldown key lives.
      const acquired = await this.redis.set(cooldownKey, '1', 'EX', cfg.cooldownSeconds, 'NX');
      if (acquired !== 'OK') {
        return;
      }

      await this.sendSlackAlert(failureClass, ctx, count, trusted);
    } catch (err) {
      // Skip the alert, never block or change the HTTP status. (Degraded ==
      // observability loss only; mirrors webhook-dedupe's never-block posture.)
      this.logger.error(
        `[CustomerFailureAlertService] failed recording/alerting ${failureClass} for bucket=${bucket}: ` +
          `${(err as Error).message}. Skipping alert; the response is unaffected.`,
      );
    }
  }

  /**
   * Email the org's alert recipients that their revoked key is
   * still in use — at most once per org per cooldown window (default 1h,
   * REVOKED_KEY_NOTICE_COOLDOWN_SECONDS).
   *
   * Keyed on ORG, not the IP bucket, on purpose: two broken deployments on two
   * IPs correctly produce two Slack alerts, but the owner needs ONE email. And
   * unlike the Slack path there is no threshold — a single rejected attempt is
   * already a broken deployment worth telling the owner about; the cooldown is
   * the spam control.
   *
   * Redis-dependent, webhook-independent: with Redis down there is no
   * cooldown, so we skip the email (fail-safe against spam) and log why.
   * Never throws.
   */
  private async maybeNotifyRevokedKeyOwner(ctx: CustomerFailureContext): Promise<void> {
    const revokedKey = ctx.revokedKey;
    if (!revokedKey) {
      return;
    }

    if (!this.redis || this.degraded) {
      this.logger.warn(
        `[CustomerFailureAlertService] revoked key in use for org ${revokedKey.organizationId} ` +
          'but Redis is unavailable — skipping the owner email (no cooldown, so sending ' +
          'would spam; fail-safe).',
      );
      return;
    }

    try {
      const attemptsKey = `revoked-key-notice:attempts:org:${revokedKey.organizationId}`;
      const attempts = await this.redis.incr(attemptsKey);
      if (attempts === 1) {
        await this.redis.expire(attemptsKey, this.revokedKeyNoticeCooldownSeconds);
      }

      const cooldownKey = `revoked-key-notice:cooldown:org:${revokedKey.organizationId}`;
      const acquired = await this.redis.set(
        cooldownKey,
        '1',
        'EX',
        this.revokedKeyNoticeCooldownSeconds,
        'NX',
      );
      if (acquired !== 'OK') {
        return;
      }

      await this.revokedKeyNotice.notify(revokedKey, attempts);
    } catch (err) {
      this.logger.error(
        `[CustomerFailureAlertService] revoked-key owner notice failed for org ` +
          `${revokedKey.organizationId}: ${(err as Error).message}. The Slack path and ` +
          'the response are unaffected.',
      );
    }
  }

  /**
   * Is this UNTRUSTED rejected request shaped like a real customer integration
   * failing, as opposed to anonymous scanner/session noise? True when ANY of:
   *   1. the body carried a claimed customer identity (claimedEmail) — only our
   *      clients send that, OR
   *   2. the caller presented a RECOGNIZED MarginFront credential (a key with a
   *      known mf_sk_/mf_pk_/prtl_ prefix that simply failed validation —
   *      i.e. a rotated/revoked/typo'd real key), OR
   *   3. the User-Agent identifies one of our packages (sdk / mcp / ccc).
   *
   * All three are things a random internet scanner won't produce. Only ever
   * consulted for untrusted failures (trusted ones already authenticated).
   */
  private isCustomerShaped(ctx: CustomerFailureContext): boolean {
    return (
      !!ctx.claimedEmail ||
      ctx.recognizedCredential === true ||
      isCustomerIntegrationSource(ctx.source)
    );
  }

  /**
   * POST the alert to the Slack incoming webhook. Plain `fetch`, no SDK, no
   * Sentry — this path must work when everything else is down. Wrapped so a
   * Slack outage can't propagate out of recordFailure. The copy is per-class so
   * an incident (bad_data) reads nothing like a growth nudge (rate_limit).
   */
  private async sendSlackAlert(
    failureClass: CustomerFailureClass,
    ctx: CustomerFailureContext,
    count: number,
    trusted: boolean,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    const text = this.buildAlertText(failureClass, ctx, count, trusted);

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      this.logger.error(
        `[CustomerFailureAlertService] Slack webhook returned ${response.status}; ` +
          `${failureClass} alert not delivered.`,
      );
      return;
    }

    this.logger.warn(
      `[CustomerFailureAlertService] ${failureClass} alert sent ` +
        `(count=${count}, org=${ctx.organizationId ?? 'none'}, ip=${ctx.callerIp ?? 'none'}).`,
    );
  }

  /**
   * Build the per-class Slack message. Each class gets its own emoji, headline,
   * and framing so they're triageable at a glance — and so the 429 growth signal
   * never reads like an incident.
   */
  private buildAlertText(
    failureClass: CustomerFailureClass,
    ctx: CustomerFailureContext,
    count: number,
    trusted: boolean,
  ): string {
    const cfg = this.classConfig[failureClass];
    const minutes = Math.round(cfg.windowSeconds / 60);

    // "Who" lines differ by trust level: a verified org for post-auth failures,
    // the sanitized "claimed/untrusted" id + IP for pre-auth ones.
    const whoLines = trusted
      ? [
          `• *org:* ${ctx.organizationName ?? ctx.organizationId}`,
          `• *email:* ${ctx.email ?? 'unknown'}`,
        ]
      : [
          `• *claimed/untrusted id:* ${ctx.claimedEmail ?? 'unknown'}`,
          `• *caller IP:* ${ctx.callerIp ?? 'unknown'}`,
        ];
    const where = [`• *path:* ${ctx.path ?? 'unknown'}`, `• *source:* ${ctx.source ?? 'unknown'}`];

    switch (failureClass) {
      case 'bad_data':
        // The most urgent class: a customer's events are being dropped.
        // Note: colon, not an em-dash — this string can land in Slack copy.
        return [
          `:rotating_light: *Customer sending malformed events*`,
          `A customer is sending malformed events: every POST is being dropped. ` +
            `${count} bad-data rejections (400/422) in the last ${minutes} min ` +
            `(threshold ${cfg.threshold}).`,
          ...whoLines,
          ...where,
          `_Their integration is failing validation. Reach out before the dropped ` +
            `events cost them (and us) the account._`,
        ].join('\n');

      case 'forbidden':
        return [
          `:no_entry: *Publishable key used for writes*`,
          `A customer is using a publishable key (mf_pk_) to write: the writes ` +
            `are being rejected (403). ${count} rejections in the last ${minutes} ` +
            `min (threshold ${cfg.threshold}).`,
          ...whoLines,
          ...where,
          `_Publishable keys are read-only by design. They likely need to switch ` +
            `to a secret key (mf_sk_) for create/update/delete calls._`,
        ].join('\n');

      case 'rate_limit':
        // GROWTH SIGNAL, not an incident — distinct emoji + framing on purpose.
        return [
          `:chart_with_upwards_trend: *Customer hitting their rate limit*`,
          `A customer is hitting their rate limit: they may want to send more. ` +
            `${count} throttled requests (429) in the last ${minutes} min.`,
          ...whoLines,
          ...where,
          `_This is a growth signal, not an incident. Consider reaching out about ` +
            `a higher limit or an upgrade._`,
        ].join('\n');

      case 'auth_401':
      default:
        // The rejected credential matched a REVOKED row, so we can
        // name the org and key with confidence — the facts came from the DB,
        // not the request. Revoked keys with NULL hashes
        // never match, and keep the verbatim copy below.
        if (ctx.revokedKey) {
          return [
            `:rotating_light: *Revoked API key still in use*`,
            `A revoked key is still being sent and rejected: ${count} attempts in the last ` +
              `${minutes} min (threshold ${cfg.threshold}).`,
            `• *org:* ${ctx.revokedKey.organizationName ?? ctx.revokedKey.organizationId}`,
            `• *key:* ${ctx.revokedKey.keyLabel}`,
            `• *revoked:* ${formatUtcDay(ctx.revokedKey.revokedAt)}`,
            `• *caller IP:* ${ctx.callerIp ?? 'unknown'}`,
            `• *path:* ${ctx.path ?? 'unknown'}`,
            `• *source:* ${ctx.source ?? 'unknown'}`,
            `_Their client is still sending the old key; they need to swap in a new one._`,
          ].join('\n');
        }
        // The verbatim copy below asserts "a real customer's key
        // broke," which sends triage hunting for a key this caller never
        // presented. The filter sets these facts only when no recognized key was
        // presented, so a broken-key-plus-login-token caller still gets that copy.
        if (ctx.authMethodMismatch) {
          return [
            `:satellite: *Login token sent to the usage ingest endpoint*`,
            `Someone is calling usage ingest with a dashboard login token instead of an API ` +
              `key: ${count} rejections in the last ${minutes} min (threshold ${cfg.threshold}).`,
            `• *signed-in user:* ${ctx.authMethodMismatch.email ?? 'unknown'}`,
            `• *auth method:* ${ctx.authMethodMismatch.authMethod ?? 'unknown'}`,
            `• *caller IP:* ${ctx.callerIp ?? 'unknown'}`,
            `• *path:* ${ctx.path ?? 'unknown'}`,
            `• *source:* ${ctx.source ?? 'unknown'}`,
            `_Their credential is valid, it just is not an API key. Point them at ` +
              `Build > API keys and the x-api-key header._`,
          ].join('\n');
        }
        // Scanner spraying a well-known junk credential ("test", "null", ...): same counting,
        // same threshold, same cooldown — only the WORDS change, because "a real customer's
        // key broke" is exactly wrong for this traffic. Calm copy, colon not em-dash.
        // ONLY when there is no claimed identity: a claimedEmail means a possibly-real
        // onboarding customer pasting a placeholder ("YOUR_API_KEY", "test"), which must
        // page as a customer failure. Mirrors clause 1 of isCustomerShaped above: a
        // claimed identity is customer signal, junk key or not.
        if (!ctx.claimedEmail && isJunkCredentialFingerprint(ctx.keyFingerprint)) {
          return [
            `:satellite: *API scanner probe: junk credential rejected*`,
            `A scanner/bot is spraying a well-known junk credential (like "test"): rejected ` +
              `${count} times in the last ${minutes} min from ${ctx.callerIp ?? 'unknown'} ` +
              `(threshold ${cfg.threshold}).`,
            `• *claimed/untrusted id:* ${ctx.claimedEmail ?? 'unknown'}`,
            `• *key fingerprint:* ${ctx.keyFingerprint}`,
            `• *path:* ${ctx.path ?? 'unknown'}`,
            `• *source:* ${ctx.source ?? 'unknown'}`,
            `_No customer impact; auth is doing its job. This is scanner/probe noise, not a ` +
              `customer's broken key._`,
          ].join('\n');
        }
        // Copy pinned VERBATIM by the spec.
        return (
          `:rotating_light: *SDK auth failures detected*\n` +
          `A caller has failed authentication ${count} times in the last ` +
          `${minutes} min (threshold ${cfg.threshold}).\n` +
          `• *claimed/untrusted id:* ${ctx.claimedEmail ?? 'unknown'}\n` +
          `• *caller IP:* ${ctx.callerIp}\n` +
          `• *path:* ${ctx.path ?? 'unknown'}\n` +
          `• *source:* ${ctx.source}\n` +
          `• *key fingerprint:* ${ctx.keyFingerprint ?? 'none'}\n` +
          `_Likely a real customer's key broke (rotated/revoked/typo). The "claimed" ` +
          `id is from the rejected request body and is not verified._`
        );
    }
  }

  /**
   * Read a positive integer env knob, falling back to the default for unset,
   * non-numeric, or non-positive values. A misconfigured threshold should never
   * disable alerting or set a zero/negative window.
   */
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
