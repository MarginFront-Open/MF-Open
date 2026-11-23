/**
 * THROTTLER ENFORCEMENT — integration + wiring guards
 *
 * This suite proves the parts of throttler enforcement that a pure unit test on the
 * guard can't: that a REAL over-limit request flows all the way through the live
 * guard chain into a 429 AND into the CustomerFailureAlertFilter, and that the
 * SDK / webhook controllers carry the exact @SkipThrottle wiring enforcement depends
 * on. The guard-level re-throw / fail-open branches are unit-tested separately in
 * per-tenant-throttler.guard.spec.ts.
 *
 * HOW THE BEHAVIORAL TESTS WORK:
 *   We boot a minimal real Nest HTTP app with the SAME pieces production uses —
 *   ThrottlerModule + PerTenantThrottlerGuard as APP_GUARD + CustomerFailureAlertFilter
 *   as APP_FILTER — then make real HTTP requests against it and watch the statuses.
 *   Bucket LIMITS are scaled DOWN (default/public = 3, sdk override = 50) so a
 *   handful of requests can exercise the same logic the 1200 / 60000 / 60 prod
 *   numbers do — bursting 60 000 requests in a test is not feasible. The STRUCTURE
 *   (three buckets, minimum-wins, sdk-only-after-skip) is identical to prod.
 *
 *   Critically: every one of these would FAIL if the guard swallowed the
 *   ThrottlerException and returned true: the "429" requests would come back
 *   200 and the filter would never see a rate_limit.
 *
 * WHY A SCALED "SdkLikeController" INSTEAD OF THE REAL SdkController:
 *   The real SdkController hard-codes @Throttle({ sdk: 60000 }) via its decorator,
 *   so its runaway threshold can't be tripped in a test. SdkLikeController mirrors
 *   the real decorator STACK (@SkipThrottle({ default, public }) + @Throttle({ sdk }))
 *   with a scaled sdk number so the runaway path is reachable. The wiring guard pins the
 *   REAL controllers' metadata so the representative controller can't drift from them.
 */
import 'reflect-metadata';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  HttpStatus,
  INestApplication,
  Injectable,
  Post,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SkipThrottle, Throttle, ThrottlerModule } from '@nestjs/throttler';
import { PerTenantThrottlerGuard } from '../auth/guards/per-tenant-throttler.guard';
import { CustomerFailureAlertFilter } from '../../common/filters/customer-failure-alert.filter';
import { CustomerFailureAlertService } from '../auth/customer-failure-alert.service';
// The REAL public-bucket skipIf predicate + the REAL production bucket config.
// Imported (not re-declared) so the bucket tests below check exactly what ships.
import {
  buildThrottlerBuckets,
  isAuthenticatedRequest,
} from '../../common/throttler/throttler.config';
// The REAL controllers, imported ONLY to read their decorator metadata.
// They are never instantiated here, so their service dependencies don't matter.
import { SdkController } from './sdk.controller';
import { SdkPublicAliasesController } from './sdk-public-aliases.controller';
import { WebhooksController } from '../webhooks/webhooks.controller';
import { InvoicesController } from '../invoices/invoices.controller';

// Throttler metadata key prefixes. Source of truth: @nestjs/throttler's
// throttler.constants (THROTTLER_SKIP = 'THROTTLER:SKIP', THROTTLER_LIMIT =
// 'THROTTLER:LIMIT'). They are NOT re-exported from the package's main entry, so
// we mirror the literals here; the skip-throttle tests break loudly if the convention ever moves.
const THROTTLER_SKIP = 'THROTTLER:SKIP';
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

// ── Test controllers (scaled, see header) ────────────────────────────────────

// A plain throttled route with NO skip. Used to trip a real 429 through the live
// guard + filter. The default bucket is overridden to 2 so the 3rd request
// trips fast.
@Controller('probe')
class EnforcementProbeController {
  @Post('limited')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  hit() {
    return { ok: true };
  }
}

// Mirrors the REAL SDK controller's decorator stack: skip default + public, raise
// sdk. The sdk limit (50) is scaled so the runaway path is reachable. The
// module sets the unscoped sdk bucket to 5, so if the @Throttle override below were
// dropped, the under-burst would 429 at request 6 — making this controller
// double as a guard on the decorator override.
@Controller('sdklike')
@SkipThrottle({ default: true, public: true })
@Throttle({ sdk: { limit: 50, ttl: 60_000 } })
class SdkLikeController {
  @Post('record')
  @HttpCode(HttpStatus.OK)
  record() {
    return { ok: true };
  }
}

