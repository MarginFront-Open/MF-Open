/**
 * WHAT THIS FILE DOES:
 *   Unit tests for CustomerFailureAlertFilter. Pins the two load-bearing
 *   invariants and the per-class routing:
 *     - super.catch() runs on EVERY path, including a thrown
 *       NON-HttpException (5xx). This is the can't-break guard — an early return
 *       here means Sentry captures nothing, silently. We prove (a) the Sentry
 *       super.catch is invoked for every exception type, and (b) the REAL super
 *       chain renders a 500 for a non-HttpException (i.e. the 5xx is forwarded /
 *       handled, not dropped). super.catch is exactly where SentryGlobalFilter
 *       calls captureException, so proving it always runs is the check that
 *       matters — and we don't couple the test to Sentry's bundled-core internals.
 *     - PER-CLASS: 400/422 → "bad_data", 403 → "forbidden", 429 → "rate_limit".
 *     - 401 → "auth_401" : the filter OWNS 401 — but only pages
 *       a CUSTOMER-SHAPED 401, and short-circuits anonymous scanner noise cheaply
 *       (before full attribution). The guard records nothing, so the filter is
 *       the SOLE 401 recorder → no double-page.
 *     - 404 is OFF.
 *     - TRUSTED vs UNTRUSTED attribution (req.user present → org-keyed trusted;
 *       absent → sanitized claimed/untrusted from the body).
 *     - NEVER-throw: a throwing alert side-effect can't break the response.
 */
import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { waitUntil } from '@vercel/functions';
import { CustomerFailureAlertFilter } from './customer-failure-alert.filter';
import { PublishableKeyWriteForbiddenException } from '../exceptions/publishable-key-write-forbidden.exception';
import { RevokedApiKeyException } from '../exceptions/revoked-api-key.exception';
import { AuthUnavailableException } from '../exceptions/auth-unavailable.exception';
import { TooManyAuthFailuresException } from '../exceptions/too-many-auth-failures.exception';
import { OrganizationRequiredException } from '../exceptions/organization-required.exception';
import type { CustomerFailureAlertService } from '../../modules/auth/customer-failure-alert.service';
// Imported as a namespace so we can spy on extractClaimedIdentity and PROVE the
// hot 401 scanner path short-circuits BEFORE full attribution is built.
import * as claimedIdentityLib from '../../modules/auth/lib/extract-claimed-identity';

// The filter hands its fire-and-forget recordFailure promise to waitUntil so
// a serverless host can't reclaim the function mid-dispatch.
// Mocked so tests can pin the hand-off (and that a waitUntil throw is harmless).
jest.mock('@vercel/functions', () => ({ waitUntil: jest.fn() }));
const waitUntilMock = waitUntil as jest.Mock;

function makeFilter(): {
  filter: CustomerFailureAlertFilter;
  recordFailure: jest.Mock;
} {
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const service = { recordFailure } as unknown as CustomerFailureAlertService;
  // An empty object is a fine stand-in for the http adapter — every test either
  // spies away super.catch or stubs the BaseExceptionFilter response machinery,
  // so the adapter is never actually exercised.
  const httpAdapterHost = { httpAdapter: {} } as HttpAdapterHost;
  const filter = new CustomerFailureAlertFilter(httpAdapterHost, service);
  return { filter, recordFailure };
}

function makeHost(req: any, type: 'http' | 'rpc' | 'ws' = 'http'): ArgumentsHost {
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
    }),
    getArgByIndex: () => ({}),
  } as unknown as ArgumentsHost;
}

// req.user set → POST-auth, trusted. UA marks it as the SDK.
function trustedReq(overrides: Record<string, any> = {}): any {
  return {
    user: {
      organizationId: 'org_1',
      organizationName: 'Acme',
      email: 'a@acme.example',
    },
    url: '/v1/sdk/usage',
    method: 'POST',
    headers: { 'user-agent': '@marginfront/sdk/1.0' },
    ips: ['5.6.7.8'],
    ip: '5.6.7.8',
    body: {},
    ...overrides,
  };
}

