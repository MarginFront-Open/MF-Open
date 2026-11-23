/**
 * WHAT THIS FILE DOES:
 *   Pulls the "who is this caller CLAIMING to be" facts off a request that is
 *   about to be rejected with a 401. It is the attribution layer for silent
 *   SDK auth failures — when a customer's key stops working, we want a log line
 *   (and an alert) that says WHICH customer is failing, instead of an
 *   anonymous "401" that nobody can trace back to an account.
 *
 * WHY IT'S A SEPARATE PURE HELPER:
 *   The 401 reject path that CustomerFailureAlertFilter handles is hot and
 *   security-sensitive. Keeping the extraction here, pure and dependency-free,
 *   keeps the filter small and lets the defensive parsing (Buffer bodies,
 *   control-char stripping, key redaction) be tested without standing up the
 *   whole Nest auth stack.
 *
 * SECURITY POSTURE (mandatory — this is REJECTED, attacker-controlled input):
 *   - `claimedEmail` comes from the REQUEST BODY of a request we are about to
 *     deny. It is untrusted and attacker-controlled. We sanitize it before it
 *     ever touches a log line or a Redis key: strip CR/LF + control chars (log
 *     injection / forged log lines) and cap the length (Redis key cardinality,
 *     log bloat). Callers MUST treat it as "claimed / untrusted", never as a
 *     verified identity.
 *   - The raw API key / bearer token is NEVER returned or logged. We return a
 *     one-way fingerprint (a sha256 prefix, plus a non-secret key-type label)
 *     so repeated failures from the same bad credential can be correlated
 *     without the secret ever leaving memory.
 *
 * NEVER THROWS: the body may be a Buffer (Stripe raw-body route), absent, or a
 *   non-object. Every accessor is defensive and the whole thing degrades to
 *   undefined fields rather than throwing — an attribution helper must never be
 *   able to turn a clean 401 into a 500.
 */
import { createHash } from 'crypto';
import { detectSource } from '../../../lib/request-source';
import type { Source } from '../../../lib/request-source';
// The SINGLE source of truth for "is this source one of our customer-integration
// surfaces (sdk/mcp/ccc)" lives on the alert service. We import that one pure
// predicate (NOT the service instance — no Nest/Redis is constructed) so the
// cheap 401 customer-shape probe below can never drift out of sync with the
// service's scanner-noise gate.
import { isCustomerIntegrationSource } from '../customer-failure-alert.service';

export interface ClaimedIdentity {
  /**
   * Email/customer-id the caller CLAIMED in the request body. Untrusted,
   * sanitized, possibly undefined. Label it "claimed/untrusted" wherever shown.
   */
  claimedEmail?: string;
  /** Best-effort client IP, mirroring PerTenantThrottlerGuard's resolution. */
  callerIp: string;
  /** Request path (for "which endpoint is failing"), undefined if unavailable. */
  path?: string;
  /** Caller surface inferred from the User-Agent (sdk / ccc / api / ...). */
  source: Source;
  /** One-way fingerprint of the presented credential. NEVER the raw key. */
  keyFingerprint?: string;
  /**
   * True only when the caller presented a credential whose prefix is a
   * recognized MarginFront key type (mf_sk_/mf_pk_/prtl_). A bare/garbage
   * Authorization header (e.g. a scanner spraying random tokens) is NOT
   * recognized. The alert gate uses this to tell "a real customer's key broke"
   * apart from anonymous internet noise.
   */
  recognizedCredential: boolean;
}

// API-KEY prefixes only — the kinds that can match an api_keys row. prtl_ is a
// portal SESSION token, deliberately excluded: the revoked-key probe below must
// never pay a guaranteed-miss DB query for a misrouted portal token.
const API_KEY_PREFIXES = ['mf_sk_', 'mf_pk_'];

// Key-type prefixes that are safe to surface in a fingerprint label. These
// prefixes are public markers of key KIND (secret vs publishable vs portal),
// not secret material, so showing them helps triage ("oh, a publishable key
// is being used to write") without leaking the key itself.
const KNOWN_KEY_PREFIXES = [...API_KEY_PREFIXES, 'prtl_'];

