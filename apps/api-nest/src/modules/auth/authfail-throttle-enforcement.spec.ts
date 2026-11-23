/**
 * Failed-auth throttle ENFORCEMENT: the whole chain over real HTTP.
 *
 * The unit specs prove each piece in isolation, and each one stubs the piece
 * next to it: the guard spec stubs the throttle service, the service spec stubs
 * Redis, the filter spec constructs exceptions by hand. This boots a real Nest
 * HTTP app with the REAL guard, the REAL throttle service (over an in-memory
 * Redis stub, so the counting logic genuinely runs), the REAL AuthService over a
 * stubbed Prisma, and the REAL filter, then makes real requests and watches what
 * comes back off the socket.
 *
 * Modeled on modules/sdk/throttler-enforcement.spec.ts, including its "scale the
 * numbers, keep the structure" approach: the threshold is 3 here so a burst is
 * five requests instead of fifty. Nothing else about the shape changes.
 *
 * The four things only this file can prove:
 *   - the alert counter still sees every failure BELOW the threshold, so the
 *     Slack auth-failure page is not starved by the throttling,
 *   - no 429 in the burst is ever classified as 'rate_limit',
 *   - the 429's body and Retry-After actually reach the client, not just
 *     setHeader,
 *   - a real burst leaves its counter carrying a TTL, so the block always
 *     lifts on its own.
 */
import 'reflect-metadata';
import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashApiKeyForLookup } from '@marginfront/db';
import { AuthService } from './auth.service';
import { AuthFailureThrottleService } from './auth-failure-throttle.service';
import { CombinedAuthGuard } from './guards/combined-auth.guard';
import { CustomerFailureAlertFilter } from '../../common/filters/customer-failure-alert.filter';
import { CustomerFailureAlertService } from './customer-failure-alert.service';
import { PrismaService } from '../../common/prisma/prisma.service';

// One in-memory counter store shared by the booted app, so the REAL service's
// counting runs for real without a Redis process. It models a TTL per key
// because "did the counter end up with one" is asserted on its own: a
// counter without a TTL never expires, so that IP would answer 429 forever.
const counters = new Map<string, { value: number; ttl: number }>();
const mockRedis = {
  eval: jest.fn(async (_script: string, _numKeys: number, key: string, windowSeconds: string) => {
    const entry = counters.get(key) ?? { value: 0, ttl: -1 };
    entry.value += 1;
    if (entry.ttl < 0) {
      entry.ttl = Number(windowSeconds);
    }
    counters.set(key, entry);
    return entry.value;
  }),
  incr: jest.fn(),
  expire: jest.fn(),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
};
jest.mock('ioredis', () => jest.fn().mockImplementation(() => mockRedis));

const THRESHOLD = 3;
const VALID_KEY = 'mf_sk_a_working_key';
const BAD_KEY = 'mf_sk_never_existed';
const REVOKED_KEY = 'mf_sk_revoked_but_recognizable';

@Controller('probe')
class ThrottleProbeController {
  @Get('thing')
  ping() {
    return { ok: true };
  }
}

function prismaStub() {
  const validRow = {
    id: 'key-valid',
    name: 'Prod key',
    organizationId: 'org-1',
    keyType: 'secret',
    status: 'active',
    role: 'developer',
    apiKeyLookupHash: hashApiKeyForLookup(VALID_KEY),
    apiKeyPlaintext: null,
    deletedAt: null,
    revokedAt: null,
    permissions: null,
    organizations: { id: 'org-1', name: 'Acme Co' },
  };
  const revokedRow = {
    ...validRow,
    id: 'key-revoked',
    status: 'revoked',
    apiKeyLookupHash: hashApiKeyForLookup(REVOKED_KEY),
    revokedAt: new Date('2026-08-20T00:00:00.000Z'),
  };
  const findFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const matches = (row: Record<string, unknown>) =>
      Object.entries(where).every(([field, value]) => row[field] === value);
    if (matches(validRow)) return validRow;
    if (matches(revokedRow)) return revokedRow;
    return null;
  });
  return { api_keys: { findFirst, update: jest.fn().mockResolvedValue({}) } };
}

interface BootedApp {
  app: INestApplication;
  url: string;
  recordFailure: jest.Mock;
}

