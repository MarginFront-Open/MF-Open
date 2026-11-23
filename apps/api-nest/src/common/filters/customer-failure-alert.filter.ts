/**
 * WHAT THIS FILE DOES:
 *   The ONE global exception filter that turns customer-shaped 4xx failures into
 *   Slack alerts. It wraps Sentry's own global filter (SentryGlobalFilter) so
 *   that, on top of everything Sentry already does, it ALSO feeds
 *   CustomerFailureAlertService for the failure classes operators care about:
 *     - 400 / 422  → "bad_data"   ONLY from a customer-integration surface
 *                    (sdk/mcp/ccc): malformed ingest events being dropped. A
 *                    dashboard/portal/raw-api 400 (a form validation
 *                    error, a business-rule 400) is NOT this and is ignored.
 *     - 401        → "auth_401"   credential rejected (rotated/revoked/typo'd key).
 *                    This filter, not the guard, owns 401, so 401 attribution
 *                    lives in ONE place alongside every other class. req.user MAY be set on a 401 but
 *                    carries no organizationId, so we attribute via the
 *                    UNTRUSTED path (extractClaimedIdentity, keyed on IP) — the
 *                    organizationId check, NOT the user check, is what selects the
 *                    trusted bucket. The 401
 *                    choke point is hit by the ENTIRE unauthenticated internet, so
 *                    it only pages when the request is CUSTOMER-SHAPED; anonymous
 *                    scanner floods are short-circuited CHEAPLY (see
 *                    recordCustomerFailure) BEFORE any attribution work — the hot
 *                    401 path stays cheap.
 *     - 403        → "forbidden"  ONLY the publishable-key-write rejection (a
 *                    distinguishable ForbiddenException subclass). Every other
 *                    403 — RBAC denials, owner-only guards — is ignored.
 *     - 429        → "rate_limit"  (throttle — a GROWTH signal, not an incident),
 *                    EXCEPT the failed-auth 429, which is an
 *                    unauthenticated bad-key probe storm and pages nothing.
 *   404 is OFF (scanner noise). Every 5xx is left entirely to super.catch.
 *
 * WHY bad_data / forbidden ARE NARROWER THAN THE BARE HTTP STATUS:
 *   Each class's Slack copy ASSERTS a specific root cause ("a customer is sending
 *   malformed events", "a customer is using a publishable key to write"). Routing
 *   on status alone would fire that confident copy on ANY 400 or ANY 403 in the
 *   app — including trusted, post-auth dashboard 400s and RBAC 403s, which SKIP
 *   the scanner-noise gate and would page the alerts channel with a flatly wrong
 *   cause. So we narrow at classification time: bad_data needs the ingest surface
 *   and forbidden needs the exception's identity.
 *
 * WHY IT WRAPS SentryGlobalFilter INSTEAD OF SITTING BESIDE IT:
 *   Nest runs exactly ONE global exception filter (the last APP_FILTER wins for
 *   a given exception). SentryGlobalFilter is what forwards uncaught (5xx) errors
 *   to Sentry and renders the HTTP error response. We must not displace that — so
 *   we EXTEND it and add our alerting as a side-effect, then defer to it.
 *
 * THE TWO LOAD-BEARING INVARIANTS (read before touching catch()):
 *   1. ALWAYS-super.catch — super.catch(exception, host) runs on EVERY code path.
 *      It is what forwards non-HttpException (5xx) errors to Sentry and renders
 *      the response. An early return before it means Sentry captures nothing,
 *      silently. Never early-return before super.catch.
 *   2. NEVER-throw side-effect — the alerting side-effect is wrapped so it can
 *      never throw and never blocks the response. Observability must never become
 *      a customer-facing outage. recordFailure is fire-and-forget (the filter is
 *      synchronous; the response must not wait on Redis/Slack).
 */
import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { waitUntil } from '@vercel/functions';
import {
  CustomerFailureAlertService,
  isCustomerIntegrationSource,
  type CustomerFailureClass,
  type CustomerFailureContext,
} from '../../modules/auth/customer-failure-alert.service';
import {
  extractClaimedIdentity,
  isClaimedIdentityCustomerShaped,
} from '../../modules/auth/lib/extract-claimed-identity';
import { PublishableKeyWriteForbiddenException } from '../exceptions/publishable-key-write-forbidden.exception';
import { RevokedApiKeyException } from '../exceptions/revoked-api-key.exception';
import { OrganizationRequiredException } from '../exceptions/organization-required.exception';
import { TooManyAuthFailuresException } from '../exceptions/too-many-auth-failures.exception';
import type { Source } from '../../lib/request-source';

