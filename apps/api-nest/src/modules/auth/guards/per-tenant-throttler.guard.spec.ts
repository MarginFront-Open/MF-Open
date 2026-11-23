import { ExecutionContext, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import * as Sentry from '@sentry/nestjs';
import { PerTenantThrottlerGuard } from './per-tenant-throttler.guard';
import {
  resetUpstashQuotaReportGate,
  UPSTASH_QUOTA_SENTRY_FINGERPRINT,
} from '../../../lib/upstash-quota-sentry-gate';

// @sentry/nestjs re-exports captureException as a NON-configurable binding, so
// jest.spyOn can't wrap it. Replace the whole module with a jest.fn so we can
// assert whether the guard took the fail-open (capture) branch vs. the re-throw
// branch. The guard only calls Sentry.captureException, so a one-key mock is enough.
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

// Subclass exposes the protected getTracker method for testing. The base
// ThrottlerGuard constructor wants throttler options + storage + reflector,
// but our override doesn't touch any of them — null mocks are fine.
class TestablePerTenantThrottlerGuard extends PerTenantThrottlerGuard {
  public callGetTracker(req: any): Promise<string> {
    return (this as any).getTracker(req);
  }
}

// Minimal ExecutionContext — the guard's catch only reads
// context.switchToHttp().getRequest() for url/method when it logs a crash.
function makeHttpContext(
  req: Record<string, any> = { url: '/v1/sdk/usage/record', method: 'POST' },
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('PerTenantThrottlerGuard.getTracker', () => {
  const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);

  it('keys by organizationId when authenticated', async () => {
    const result = await guard.callGetTracker({
      user: { organizationId: 'org-1' },
    });
    expect(result).toBe('org:org-1');
  });

  it('keys by organizationId even when ips/ip are also present', async () => {
    // Authenticated users behind shared NATs would otherwise be wrongly
    // bucketed together by IP. organizationId always wins.
    const result = await guard.callGetTracker({
      user: { organizationId: 'org-7' },
      ips: ['1.2.3.4'],
      ip: '5.6.7.8',
    });
    expect(result).toBe('org:org-7');
  });

  it('falls back to req.ips[0] (the client IP from x-forwarded-for) when no user', async () => {
    const result = await guard.callGetTracker({
      ips: ['1.2.3.4', '10.0.0.1'],
    });
    expect(result).toBe('ip:1.2.3.4');
  });

  it('falls back to req.ip when req.ips is empty', async () => {
    const result = await guard.callGetTracker({ ips: [], ip: '9.9.9.9' });
    expect(result).toBe('ip:9.9.9.9');
  });

  it('falls back to req.ip when req.ips is undefined', async () => {
    const result = await guard.callGetTracker({ ip: '9.9.9.9' });
    expect(result).toBe('ip:9.9.9.9');
  });

  it('returns "ip:unknown" as last-resort when nothing identifies the request', async () => {
    // Better to throttle aggressively than silently disable limits.
    const result = await guard.callGetTracker({});
    expect(result).toBe('ip:unknown');
  });

  it('handles user object without organizationId by falling back to IP', async () => {
    // Anonymous-shape user (e.g. a malformed session): no orgId → use IP.
    const result = await guard.callGetTracker({
      user: { id: 'u-1' },
      ip: '1.1.1.1',
    });
    expect(result).toBe('ip:1.1.1.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canActivate: enforcement vs. fail-open
//
// The catch in canActivate must re-throw any HttpException (the intended 429)
// as its FIRST statement, while failing open on genuine non-HTTP crashes. A
// catch that always ends in `return true` swallows the over-limit
// ThrottlerException too, which turns rate limiting OFF: no request is ever
// rejected.
//
// We drive `super.canActivate` by spying ThrottlerGuard.prototype.canActivate —
// that is exactly the method `super.canActivate(context)` resolves to.
// ─────────────────────────────────────────────────────────────────────────────
describe('PerTenantThrottlerGuard.canActivate', () => {
  const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);

  // The module-mocked Sentry.captureException (see jest.mock at top of file).
  const captureException = Sentry.captureException as jest.Mock;
  let superCanActivate: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'open';
    superCanActivate = jest.spyOn(ThrottlerGuard.prototype, 'canActivate');
    // console.warn is a side-effect of the fail-open path; silence + assert on it.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    captureException.mockClear();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_STORE_FAILURE_MODE;
    jest.restoreAllMocks();
  });

  // 1 — ENFORCEMENT BLOCKS.
  it('PROPAGATES an over-limit ThrottlerException (429) instead of returning true', async () => {
    const thrown = new ThrottlerException();
    superCanActivate.mockRejectedValue(thrown);

    // The re-throw must surface the SAME 429 to the client + the global filter...
    await expect(guard.canActivate(makeHttpContext())).rejects.toBe(thrown);
    // ...and it is NOT treated as a crash: no Sentry fail-open capture, no warn.
    expect(captureException).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('re-throws ANY HttpException (not just ThrottlerException) as an intended rejection', async () => {
    // The gate is `instanceof HttpException`, matching the filter's gate and
    // future-proofing against other intended HTTP rejections from the chain.
    const thrown = new HttpException('teapot', 418);
    superCanActivate.mockRejectedValue(thrown);

    await expect(guard.canActivate(makeHttpContext())).rejects.toBe(thrown);
    expect(captureException).not.toHaveBeenCalled();
  });

  // 2 — FAIL-OPEN ON REAL CRASH (a cold-start crash in the throttler).
  it('FAILS OPEN (returns true) + captures to Sentry on the real cold-start TypeError', async () => {
    superCanActivate.mockRejectedValue(new TypeError('this.throttlers is not iterable'));

    await expect(guard.canActivate(makeHttpContext())).resolves.toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [capturedError, captureOptions] = captureException.mock.calls[0];
    expect(capturedError).toBeInstanceOf(TypeError);
    expect(captureOptions.tags).toMatchObject({
      component: 'PerTenantThrottlerGuard',
      failMode: 'fail-open',
    });
  });

  // 3 — FAIL-OPEN ON GENERIC ERROR (e.g. a wedged Redis client).
  it('FAILS OPEN (returns true) on a generic Error', async () => {
    superCanActivate.mockRejectedValue(new Error('redis connection wedged'));

    await expect(guard.canActivate(makeHttpContext())).resolves.toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('passes a genuinely-allowed request straight through (true stays true)', async () => {
    // Sanity: under-limit traffic still flows; the wrapper only intercepts throws.
    superCanActivate.mockResolvedValue(true);

    await expect(guard.canActivate(makeHttpContext())).resolves.toBe(true);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('PerTenantThrottlerGuard.canActivate when Upstash is over its request cap', () => {
  const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);
  const captureException = Sentry.captureException as jest.Mock;
  const quotaError = () =>
    new Error(
      'ERR max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details',
    );
  let superCanActivate: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'open';
    resetUpstashQuotaReportGate();
    superCanActivate = jest.spyOn(ThrottlerGuard.prototype, 'canActivate');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    captureException.mockClear();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_STORE_FAILURE_MODE;
    jest.restoreAllMocks();
  });

  it('reports 1,000 consecutive quota failures to Sentry exactly once and lets all 1,000 through', async () => {
    superCanActivate.mockImplementation(() => Promise.reject(quotaError()));

    const results: boolean[] = [];
    for (let i = 0; i < 1000; i++) {
      results.push(await guard.canActivate(makeHttpContext()));
    }

    expect(results).toHaveLength(1000);
    expect(results.every((allowed) => allowed === true)).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1000);
    const [, captureOptions] = captureException.mock.calls[0];
    expect(captureOptions.fingerprint).toEqual(UPSTASH_QUOTA_SENTRY_FINGERPRINT);
    expect(captureOptions.tags).toEqual({
      component: 'PerTenantThrottlerGuard',
      failMode: 'fail-open',
    });
  });

  it('still re-throws a 429 unchanged and never captures it while the quota gate is closed', async () => {
    superCanActivate.mockRejectedValueOnce(quotaError());
    await guard.canActivate(makeHttpContext());
    captureException.mockClear();

    const thrown = new ThrottlerException();
    superCanActivate.mockRejectedValueOnce(thrown);

    await expect(guard.canActivate(makeHttpContext())).rejects.toBe(thrown);
    expect(thrown.getStatus()).toBe(429);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('captures every non-quota crash with the standard capture options, even while the quota gate is closed', async () => {
    superCanActivate.mockRejectedValueOnce(quotaError());
    await guard.canActivate(makeHttpContext());
    captureException.mockClear();

    superCanActivate.mockImplementation(() =>
      Promise.reject(new TypeError('this.throttlers is not iterable')),
    );
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(makeHttpContext())).resolves.toBe(true);
    }
    superCanActivate.mockImplementation(() => Promise.reject(new Error('read ECONNRESET')));
    for (let i = 0; i < 5; i++) {
      await expect(guard.canActivate(makeHttpContext())).resolves.toBe(true);
    }

    expect(captureException).toHaveBeenCalledTimes(10);
    for (const [, captureOptions] of captureException.mock.calls) {
      expect(captureOptions).toEqual({
        tags: { component: 'PerTenantThrottlerGuard', failMode: 'fail-open' },
        extra: { path: '/v1/sdk/usage/record', method: 'POST' },
      });
    }
  });

  it('reports the quota error again once the 60-minute window has passed', async () => {
    const start = Date.UTC(2026, 8, 30, 12, 0, 0);
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    superCanActivate.mockImplementation(() => Promise.reject(quotaError()));

    await guard.canActivate(makeHttpContext());
    now.mockReturnValue(start + 59 * 60 * 1000);
    await guard.canActivate(makeHttpContext());
    expect(captureException).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 60 * 60 * 1000);
    await expect(guard.canActivate(makeHttpContext())).resolves.toBe(true);
    await guard.canActivate(makeHttpContext());
    expect(captureException).toHaveBeenCalledTimes(2);
  });
});

describe('PerTenantThrottlerGuard.canActivate when the limiter store is down (RATE_LIMIT_STORE_FAILURE_MODE)', () => {
  const captureException = Sentry.captureException as jest.Mock;
  let superCanActivate: jest.SpyInstance;

  const anonymousRequest = () => makeHttpContext({ url: '/v1/public/pricing/acme', method: 'GET' });
  const authenticatedRequest = () =>
    makeHttpContext({
      url: '/v1/sdk/usage/record',
      method: 'POST',
      user: { organizationId: 'org-1' },
    });

  function skippingReflector(skipsEveryBucket: boolean) {
    return { getAllAndOverride: jest.fn(() => skipsEveryBucket) };
  }

  function contextWithHandler(req: Record<string, any>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    superCanActivate = jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    captureException.mockClear();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_STORE_FAILURE_MODE;
    jest.restoreAllMocks();
  });

  it('by default refuses an anonymous request with a 503 that explains why', async () => {
    const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);

    const rejection = guard.canActivate(anonymousRequest());

    await expect(rejection).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(rejection).rejects.toThrow(/rate limiter is not working/);
    expect(captureException.mock.calls[0][1].tags.failMode).toBe('fail-closed');
  });

  it('by default still lets an authenticated request through, so ingest keeps working', async () => {
    const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);

    await expect(guard.canActivate(authenticatedRequest())).resolves.toBe(true);
    expect(captureException.mock.calls[0][1].tags.failMode).toBe('fail-open');
  });

  it('refuses authenticated requests too when the mode is closed', async () => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'closed';
    const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);

    await expect(guard.canActivate(authenticatedRequest())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('lets an anonymous request through when the mode is open', async () => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'open';
    const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);

    await expect(guard.canActivate(anonymousRequest())).resolves.toBe(true);
  });

  it('treats an unknown mode as the default', async () => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'sometimes';
    const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);

    await expect(guard.canActivate(anonymousRequest())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('never refuses a route that skips every bucket (cron jobs, payment webhooks), even when closed', async () => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'closed';
    const guard = new TestablePerTenantThrottlerGuard(
      null as any,
      null as any,
      skippingReflector(true) as any,
    );

    await expect(
      guard.canActivate(contextWithHandler({ url: '/v1/subscriptions/cron/dispatch' })),
    ).resolves.toBe(true);
  });

  it('still refuses a route that skips only some buckets', async () => {
    const guard = new TestablePerTenantThrottlerGuard(
      null as any,
      null as any,
      skippingReflector(false) as any,
    );

    await expect(
      guard.canActivate(contextWithHandler({ url: '/v1/public/pricing/acme' })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('still re-throws an over-limit 429 unchanged in every mode', async () => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'closed';
    const guard = new TestablePerTenantThrottlerGuard(null as any, null as any, null as any);
    const thrown = new ThrottlerException();
    superCanActivate.mockRejectedValueOnce(thrown);

    await expect(guard.canActivate(anonymousRequest())).rejects.toBe(thrown);
  });
});