async function boot(): Promise<BootedApp> {
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const env: Record<string, string> = {
    REDIS_URL: 'redis://localhost:6379',
    AUTH_FAILURE_THROTTLE_THRESHOLD: String(THRESHOLD),
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ThrottleProbeController],
    providers: [
      { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      { provide: PrismaService, useValue: prismaStub() },
      AuthService,
      AuthFailureThrottleService,
      { provide: CustomerFailureAlertService, useValue: { recordFailure } },
      // Exactly how production orders them: auth guard first, filter global.
      { provide: APP_GUARD, useClass: CombinedAuthGuard },
      { provide: APP_FILTER, useClass: CustomerFailureAlertFilter },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return { app, url: await app.getUrl(), recordFailure };
}

async function get(url: string, apiKey?: string) {
  const res = await fetch(url, {
    // An SDK user-agent makes the request customer-shaped, so the filter's cheap
    // scanner gate lets it through to recordFailure. That is what makes the
    // alert-not-starved assertion meaningful.
    headers: {
      'user-agent': '@marginfront/sdk/1.0',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
  });
  const body = await res.text();
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

describe('Failed-auth throttle enforcement (integration)', () => {
  let active: INestApplication | undefined;

  beforeEach(() => {
    counters.clear();
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (active) {
      await active.close();
      active = undefined;
    }
    jest.restoreAllMocks();
  });

  it('turns a bad-key burst into 401s then 429s, without starving the auth-failure alert', async () => {
    const { app, url, recordFailure } = await boot();
    active = app;

    const statuses: number[] = [];
    for (let i = 0; i < THRESHOLD + 2; i++) {
      statuses.push((await get(`${url}/probe/thing`, BAD_KEY)).status);
    }

    expect(statuses).toEqual([401, 401, 401, 429, 429]);

    // The alert counter saw every failure below the threshold and NOTHING above
    // it. With the shipped numbers (throttle 50, alert 5) the Slack page fires
    // 45 failures before the block ever engages.
    const classes = recordFailure.mock.calls.map((call) => call[0]);
    expect(classes).toEqual(['auth_401', 'auth_401', 'auth_401']);
  });

  it('leaves the counter carrying a TTL, so a blocked network recovers on its own', async () => {
    const { app, url } = await boot();
    active = app;

    for (let i = 0; i < THRESHOLD + 2; i++) {
      await get(`${url}/probe/thing`, BAD_KEY);
    }

    const entries = [...counters.values()];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.ttl).toBe(900);
    }
  });

  it('never classifies a failed-auth 429 as rate_limit', async () => {
    const { app, url, recordFailure } = await boot();
    active = app;

    for (let i = 0; i < THRESHOLD + 2; i++) {
      await get(`${url}/probe/thing`, BAD_KEY);
    }

    const classes = recordFailure.mock.calls.map((call) => call[0]);
    expect(classes).not.toContain('rate_limit');
  });

  it('puts the contracted body and Retry-After on the wire, not just on setHeader', async () => {
    const { app, url } = await boot();
    active = app;

    let blocked: Awaited<ReturnType<typeof get>> | undefined;
    for (let i = 0; i < THRESHOLD + 1; i++) {
      blocked = await get(`${url}/probe/thing`, BAD_KEY);
    }

    expect(blocked?.status).toBe(429);
    expect(blocked?.retryAfter).toBe('5');
    expect(JSON.parse(blocked!.body)).toEqual({
      statusCode: 429,
      code: 'too_many_auth_failures',
      message:
        'Too many failed API key attempts from this network. Wait a few minutes, ' +
        "then check the key you're sending in Build > API keys.",
    });
  });

  it('still lets a VALID key through from an IP that is already blocked', async () => {
    const { app, url } = await boot();
    active = app;

    for (let i = 0; i < THRESHOLD + 1; i++) {
      await get(`${url}/probe/thing`, BAD_KEY);
    }
    expect((await get(`${url}/probe/thing`, BAD_KEY)).status).toBe(429);

    // The whole reason the check sits after the credential verdict.
    expect((await get(`${url}/probe/thing`, VALID_KEY)).status).toBe(200);
  });

  it('hands the revoked-key owner-email path its attempts before the block engages', async () => {
    // The owner email has no threshold at all: it fires on attempt 1, gated only
    // by a cooldown. So it must see revokedKey facts on the pre-block requests.
    const { app, url, recordFailure } = await boot();
    active = app;

    const statuses: number[] = [];
    for (let i = 0; i < THRESHOLD + 1; i++) {
      statuses.push((await get(`${url}/probe/thing`, REVOKED_KEY)).status);
    }

    expect(statuses).toEqual([401, 401, 401, 429]);
    expect(recordFailure).toHaveBeenCalledTimes(THRESHOLD);
    for (const [failureClass, ctx] of recordFailure.mock.calls) {
      expect(failureClass).toBe('auth_401');
      expect(ctx.revokedKey).toMatchObject({ organizationId: 'org-1' });
    }
  });
});