/**
 * True when the presented credential starts with one of OUR api-key prefixes
 * (mf_sk_/mf_pk_, never prtl_). The ONE source of truth for "could this
 * string be a MarginFront API key": the honest-401 probe in AuthService gates
 * its extra revoked-row lookup on this, so scanner floods spraying junk tokens
 * pay zero additional queries.
 */
export function hasRecognizedApiKeyPrefix(raw: string | undefined): boolean {
  return recognizedApiKeyPrefix(raw) !== undefined;
}

/**
 * The matched api-key prefix itself (mf_sk_/mf_pk_), or undefined. The
 * guard's Sentry capture attaches it so triage sees the key KIND during an
 * auth outage — never the key.
 */
export function recognizedApiKeyPrefix(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return API_KEY_PREFIXES.find((prefix) => raw.startsWith(prefix));
}

// Cap on any caller-supplied string we keep. ~120 chars is plenty for a real
// email or external customer id and bounds both log size and Redis key length.
const MAX_CLAIMED_LEN = 120;

// Matches ASCII control chars: the C0 range (\u0000-\u001F, which
// includes CR, LF, NUL and TAB) plus DEL (\u007F). Stripping these stops a
// crafted body from forging extra log lines or smuggling terminal escapes
// into our logs/alerts.
// eslint-disable-next-line no-control-regex -- strips control characters on purpose
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Strip control characters (incl. CR/LF) and length-cap an untrusted string.
 * Returns undefined for anything that isn't a non-empty string after cleaning.
 */
function sanitizeUntrusted(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(CONTROL_CHARS, '').trim();
  if (!stripped) return undefined;
  return stripped.slice(0, MAX_CLAIMED_LEN);
}

/**
 * Read the claimed customer identity out of the body without trusting its
 * shape. Order matches the SDK ingest contract:
 *   1. batch ingest:  body.records[0].customerExternalId
 *   2. single ingest: body.customerExternalId
 *   3. generic:       body.email
 */