// Statuses that COULD be a customer-failure class. Anything else — 404 (off) and
// every 5xx (incl. non-HttpException, whose status is null) — bails BEFORE we
// touch the request. 401 is IN this set: this filter owns the 'auth_401' class.
// CombinedAuthGuard records nothing, so there is exactly ONE recorder for 401
// and no double-page. The hot 401 scanner-flood path is kept cheap by an extra
// short-circuit in recordCustomerFailure, NOT by excluding 401 here.
const CANDIDATE_STATUSES: ReadonlySet<number> = new Set([400, 401, 422, 403, 429]);

/**
 * Decide which failure class (if any) a rejected request belongs to. Pure +
 * side-effect-free. Two of the four classes (bad_data, forbidden) are
 * deliberately NARROWER than the bare HTTP status because each one's Slack copy
 * asserts a specific root cause that must be TRUE, or the alert mis-attributes
 * (see file header):
 *
 *   - bad_data (400/422): the copy claims "a customer is sending malformed
 *     events" — an SDK-INGEST claim. Only treat a 400/422 as bad_data when it
 *     actually came from a customer-integration surface (sdk/mcp/ccc). A
 *     dashboard form's 400, a portal 400, or a raw-api 400 → null.
 *
 *   - auth_401 (401): credential rejected. Status alone IS the class — a 401 is a
 *     401 regardless of surface. We do NOT make the customer-shaped-vs-scanner
 *     decision here (this function stays pure + status-only); that gate is
 *     enforced two ways downstream: a cheap short-circuit in recordCustomerFailure
 *     (so scanner floods never build attribution) AND the service's own
 *     scanner-noise gate for untrusted classes (so they never page).
 *
 *   - forbidden (403): the copy claims "a customer is using a publishable key to
 *     write." That is exactly ONE of 10+ ForbiddenException sources (RBAC denials,
 *     owner-only guards, etc. are all 403). Only the interceptor's distinguishable
 *     subclass means that — every other 403 → null.
 *
 *   - rate_limit (429): a throttle is a throttle regardless of surface, and the
 *     copy is a growth nudge, not a root-cause claim. The one exclusion is the
 *     failed-auth 429 (TooManyAuthFailuresException).
 */
function classifyCustomerFailure(
  exception: unknown,
  status: number,
  source: Source | undefined,
): CustomerFailureClass | null {
  switch (status) {
    case 400:
    case 422:
      return isCustomerIntegrationSource(source) ? 'bad_data' : null;
    case 401:
      // Credential rejected. The customer-shaped vs scanner-noise decision is
      // made by recordCustomerFailure's cheap pre-gate + the service gate, not
      // here — keep this classifier pure and status-only.
      return 'auth_401';
    case 403:
      return exception instanceof PublishableKeyWriteForbiddenException ? 'forbidden' : null;
    case 429:
      // Throttle (ThrottlerException). A growth signal, NOT an incident.
      // The exclusion is REQUIRED, not cosmetic: that 429 carries no
      // req.user, and probe traffic using mf_sk_-prefixed junk sets
      // recognizedCredential, which clears the service's scanner gate — so
      // unnarrowed, an attack pages as "a customer wants a higher limit."
      return exception instanceof TooManyAuthFailuresException ? null : 'rate_limit';
    default:
      return null;
  }
}

@Catch()
export class CustomerFailureAlertFilter extends SentryGlobalFilter {
  private readonly customerFailureLogger = new Logger(CustomerFailureAlertFilter.name);