// Two PLAIN controllers with NO throttle decorators — the shape of ~90% of the
// app (agents, customers, analytics, dashboard, etc.). The public-bucket tests boot these
// to prove the public bucket does not apply to authed routes. `/authed/*` is
// made to look authenticated by FakeAuthGuard below; `/anon/*` stays anonymous.
@Controller('authed')
class AuthedPlainController {
  @Post('thing')
  @HttpCode(HttpStatus.OK)
  hit() {
    return { ok: true };
  }
}

@Controller('anon')
class AnonPlainController {
  @Post('thing')
  @HttpCode(HttpStatus.OK)
  hit() {
    return { ok: true };
  }
}

// Stand-in for CombinedAuthGuard: stamps req.user.organizationId on /authed/*
// requests and leaves /anon/* untouched. Registered as APP_GUARD BEFORE the
// throttler (same order auth.module.ts uses in prod) so the public bucket's
// skipIf sees req.user exactly as it would live. This is the ONLY piece of auth
// the skipIf depends on, so faking just this is faithful.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (typeof req?.url === 'string' && req.url.startsWith('/authed')) {
      req.user = { organizationId: 'test-org-1' };
    }
    return true;
  }
}

// ── App boot + HTTP helpers ──────────────────────────────────────────────────

interface BootedApp {
  app: INestApplication;
  url: string;
  recordFailure: jest.Mock;
}

async function boot(): Promise<BootedApp> {
  const recordFailure = jest.fn().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({
        // Same three-bucket STRUCTURE as app.module.ts, numbers scaled down so a
        // small burst exercises the same minimum-wins logic as prod's 1200/60000/60.
        throttlers: [
          { name: 'default', ttl: 60_000, limit: 3 },
          { name: 'sdk', ttl: 60_000, limit: 5 },
          { name: 'public', ttl: 60_000, limit: 3 },
        ],
      }),
    ],
    controllers: [EnforcementProbeController, SdkLikeController],
    providers: [
      // The filter injects this; a jest.fn lets us assert the 429 was classified.
      { provide: CustomerFailureAlertService, useValue: { recordFailure } },
      // Exactly how production wires them (auth.module.ts / app.module.ts).
      { provide: APP_GUARD, useClass: PerTenantThrottlerGuard },
      { provide: APP_FILTER, useClass: CustomerFailureAlertFilter },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.listen(0); // ephemeral port
  const url = await app.getUrl();
  return { app, url, recordFailure };
}

// Boot for the public-bucket-scoping proof. Same guard chain as prod —
// FakeAuthGuard THEN PerTenantThrottlerGuard — and the public bucket reuses the
// REAL `isAuthenticatedRequest` skipIf. Bucket numbers are scaled so a small
// burst exercises it: public is the LOWEST (3), default is high (100). So if
// public applied to an authed route, an authed burst of >3 would 429.
async function bootSkipIf(): Promise<BootedApp> {
  const recordFailure = jest.fn().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({
        throttlers: [
          { name: 'default', ttl: 60_000, limit: 100 },
          { name: 'sdk', ttl: 60_000, limit: 100 },
          // The load-bearing line: public is tightest (3) AND scoped to
          // anonymous traffic by the SAME predicate prod uses.
          { name: 'public', ttl: 60_000, limit: 3, skipIf: isAuthenticatedRequest },
        ],
      }),
    ],
    controllers: [AuthedPlainController, AnonPlainController],
    providers: [
      { provide: CustomerFailureAlertService, useValue: { recordFailure } },
      // Order matters: auth-like guard first (stamps req.user), throttler second.
      { provide: APP_GUARD, useClass: FakeAuthGuard },
      { provide: APP_GUARD, useClass: PerTenantThrottlerGuard },
      { provide: APP_FILTER, useClass: CustomerFailureAlertFilter },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.listen(0);
  const url = await app.getUrl();
  return { app, url, recordFailure };
}

// One POST; drains the body so the socket is freed before the next request.
async function post(url: string): Promise<number> {
  const res = await fetch(url, { method: 'POST' });
  await res.text();
  return res.status;
}

// n SEQUENTIAL POSTs (sequential = deterministic bucket counting, no request race).
async function burst(url: string, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    statuses.push(await post(url));
  }
  return statuses;
}