// No req.user → untrusted. Body carries a claimed customer id (SDK-shaped).
function untrustedReq(overrides: Record<string, any> = {}): any {
  return {
    url: '/v1/public/thing',
    method: 'POST',
    headers: { 'user-agent': '@marginfront/sdk/1.0' },
    ips: ['9.9.9.9'],
    ip: '9.9.9.9',
    body: { customerExternalId: 'cust@x.example' },
    ...overrides,
  };
}

// Anonymous scanner noise: no req.user, a non-MarginFront UA, NO presented
// credential, and an empty body. None of the three customer-shape signals
// (claimed id / recognized key prefix / sdk-mcp-ccc UA) are present, so a 401
// from this caller must NOT page and must be short-circuited cheaply.
function scannerReq(overrides: Record<string, any> = {}): any {
  return {
    url: '/v1/sdk/usage',
    method: 'GET',
    headers: { 'user-agent': 'curl/8.4.0' },
    ips: ['6.6.6.6'],
    ip: '6.6.6.6',
    body: {},
    ...overrides,
  };
}

describe('CustomerFailureAlertFilter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('INVARIANT #1: super.catch() runs on every path (zero-captures guard)', () => {
    it('runs the REAL super.catch chain for a NON-HttpException (5xx): renders a 500, records nothing', () => {
      // A fake http adapter records how super.catch (BaseExceptionFilter) renders
      // the response. Construct the filter with it so this.applicationRef is set.
      const reply = jest.fn();
      const adapter = {
        reply,
        isHeadersSent: () => false,
        end: jest.fn(),
      };
      const recordFailure = jest.fn().mockResolvedValue(undefined);
      const filter = new CustomerFailureAlertFilter(
        { httpAdapter: adapter } as unknown as HttpAdapterHost,
        { recordFailure } as unknown as CustomerFailureAlertService,
      );

      const err = new Error('boom'); // NOT an HttpException → renders 500
      expect(() => filter.catch(err, makeHost(trustedReq()))).not.toThrow();

      // The 5xx is not a customer 4xx → we record nothing...
      expect(recordFailure).not.toHaveBeenCalled();
      // ...but the real super.catch chain ran end-to-end and rendered a 500.
      // (super.catch is exactly where SentryGlobalFilter forwards the 5xx to
      // Sentry, so this proves the 5xx reaches it.)
      expect(reply).toHaveBeenCalledTimes(1);
      const [, body, statusCode] = reply.mock.calls[0];
      expect(statusCode).toBe(500);
      expect(body).toMatchObject({ statusCode: 500 });
    });

    it('calls super.catch() for EVERY handled class (no early return anywhere)', () => {
      const superCatch = jest
        .spyOn(SentryGlobalFilter.prototype, 'catch')
        .mockImplementation(() => undefined);
      const { filter } = makeFilter();

      const exceptions = [
        new BadRequestException(),
        new UnprocessableEntityException(),
        new ForbiddenException(),
        new ThrottlerException(),
        new UnauthorizedException(),
        new NotFoundException(),
        new InternalServerErrorException(),
        new Error('boom'),
      ];
      for (const ex of exceptions) {
        filter.catch(ex, makeHost(trustedReq()));
      }

      // Once per exception, always.
      expect(superCatch).toHaveBeenCalledTimes(exceptions.length);
    });
  });

  describe('per-class routing', () => {
    let superCatch: jest.SpyInstance;
    beforeEach(() => {
      // Don't run the real Sentry/response machinery for routing assertions.
      superCatch = jest
        .spyOn(SentryGlobalFilter.prototype, 'catch')
        .mockImplementation(() => undefined);
    });

    it('routes 400 → bad_data (trusted, org-keyed)', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new BadRequestException(), makeHost(trustedReq()));
      expect(recordFailure).toHaveBeenCalledTimes(1);
      const [failureClass, ctx] = recordFailure.mock.calls[0];
      expect(failureClass).toBe('bad_data');
      expect(ctx.organizationId).toBe('org_1');
      expect(ctx.email).toBe('a@acme.example');
      expect(ctx.source).toBe('sdk');
      // Trusted path must NOT carry untrusted body content.
      expect(ctx.claimedEmail).toBeUndefined();
      expect(superCatch).toHaveBeenCalled();
    });

    it('routes 422 → bad_data', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new UnprocessableEntityException(), makeHost(trustedReq()));
      expect(recordFailure.mock.calls[0][0]).toBe('bad_data');
    });

    it('routes the publishable-key-write 403 → forbidden', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new PublishableKeyWriteForbiddenException(), makeHost(trustedReq()));
      expect(recordFailure.mock.calls[0][0]).toBe('forbidden');
    });

    it('does NOT route a bare ForbiddenException (RBAC/owner-only denial) → forbidden', () => {
      // Every 403 that ISN'T the publishable-key-write rejection — RBAC denials,
      // owner-only guards, etc. — must NOT page with publishable-key copy.
      // Status 403 alone is not sufficient.
      const { filter, recordFailure } = makeFilter();
      filter.catch(new ForbiddenException(), makeHost(trustedReq()));
      expect(recordFailure).not.toHaveBeenCalled();
      // The 403 response is still rendered (super.catch always runs).
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('does NOT route a 400 from a non-ingest surface (dashboard) → bad_data', () => {
      // A logged-in org tripping a buggy DASHBOARD form 400 must NOT page with
      // "a customer is sending malformed events" SDK-ingest copy. Only sdk/mcp/ccc
      // surfaces are real ingest.
      const { filter, recordFailure } = makeFilter();
      filter.catch(
        new BadRequestException(),
        makeHost(trustedReq({ headers: { 'user-agent': 'Mozilla/5.0 (Chrome)' } })),
      );
      expect(recordFailure).not.toHaveBeenCalled();
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('routes a ThrottlerException (429) → rate_limit', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new ThrottlerException(), makeHost(trustedReq()));
      expect(recordFailure.mock.calls[0][0]).toBe('rate_limit');
    });

    it('does NOT route the failed-auth 429 → rate_limit', () => {
      // The rate_limit copy tells the operator a paying customer is straining their
      // tenant limits and calls it a growth signal. This 429 is the opposite: an
      // unauthenticated caller that just burned through its budget of bad API
      // keys. Left unnarrowed it WOULD page, because probe traffic using
      // mf_sk_-prefixed junk sets recognizedCredential and clears the service's
      // scanner gate — so an attack would arrive framed as good news.
      const { filter, recordFailure } = makeFilter();

      filter.catch(new TooManyAuthFailuresException(), makeHost(untrustedReq()));

      expect(recordFailure).not.toHaveBeenCalled();
      // The 429 response is still rendered (invariant #1 holds on every path).
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('STILL routes a genuine tenant 429 from an untrusted caller → rate_limit', () => {
      // Twin of the test above: the narrowing keys on the
      // exception's identity, never on the caller's trust level, so it cannot
      // over-reach onto real throttling.
      const { filter, recordFailure } = makeFilter();

      filter.catch(new ThrottlerException(), makeHost(untrustedReq()));

      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(recordFailure.mock.calls[0][0]).toBe('rate_limit');
    });

    // ---- 401: the filter OWNS auth_401 ----
    // The guard records nothing. A 401 routes to 'auth_401' — but ONLY when
    // customer-shaped, and scanner noise is short-circuited cheaply before any
    // attribution work.

    it('routes a customer-shaped 401 → auth_401 exactly once (untrusted, IP-keyed)', () => {
      const { filter, recordFailure } = makeFilter();
      // untrustedReq: no req.user (a 401 never has one), SDK UA + claimed body id
      // → customer-shaped. The cheap probe passes and we build full attribution.
      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));

      expect(recordFailure).toHaveBeenCalledTimes(1);
      const [failureClass, ctx] = recordFailure.mock.calls[0];
      expect(failureClass).toBe('auth_401');
      // Untrusted attribution: claimed/untrusted id from the body, keyed on IP,
      // never an org (req.user is absent on a 401).
      expect(ctx.organizationId).toBeUndefined();
      expect(ctx.claimedEmail).toBe('cust@x.example');
      expect(ctx.callerIp).toBe('9.9.9.9');
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('does NOT page an anonymous scanner 401 AND short-circuits it cheaply (no full attribution built)', () => {
      // Spy on the heavy attribution builder. If the hot 401 path bails on the
      // cheap probe, extractClaimedIdentity (sha256 fingerprint + body sanitize)
      // is NEVER reached for scanner noise.
      const extractSpy = jest.spyOn(claimedIdentityLib, 'extractClaimedIdentity');
      const { filter, recordFailure } = makeFilter();

      filter.catch(new UnauthorizedException(), makeHost(scannerReq()));

      // No page: none of the three customer-shape signals are present.
      expect(recordFailure).not.toHaveBeenCalled();
      // Cheap: we bailed BEFORE buildContext, so the full extractor never ran.
      expect(extractSpy).not.toHaveBeenCalled();
      // The 401 response is STILL rendered (invariant #1 holds on every path).
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('records 401 in exactly ONE place — the filter, never twice (no double-page)', () => {
      // The guard has no recorder, so the filter is the sole recorder.
      // A single customer-shaped 401 must therefore drive exactly one record call;
      // the guard contributes zero (it does not inject the alert service).
      const { filter, recordFailure } = makeFilter();
      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));
      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(recordFailure.mock.calls[0][0]).toBe('auth_401');
    });

    it('does NOT handle 404 (off — scanner noise)', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new NotFoundException(), makeHost(trustedReq()));
      expect(recordFailure).not.toHaveBeenCalled();
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('does NOT record a 500 HttpException (only super.catch handles it)', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new InternalServerErrorException(), makeHost(trustedReq()));
      expect(recordFailure).not.toHaveBeenCalled();
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('ignores non-http contexts (rpc) but still calls super.catch', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new BadRequestException(), makeHost(trustedReq(), 'rpc'));
      expect(recordFailure).not.toHaveBeenCalled();
      expect(superCatch).toHaveBeenCalledTimes(1);
    });
  });

  // The forensic per-request WARN for a customer-shaped 401. This block pins
  // that the filter emits it and that it is correctly scoped. Without these,
  // dropping the WARN is invisible to the suite.
  describe('per-request forensic 401 attribution log', () => {
    beforeEach(() => {
      jest.spyOn(SentryGlobalFilter.prototype, 'catch').mockImplementation(() => undefined);
    });

    // Pull only the forensic 401 lines out of whatever the filter's logger logged.
    function forensicWarns(filter: CustomerFailureAlertFilter): string[] {
      const warnSpy = (filter as any).customerFailureLogger.warn as jest.Mock;
      return warnSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((msg: string) => msg.includes('credential rejected (401)'));
    }

    it('emits ONE structured WARN naming the customer for a customer-shaped 401', () => {
      const { filter } = makeFilter();
      jest.spyOn((filter as any).customerFailureLogger, 'warn').mockImplementation(() => undefined);

      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));

      const lines = forensicWarns(filter);
      expect(lines).toHaveLength(1);
      // The whole point of the line: it names WHICH (claimed) customer, their IP,
      // and the failing path — so a sub-threshold / degraded-mode 401 is visible.
      expect(lines[0]).toContain('claimed/untrusted=cust@x.example');
      expect(lines[0]).toContain('ip=9.9.9.9');
      expect(lines[0]).toContain('path=/v1/public/thing');
    });

    it('does NOT emit the forensic 401 WARN for an anonymous scanner 401 (bailed at the cheap gate)', () => {
      const { filter } = makeFilter();
      jest.spyOn((filter as any).customerFailureLogger, 'warn').mockImplementation(() => undefined);

      filter.catch(new UnauthorizedException(), makeHost(scannerReq()));

      // Scanner noise short-circuits BEFORE attribution, so no forensic line and
      // no log spam from the unauthenticated-internet flood.
      expect(forensicWarns(filter)).toHaveLength(0);
    });

    it('is scoped to auth_401 — a non-401 class (publishable-key 403) does NOT emit the 401 line', () => {
      const { filter } = makeFilter();
      jest.spyOn((filter as any).customerFailureLogger, 'warn').mockImplementation(() => undefined);

      // 403 is logged per-request by the interceptor, not here. If the filter's
      // forensic WARN weren't 401-scoped it would double-log this 403.
      filter.catch(new PublishableKeyWriteForbiddenException(), makeHost(trustedReq()));

      expect(forensicWarns(filter)).toHaveLength(0);
    });
  });

  describe('attribution: trusted vs untrusted', () => {
    beforeEach(() => {
      jest.spyOn(SentryGlobalFilter.prototype, 'catch').mockImplementation(() => undefined);
    });

    it('untrusted (no req.user) → claimed/untrusted id from the body, no org', () => {
      const { filter, recordFailure } = makeFilter();
      filter.catch(new BadRequestException(), makeHost(untrustedReq()));
      const ctx = recordFailure.mock.calls[0][1];
      expect(ctx.organizationId).toBeUndefined();
      expect(ctx.claimedEmail).toBe('cust@x.example'); // sanitized body content
      expect(ctx.callerIp).toBe('9.9.9.9');
    });
  });

  describe('revoked-key facts ride the exception into the alert context', () => {
    let superCatch: jest.SpyInstance;
    beforeEach(() => {
      superCatch = jest
        .spyOn(SentryGlobalFilter.prototype, 'catch')
        .mockImplementation(() => undefined);
      waitUntilMock.mockReset();
    });

    const facts = {
      organizationId: 'org_rk',
      organizationName: 'Acme Co',
      keyLabel: 'Prod server key',
      revokedAt: new Date('2026-08-20T00:00:00.000Z'),
    };

    // A revoked-key rejection as it actually arrives: the ONLY customer-shape
    // signal is the recognized key prefix (curl UA, empty body). The revoked-key
    // alert depends on the cheap pre-gate letting this shape through; tighten
    // isClaimedIdentityCustomerShaped and this goes red.
    function revokedKeyReq(): any {
      return scannerReq({
        headers: { 'user-agent': 'curl/8.4.0', 'x-api-key': 'mf_sk_revoked_raw' },
      });
    }

    it('merges exception.facts as ONE ctx.revokedKey object, survives the cheap pre-gate', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new RevokedApiKeyException(facts), makeHost(revokedKeyReq()));

      expect(recordFailure).toHaveBeenCalledTimes(1);
      const [failureClass, ctx] = recordFailure.mock.calls[0];
      expect(failureClass).toBe('auth_401');
      // ONE object, by reference — never flattened into scalars.
      expect(ctx.revokedKey).toBe(facts);
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('NEVER promotes the revoked facts into ctx.organizationId (stays IP-bucketed)', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new RevokedApiKeyException(facts), makeHost(revokedKeyReq()));

      const ctx = recordFailure.mock.calls[0][1];
      // organizationId present would flip the service onto the TRUSTED path:
      // org-keyed bucketing + no scanner gate — letting an unauthenticated
      // caller move counters into a real tenant's bucket.
      expect(ctx.organizationId).toBeUndefined();
      expect(ctx.callerIp).toBe('6.6.6.6');
    });

    it('a plain 401 carries NO revokedKey facts', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));

      expect(recordFailure.mock.calls[0][1].revokedKey).toBeUndefined();
    });

    it('the forensic WARN gains revoked=<org>/<label> only when the facts are present', () => {
      const { filter } = makeFilter();
      const warnSpy = jest
        .spyOn((filter as any).customerFailureLogger, 'warn')
        .mockImplementation(() => undefined);

      filter.catch(new RevokedApiKeyException(facts), makeHost(revokedKeyReq()));
      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));

      const lines = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((msg) => msg.includes('credential rejected (401)'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('revoked=Acme Co/Prod server key');
      expect(lines[1]).not.toContain('revoked=');
    });

    it('hands the recordFailure dispatch to waitUntil (no mid-flight loss on a serverless host)', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));

      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(waitUntilMock).toHaveBeenCalledTimes(1);
      expect(waitUntilMock.mock.calls[0][0]).toBeInstanceOf(Promise);
    });

    it('a throwing waitUntil is swallowed — super.catch still runs (invariants intact)', () => {
      waitUntilMock.mockImplementation(() => {
        throw new Error('not in a serverless request context');
      });
      const { filter, recordFailure } = makeFilter();

      expect(() =>
        filter.catch(new UnauthorizedException(), makeHost(untrustedReq())),
      ).not.toThrow();
      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(superCatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('an auth-unavailable 503 is invisible to the customer-failure counter', () => {
    let superCatch: jest.SpyInstance;
    beforeEach(() => {
      superCatch = jest
        .spyOn(SentryGlobalFilter.prototype, 'catch')
        .mockImplementation(() => undefined);
      waitUntilMock.mockReset();
    });

    // Deliberately the MOST customer-shaped request in this file: if the 503
    // stays invisible even for this shape, the exclusion is the status gate
    // (CANDIDATE_STATUSES), not an accident of request shape.
    it('records nothing, schedules nothing, and builds no attribution for a 503', () => {
      const extractSpy = jest.spyOn(claimedIdentityLib, 'extractClaimedIdentity');
      const { filter, recordFailure } = makeFilter();
      const warnSpy = jest
        .spyOn((filter as any).customerFailureLogger, 'warn')
        .mockImplementation(() => undefined);

      filter.catch(new AuthUnavailableException(), makeHost(untrustedReq()));

      // The counter is untouched and no dispatch was scheduled.
      expect(recordFailure).not.toHaveBeenCalled();
      expect(waitUntilMock).not.toHaveBeenCalled();
      // We bailed at the status pre-filter, BEFORE any attribution work.
      expect(extractSpy).not.toHaveBeenCalled();
      // No forensic 401 WARN either — this is not a credential rejection.
      const forensicLines = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((msg) => msg.includes('credential rejected (401)'));
      expect(forensicLines).toHaveLength(0);
      // Invariant #1 holds: the 503 response is still rendered via super.catch.
      expect(superCatch).toHaveBeenCalledTimes(1);
    });

    it('the SAME request with a plain 401 DOES record auth_401 (the exclusion is load-bearing)', () => {
      // Structural pin: same request shape, different status, opposite outcome.
      // If a future edit pulls 503 into CANDIDATE_STATUSES, the test above goes
      // red; if it accidentally drops 401, this one does.
      const { filter, recordFailure } = makeFilter();

      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));

      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(recordFailure.mock.calls[0][0]).toBe('auth_401');
    });
  });

  describe('a login-token 401 carries req.user but must stay UNTRUSTED', () => {
    beforeEach(() => {
      jest.spyOn(SentryGlobalFilter.prototype, 'catch').mockImplementation(() => undefined);
      waitUntilMock.mockReset();
    });

    // An authenticated principal on a 401. It carries no organizationId, and buildContext keys on organizationId
    // rather than on `user` — narrow that check to `if (user)` and the assertions
    // below go red.
    function loginTokenReq(overrides: Record<string, any> = {}): any {
      return untrustedReq({
        user: { id: 'user-1', email: 'a@acme.example', authMethod: 'jwt' },
        url: '/v1/usage/record',
        headers: {
          'user-agent': '@marginfront/sdk/1.0',
          authorization: 'Bearer header.payload.signature',
        },
        body: { records: [{ customerExternalId: 'cust-1' }] },
        ...overrides,
      });
    }

    it('records auth_401 on the IP bucket, with the Bearer token fingerprinted but unrecognized', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new OrganizationRequiredException(), makeHost(loginTokenReq()));

      expect(recordFailure).toHaveBeenCalledTimes(1);
      const [failureClass, ctx] = recordFailure.mock.calls[0];
      expect(failureClass).toBe('auth_401');
      // organizationId present would flip this onto the trusted org bucket.
      expect(ctx.organizationId).toBeUndefined();
      expect(ctx.callerIp).toBe('9.9.9.9');
      // A JWT matches no MarginFront key prefix, so it fingerprints under the
      // generic 'key' label and never claims to be a recognized credential.
      expect(ctx.keyFingerprint).toMatch(/^key_[0-9a-f]{12}$/);
      expect(ctx.recognizedCredential).toBe(false);
    });

    it('an anonymous scanner hitting the same exception is still short-circuited', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new OrganizationRequiredException(), makeHost(scannerReq()));

      // This 401 opens no door for scanner noise: the cheap gate runs
      // before any attribution, exactly as it does for a plain 401.
      expect(recordFailure).not.toHaveBeenCalled();
    });

    it('attaches the signed-in user as authMethodMismatch, never as an org', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new OrganizationRequiredException(), makeHost(loginTokenReq()));

      const ctx = recordFailure.mock.calls[0][1];
      expect(ctx.authMethodMismatch).toEqual({ authMethod: 'jwt', email: 'a@acme.example' });
      expect(ctx.organizationId).toBeUndefined();
    });

    it('a BROKEN api key sent alongside the login token keeps the broken-key copy', () => {
      const { filter, recordFailure } = makeFilter();

      // The guard's api-key branch falls through on failure, so this request
      // reaches the handler on its JWT while the extractor fingerprints the
      // failed mf_sk_ key. Without the gate, the alert would bury a real key.
      filter.catch(
        new OrganizationRequiredException(),
        makeHost(
          loginTokenReq({
            headers: {
              'user-agent': '@marginfront/sdk/1.0',
              authorization: 'Bearer header.payload.signature',
              'x-api-key': 'mf_sk_broken_but_recognizable',
            },
          }),
        ),
      );

      const ctx = recordFailure.mock.calls[0][1];
      expect(ctx.recognizedCredential).toBe(true);
      expect(ctx.authMethodMismatch).toBeUndefined();
    });

    it('a plain 401 carries no authMethodMismatch', () => {
      const { filter, recordFailure } = makeFilter();

      filter.catch(new UnauthorizedException(), makeHost(untrustedReq()));

      expect(recordFailure.mock.calls[0][1].authMethodMismatch).toBeUndefined();
    });
  });

  describe('INVARIANT #2 — never-throw side-effect', () => {
    it('still calls super.catch and does not throw when the alert side-effect throws synchronously', () => {
      const superCatch = jest
        .spyOn(SentryGlobalFilter.prototype, 'catch')
        .mockImplementation(() => undefined);
      const recordFailure = jest.fn(() => {
        throw new Error('redis exploded synchronously');
      });
      const service = { recordFailure } as unknown as CustomerFailureAlertService;
      const filter = new CustomerFailureAlertFilter(
        { httpAdapter: {} } as HttpAdapterHost,
        service,
      );

      expect(() => filter.catch(new BadRequestException(), makeHost(trustedReq()))).not.toThrow();
      expect(superCatch).toHaveBeenCalledTimes(1);
    });
  });
});