  constructor(
    httpAdapterHost: HttpAdapterHost,
    private readonly customerFailureAlertService: CustomerFailureAlertService,
  ) {
    // Hand the HTTP adapter to BaseExceptionFilter (via SentryGlobalFilter) so
    // super.catch() can render the error response. Without it, super.catch would
    // have to lazily resolve the adapter and could no-op on some setups.
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // INVARIANT #2 (never-throw side-effect): record the customer failure FIRST,
    // fully isolated. It must never alter the response or throw.
    try {
      this.recordCustomerFailure(exception, host);
    } catch (err) {
      // Alerting can NEVER break exception handling — swallow and move on.
      this.customerFailureLogger.warn(
        `[CustomerFailureAlertFilter] failure-recording path errored (ignored): ` +
          `${(err as Error)?.message}`,
      );
    }

    // INVARIANT #1 (always-super.catch): DO NOT add an early return above this
    // line. super.catch() MUST run on EVERY path — it forwards non-HttpException
    // (5xx) errors to Sentry and renders the HTTP response. Skipping it means
    // Sentry captures nothing, with no error to say so.
    return super.catch(exception, host);
  }

  /**
   * Synchronously decide whether this exception is a customer-shaped 4xx we
   * alert on, build its attribution context, and fire-and-forget the alert.
   * Touches `req` only synchronously (no use after this returns).
   */
  private recordCustomerFailure(exception: unknown, host: ArgumentsHost): void {
    // Only the HTTP context carries a request we can attribute. RPC/WS/GraphQL
    // contexts have no req.user / req.headers to read — leave them to super.catch.
    if (host.getType<string>() !== 'http') {
      return;
    }

    // Non-HttpException → a 5xx server error, NOT a customer 4xx. Skip it here;
    // super.catch (invariant #1) still forwards it to Sentry.
    const status = exception instanceof HttpException ? exception.getStatus() : null;
    // Cheap status pre-filter BEFORE we build attribution: 404 (off), every 5xx,
    // and non-HttpExceptions (status null) bail here without touching the
    // request. 401 IS a candidate, but its hot path is kept
    // cheap by the extra short-circuit just below — not by excluding it here.
    if (status === null || !CANDIDATE_STATUSES.has(status)) {
      return;
    }

    const req = host.switchToHttp().getRequest();

    // HOT 401 PATH: the 401 choke point is sprayed by the ENTIRE
    // unauthenticated internet — background scanners with junk/no credentials are
    // the dominant volume. A 401 only ever PAGES when it is customer-shaped, and
    // the service applies that same gate downstream — but we must not pay for
    // full attribution (the sha256 key fingerprint + body sanitize inside
    // extractClaimedIdentity) on every scanner hit. So for a 401, run the CHEAP
    // customer-shape probe FIRST (UA + key-prefix + raw body-id, no hashing) and
    // bail BEFORE buildContext when it's clearly anonymous noise. The probe is a
    // no-false-negative superset of the service's gate, so a real customer 401 is
    // never dropped here. 400/403/429 are post-auth / low-volume and skip this.
    if (status === 401 && !isClaimedIdentityCustomerShaped(req)) {
      return;
    }

    const ctx = this.buildContext(req);

    // A revoked-key rejection carries validated facts (read off the
    // revoked DB row, not the request). Merge them as ONE object so the alert
    // can name the org + key and the owner notice can reach its owner — and
    // NEVER into ctx.organizationId, which would flip this unauthenticated
    // request onto the trusted org-bucketed path.
    if (exception instanceof RevokedApiKeyException) {
      ctx.revokedKey = exception.facts;
    }

    // Same rule as revokedKey above: never let these reach
    // ctx.organizationId. The !recognizedCredential gate is load-bearing — the
    // guard's api-key branch falls THROUGH on failure, so a broken mf_sk_ key
    // sent alongside a valid login token still lands here, and the extractor
    // fingerprints the KEY; without the gate this alert would bury a genuinely
    // broken customer key.
    if (exception instanceof OrganizationRequiredException && !ctx.recognizedCredential) {
      ctx.authMethodMismatch = {
        authMethod: req?.user?.authMethod,
        email: req?.user?.email,
      };
    }

    // Refined classification: the status is necessary but NOT sufficient. Each
    // class's copy must be true, so bad_data also needs the ingest surface and
    // forbidden also needs the exception's identity (see classifyCustomerFailure).
    const failureClass = classifyCustomerFailure(exception, status, ctx.source);
    if (!failureClass) {
      // A non-ingest 400 (dashboard/portal/raw-api), a non-publishable-key 403
      // (RBAC/owner-only denial), or any other status we don't alert on lands
      // here — recorded by NOTHING, so no mis-attributed page.
      return;
    }

    // PER-REQUEST FORENSIC ATTRIBUTION for 401: ONE structured WARN per
    // rejection — claimed (untrusted) identity, IP, path, source, and a REDACTED
    // key fingerprint — the line that makes a silently-failing customer VISIBLE.
    // It matters precisely BELOW the page threshold and in DEGRADED mode (no Redis
    // / no webhook): recordFailure early-returns then and logs nothing, so without
    // this line a customer's auth failure would leave ZERO trace exactly when the
    // alerting infra is down.
    //
    // Scoped to auth_401 ON PURPOSE:
    //   - 403 is already logged per-request by PublishableKeyWriteGuardInterceptor;
    //     re-logging it here would duplicate every line.
    //   - 400/422 (bad_data) and 429 (rate_limit) are counting-only by design and
    //     are not logged per request.
    // This sits AFTER the cheap customer-shape gate above, so anonymous scanner
    // floods are already gone and only customer-shaped 401s are logged.
    if (failureClass === 'auth_401') {
      // The revoked= segment is server-logs-only attribution; the
      // org NAME is preferred over the id so nothing internal leaks if a log
      // line is ever quoted to a customer.
      const revokedNote = ctx.revokedKey
        ? ` revoked=${ctx.revokedKey.organizationName ?? ctx.revokedKey.organizationId}/${ctx.revokedKey.keyLabel}`
        : '';
      this.customerFailureLogger.warn(
        `[CustomerFailureAlertFilter] credential rejected (401) — ` +
          `claimed/untrusted=${ctx.claimedEmail ?? 'none'} ` +
          `ip=${ctx.callerIp ?? 'unknown'} ` +
          `path=${ctx.path ?? 'unknown'} ` +
          `source=${ctx.source ?? 'unknown'} ` +
          `key=${ctx.keyFingerprint ?? 'none'}${revokedNote}`,
      );
    }

    // Fire-and-forget: the filter is synchronous and the HTTP response must NOT
    // wait on Redis/Slack. recordFailure is internally fail-open; the extra
    // .catch() is belt-and-suspenders so a rejected promise can't surface as an
    // unhandled rejection.
    const recording = this.customerFailureAlertService
      .recordFailure(failureClass, ctx)
      .catch(() => undefined);
    try {
      // Keep the serverless function alive past the response
      // until the dispatch settles — without this, the host could reclaim the
      // function and lose the Slack POST / owner email mid-flight for every
      // failure class. Mirrors cap/pool/customer-alert triggers.
      waitUntil(recording);
    } catch {
      // Outside a serverless request context (tests, local dev) the promise is
      // already running; nothing to track.
    }
  }