function readClaimedEmail(body: unknown): unknown {
  // Stripe's raw-body route hands us a Buffer; ingest with no JSON body hands
  // us undefined. Either way there's nothing to read — bail, don't throw.
  if (!body || Buffer.isBuffer(body) || typeof body !== 'object') {
    return undefined;
  }
  try {
    const b = body as Record<string, any>;
    const firstRecord = Array.isArray(b.records) && b.records.length > 0 ? b.records[0] : undefined;
    const fromRecords =
      firstRecord && typeof firstRecord === 'object' ? firstRecord.customerExternalId : undefined;
    return fromRecords ?? b.customerExternalId ?? b.email;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the client IP exactly like PerTenantThrottlerGuard.getTracker:
 * leftmost x-forwarded-for entry (req.ips[0]) → req.ip → "unknown". Keeping
 * the resolution identical means the alert counter buckets requests the same
 * way the rate limiter already does.
 *
 * Exported for AuthFailureThrottleService so its per-IP block
 * buckets on the SAME value the alert counter counts on, by construction rather
 * than by a third copy of this expression.
 */
export function resolveCallerIp(req: any): string {
  return (
    (Array.isArray(req?.ips) && req.ips.length > 0 ? req.ips[0] : undefined) ?? req?.ip ?? 'unknown'
  );
}

/**
 * Pull the raw credential the caller presented: x-api-key first (the SDK ingest
 * path), then a Bearer token. Returns undefined when neither is present.
 *
 * Extracted so the "where do we read the credential from" rule lives in exactly
 * ONE place. Two callers need it for different reasons: the fingerprint path
 * HASHES it, and the cheap customer-shape probe (the hot 401 path) only needs
 * its PREFIX. Neither should re-implement the lookup, or they could disagree on
 * what counts as "a presented credential."
 */
function readPresentedCredential(req: any): string | undefined {
  const apiKey = req?.headers?.['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey;

  const authHeader = req?.headers?.authorization;
  if (typeof authHeader === 'string') {
    const [type, token] = authHeader.split(' ');
    if (type === 'Bearer' && token) return token;
  }
  return undefined;
}

/**
 * Turn whatever credential the caller presented into a non-reversible
 * fingerprint. The raw value is hashed; only a sha256 prefix plus a recognized
 * key-type label is returned.
 *
 * Also reports `recognized`: whether the presented credential started with a
 * known MarginFront key prefix. That fact (NOT the fingerprint string) is what
 * the alert gate keys on, so the parsing logic stays here and the gate stays a
 * boolean check.
 */
function fingerprintCredential(req: any): {
  keyFingerprint?: string;
  recognized: boolean;
} {
  try {
    const raw = readPresentedCredential(req);
    if (!raw) return { keyFingerprint: undefined, recognized: false };

    const matchedPrefix = KNOWN_KEY_PREFIXES.find((p) => raw.startsWith(p));
    // Drop the trailing underscore so the label joins cleanly with the digest.
    const label = matchedPrefix ? matchedPrefix.replace(/_$/, '') : 'key';
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    return { keyFingerprint: `${label}_${digest}`, recognized: !!matchedPrefix };
  } catch {
    return { keyFingerprint: undefined, recognized: false };
  }
}

/**
 * Build the attribution facts for a request that is about to be rejected.
 * Pure, defensive, never throws.
 */
export function extractClaimedIdentity(req: any): ClaimedIdentity {
  const callerIp = resolveCallerIp(req);
  const path: string | undefined = req?.url ?? req?.originalUrl ?? undefined;
  const source = detectSource(req?.headers?.['user-agent']);
  const claimedEmail = sanitizeUntrusted(readClaimedEmail(req?.body));
  const { keyFingerprint, recognized } = fingerprintCredential(req);

  return {
    claimedEmail,
    callerIp,
    path,
    source,
    keyFingerprint,
    recognizedCredential: recognized,
  };
}

/**
 * CHEAP customer-shape probe for the HOT 401 path.
 *
 * The 401 credential-rejection choke point is sprayed by the ENTIRE
 * unauthenticated internet: background scanners with junk or absent credentials
 * are the dominant volume. A 401 only ever PAGES when it looks like a real
 * customer's integration breaking, and the alert service applies that same gate
 * downstream — but the global filter must not pay for FULL attribution (the
 * sha256 key fingerprint + body sanitize that extractClaimedIdentity does) on
 * every scanner hit. This predicate lets the filter bail BEFORE that work.
 *
 * It answers "could this rejected request be a real customer?" using only the
 * THREE signals the alert gate keys on, each computed the CHEAP way:
 *   1. our own SDK, MCP or code-cost-clarity User-Agent (via detectSource), OR
 *   2. a presented credential whose PREFIX is a recognized MarginFront key type; we only
 *      need the prefix, so we SKIP the sha256 the fingerprint would compute, OR
 *   3. a claimed customer id/email in the body — RAW presence, pre-sanitize.
 *
 * Deliberately a no-false-NEGATIVE superset of the service's isCustomerShaped
 * gate: reading raw (un-sanitized) body presence can only ever be MORE permissive
 * than the sanitized value the service later keys on, so a real customer 401 is
 * never short-circuited away here. A rare false POSITIVE just means we build full
 * attribution and let the service make the authoritative call — no signal lost.
 *
 * Pure + never-throws, like the rest of this module. On any unexpected error it
 * fails OPEN (returns true), so the worst case is "do the full work," never
 * "silently drop a real customer's signal."
 */
export function isClaimedIdentityCustomerShaped(req: any): boolean {
  try {
    // 1. Cheapest: our own client's User-Agent. detectSource is a single regex.
    //    Called UA-only (no urlPath) to match extractClaimedIdentity exactly, so
    //    the source signal here can't differ from the one the service gates on.
    if (isCustomerIntegrationSource(detectSource(req?.headers?.['user-agent']))) {
      return true;
    }
    // 2. A recognized MarginFront key PREFIX (mf_sk_/mf_pk_/prtl_). Prefix
    //    match only — no hashing on the hot path.
    const credential = readPresentedCredential(req);
    if (credential && KNOWN_KEY_PREFIXES.some((p) => credential.startsWith(p))) {
      return true;
    }
    // 3. A claimed customer identity in the body. Raw presence is enough here;
    //    the full sanitize runs later only if we proceed past this gate.
    if (readClaimedEmail(req?.body) != null) {
      return true;
    }
    return false;
  } catch {
    // An attribution probe must never throw on the hot path. Fail OPEN: treat it
    // as possibly-a-customer and let the full path + service gate decide.
    return true;
  }
}