describe('Throttler enforcement (integration)', () => {
  let active: INestApplication | undefined;

  afterEach(async () => {
    if (active) {
      await active.close();
      active = undefined;
    }
  });

  // A real over-limit 429 reaches the client AND the global filter.
  it('propagates a real 429 to the client and to CustomerFailureAlertFilter as rate_limit', async () => {
    const { app, url, recordFailure } = await boot();
    active = app;

    // default bucket = 2 → first two pass, the 3rd is over limit.
    const statuses = await burst(`${url}/probe/limited`, 4);

    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200);
    // The over-limit request is re-thrown (not swallowed) → real HTTP 429.
    expect(statuses[2]).toBe(429);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);

    // ...and the same 429 reached the global filter, which classified it as a
    // growth-framed rate_limit alert (429 -> rate_limit).
    expect(recordFailure).toHaveBeenCalled();
    expect(recordFailure.mock.calls.some((c) => c[0] === 'rate_limit')).toBe(true);
  });

  // A low-rate meter ingest pattern is never throttled.
  it('never throttles a low-rate meter ingest pattern', async () => {
    const { app, url, recordFailure } = await boot();
    active = app;

    // A usage meter pushes ~1 small batch every few minutes — orders of magnitude under
    // any bucket. We model the SHAPE (a handful of ingest calls); all must pass.
    const statuses = await burst(`${url}/sdklike/record`, 5);

    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  // Under side: a burst over default/public but under sdk
  // must NOT 429 (proves BOTH default and public are skipped).
  it('does not 429 a burst above default/public but below the sdk bucket (default+public skipped)', async () => {
    const { app, url, recordFailure } = await boot();
    active = app;

    // 10 > default(3) and > public(3), but < sdk(50, set by @Throttle on the
    // controller). If default OR public still applied, request #4 would 429.
    const statuses = await burst(`${url}/sdklike/record`, 10);

    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  // Runaway side: exceeding the sdk bucket DOES 429
  // (proves the sdk bucket still catches a runaway client).
  it('still 429s a runaway burst that exceeds the sdk bucket (sdk still governs)', async () => {
    const { app, url, recordFailure } = await boot();
    active = app;

    // sdk limit = 50 → first 50 pass, the 51st is over limit.
    const statuses = await burst(`${url}/sdklike/record`, 51);

    // No 429 in the first 50 → NOT capped at the low default/public(3) numbers.
    expect(statuses.slice(0, 50).every((s) => s === 200)).toBe(true);
    // The 51st trips the sdk bucket → the runaway is still caught.
    expect(statuses[50]).toBe(429);
    expect(recordFailure.mock.calls.some((c) => c[0] === 'rate_limit')).toBe(true);
  }, 20_000);
});

// Wiring guard. Reads the metadata the REAL SDK controllers must carry, so an
// edit that drops @SkipThrottle (re-throttling ingest) fails here instead of
// silently in production.
describe('SDK controllers carry the skip-throttle wiring', () => {
  it('SdkController skips BOTH default and public and keeps the sdk override', () => {
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}default`, SdkController)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}public`, SdkController)).toBe(true);
    // The sdk bucket is still raised to the production ingest ceiling.
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}sdk`, SdkController)).toBe(60000);
  });

  it('SdkPublicAliasesController skips BOTH default and public and keeps the sdk override', () => {
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}default`, SdkPublicAliasesController)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}public`, SdkPublicAliasesController)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}sdk`, SdkPublicAliasesController)).toBe(60000);
  });
});