  /**
   * Build the attribution context. Trust is derived from req.user.organizationId:
   *   - org present  → POST-auth, trusted org attribution (bucket on org).
   *   - org absent   → fall back to the sanitized, UNTRUSTED extractClaimedIdentity
   *                    (bucket on IP, run through the scanner-noise gate).
   */
  private buildContext(req: any): CustomerFailureContext {
    // extractClaimedIdentity is pure + never-throws and resolves callerIp/path/source
    // exactly like the 401 path, so reuse it for the shared facts on every class.
    const identity = extractClaimedIdentity(req);
    const user = req?.user;

    if (user?.organizationId) {
      // POST-auth: req.user is a VALIDATED principal → trusted attribution. We do
      // NOT carry the untrusted claimedEmail/fingerprint here; the verified org +
      // email is the truth, and the service shows org-based who-lines when trusted.
      return {
        organizationId: user.organizationId,
        organizationName: user.organizationName,
        email: user.email || undefined,
        callerIp: identity.callerIp,
        path: identity.path,
        method: req?.method,
        source: identity.source,
      };
    }

    // No validated ORG (a 401 credential rejection, a @Public() route's 400, an
    // anonymous 429 — or a login-token 401, where req.user IS set but
    // carries no organizationId): fall back to the sanitized, UNTRUSTED
    // extractor. FOOT-GUN: the check above is on organizationId and not on
    // `user` because of that last case — narrowing it to `if (user)` drops
    // claimedEmail/keyFingerprint from every login-token alert.
    return { ...identity, method: req?.method };
  }
}
