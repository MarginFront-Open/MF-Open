import { ExecutionContext } from '@nestjs/common';
import { ThrottlerOptions } from '@nestjs/throttler';

/**
 * Rate-limit bucket definitions — the SINGLE source of truth shared by the live
 * ThrottlerModule wiring (app.module.ts) and the enforcement tests
 * (throttler-enforcement.spec.ts). It lives here, in one place, on purpose: a
 * test with its OWN private copy of the buckets can't see the hazard described below.
 *
 * ── THE HAZARD (read before touching the buckets) ─────────────────────────────
 * @nestjs/throttler evaluates EVERY named bucket on EVERY request, and a request
 * has to pass ALL of them — the guard does `continues.every(c => c)`. So the
 * EFFECTIVE limit on any route is the MINIMUM of all the buckets that aren't
 * skipped, NOT the bucket you think "owns" that route.
 *
 * With three flat buckets — default 1200/min, sdk 60000/min, public 60/min — the
 * `public` bucket (60) is the lowest number. Flat, with no skip, it would quietly
 * govern EVERY authenticated dashboard/business-API route at 60/min per org —
 * NOT the 1200 the `default` bucket is sized for. `public` is not meant for that:
 * it exists to protect ANONYMOUS surfaces (the public invoice link) keyed by IP,
 * where 60/min/IP is the right tight cap. Letting it leak onto authed routes
 * would be a cap 20x tighter than the `default` bucket.
 *
 * ── `public` is scoped to anonymous requests with a per-bucket skipIf ─────────
 * `isAuthenticatedRequest` skips the public bucket whenever the caller is
 * authenticated (req.user.organizationId is set — populated by CombinedAuthGuard,
 * which auth.module.ts registers to run BEFORE the throttler). Net effect:
 *   - authed request     → public skipped → governed by `default` (1200/min/org). ✓
 *   - anonymous request  → public applies (60/min/IP). ✓
 *   - SDK routes         → ALSO skip default+public via @SkipThrottle on the
 *                          controller, leaving the sdk 60000/min bucket as the
 *                          only governor (high-volume ingest). ✓
 *   - payment webhooks   → skip ALL THREE via @SkipThrottle, never throttled. ✓
 *
 * `default` and `sdk` deliberately carry NO skipIf — they must keep applying to
 * authed traffic. Only `public` is anonymous-scoped.
 */

/**
 * True when the request is authenticated (carries an org). Used as the `public`
 * bucket's skipIf so that bucket only governs anonymous traffic. Reads req.user
 * the same way the guard's getTracker does, so "authenticated" means the same
 * thing in both places.
 */
export function isAuthenticatedRequest(context: ExecutionContext): boolean {
  const req = context.switchToHttp().getRequest();
  return Boolean(req?.user?.organizationId);
}

/**
 * The three production rate-limit buckets. app.module.ts spreads these into the
 * ThrottlerModule factory (and bolts on the Redis storage); the tests import
 * this same array so a dropped skipIf or a changed limit fails a test instead of
 * silently shipping.
 */
export function buildThrottlerBuckets(): ThrottlerOptions[] {
  return [
    // Everything authenticated that isn't an SDK/webhook route. Sized for normal
    // dashboard + business-API traffic. This is the REAL floor on the human app,
    // because `public`'s skipIf keeps it off authed routes.
    { name: 'default', ttl: 60_000, limit: 1200 },
    // High-volume SDK event ingestion. Only governs routes that @SkipThrottle the
    // other two buckets (SdkController, SdkPublicAliasesController).
    { name: 'sdk', ttl: 60_000, limit: 60_000 },
    // Anonymous surfaces only, keyed by IP. The skipIf is what keeps this tight
    // 60/min cap from biting authenticated dashboard users (see file header).
    { name: 'public', ttl: 60_000, limit: 60, skipIf: isAuthenticatedRequest },
  ];
}