// Payment webhooks must be exempt from EVERY bucket (a bare @SkipThrottle()
// would leave the IP-keyed public bucket applying and could 429 a retry burst).
describe('Webhooks controller is exempt from every throttler bucket', () => {
  it('WebhooksController skips default, public, AND sdk', () => {
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}default`, WebhooksController)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}public`, WebhooksController)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}sdk`, WebhooksController)).toBe(true);
  });
});

// The internal invoice-generation route has the SAME webhook-style drop risk
// and the SAME exemption, but applied PER-METHOD (only generateInvoiceInternal is @Public() +
// CRON_SECRET-authed; the rest of InvoicesController stays API-key authed). It is a
// @Public() server-to-server endpoint called by the dashboard's "Generate from
// Subscription" Server Action, so it has no req.user and falls back to IP keying, and
// every call can arrive from the dashboard host's one shared egress IP — a bare @SkipThrottle() would leave the
// 60/60s public bucket applying and could 429 a normal burst of clicks. Note the metadata
// target is the METHOD FUNCTION itself (InvoicesController.prototype.generateInvoiceInternal),
// NOT the class — @nestjs/throttler's @SkipThrottle defines method-level metadata on
// descriptor.value (the function), whereas the controller-level webhook skip above lands on
// the class. This fails loudly if the decorator is ever changed to a bare @SkipThrottle()
// (which defaults to { default: true } and would drop the public + sdk keys).
describe('Invoices generate-internal route is exempt from every throttler bucket', () => {
  const generateInternal = InvoicesController.prototype.generateInvoiceInternal;

  it('generateInvoiceInternal skips default, public, AND sdk', () => {
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}default`, generateInternal)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}public`, generateInternal)).toBe(true);
    expect(Reflect.getMetadata(`${THROTTLER_SKIP}sdk`, generateInternal)).toBe(true);
  });
});

// A PLAIN, no-decorator authed route is the shape of ~90% of the app,
// and it carries NO @SkipThrottle. Without the public-bucket skipIf, the
// minimum-of-all-buckets rule would let `public` (the lowest, 60/min) govern every
// such route, a 20x-tighter cap than the documented 1200. These two tests boot
// exactly that shape and prove:
//   - an authed plain route is governed by `default`, NOT capped at public, and
//   - an anonymous plain route IS still capped by public.
// Both go through the LIVE guard chain + filter.
describe('Public bucket is scoped to anonymous traffic (authed routes use default)', () => {
  let active: INestApplication | undefined;

  afterEach(async () => {
    if (active) {
      await active.close();
      active = undefined;
    }
  });

  // Authed plain route: a burst WAY past public(3) does NOT 429, because the
  // public bucket is skipped for authed callers and default(100) governs. If
  // public applied to authed routes, this would 429 at request 4.
  it('does NOT throttle an authed no-decorator route at the public limit', async () => {
    const { app, url, recordFailure } = await bootSkipIf();
    active = app;

    // 8 > public(3); all must pass on the strength of default(100) alone.
    const statuses = await burst(`${url}/authed/thing`, 8);

    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  // Anonymous plain route: public still bites. Proves the skipIf scopes
  // the bucket OFF for authed callers WITHOUT disabling it for anonymous ones.
  it('STILL throttles an anonymous no-decorator route at the public limit', async () => {
    const { app, url, recordFailure } = await bootSkipIf();
    active = app;

    // public = 3 → first three pass, the 4th is over limit and 429s.
    const statuses = await burst(`${url}/anon/thing`, 4);

    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(200);
    expect(statuses[2]).toBe(200);
    expect(statuses[3]).toBe(429);
    expect(recordFailure.mock.calls.some((c) => c[0] === 'rate_limit')).toBe(true);
  });
});

// Pin the REAL production config (not a copy). Proves buildThrottlerBuckets()
// wires the skipIf onto `public` ONLY, with the production limits, so an edit
// that drops the skipIf, moves it to the wrong bucket, or changes a limit fails here.
describe('Production throttler buckets wire the public-only skipIf', () => {
  const mockContext = (req: Record<string, unknown>): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  it('public carries an anonymous-only skipIf; default/sdk do not', () => {
    const buckets = buildThrottlerBuckets();
    const get = (name: string) => buckets.find((b) => b.name === name);

    // Only `public` is anonymous-scoped.
    expect(get('public')?.skipIf).toBe(isAuthenticatedRequest);
    expect(get('default')?.skipIf).toBeUndefined();
    expect(get('sdk')?.skipIf).toBeUndefined();

    // The skipIf actually does the right thing: skip (true) for authed, apply
    // (false) for anonymous.
    const skipIf = get('public')!.skipIf!;
    expect(skipIf(mockContext({ user: { organizationId: 'o1' } }))).toBe(true);
    expect(skipIf(mockContext({}))).toBe(false);
    expect(skipIf(mockContext({ user: {} }))).toBe(false);
  });

  it('keeps the production bucket limits (1200 / 60000 / 60)', () => {
    const buckets = buildThrottlerBuckets();
    const get = (name: string) => buckets.find((b) => b.name === name);
    expect(get('default')?.limit).toBe(1200);
    expect(get('sdk')?.limit).toBe(60000);
    expect(get('public')?.limit).toBe(60);
  });
});
