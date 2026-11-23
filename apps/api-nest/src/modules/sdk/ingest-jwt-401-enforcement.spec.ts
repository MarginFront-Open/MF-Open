/**
 * Login-token-at-ingest ENFORCEMENT: the whole chain over real HTTP.
 *
 * The unit specs each stub the piece next to them: the controller spec overrides
 * the guard, the guard spec never reaches a handler, the filter spec builds
 * exceptions by hand. This boots a real Nest HTTP app with the REAL
 * CombinedAuthGuard, the REAL ingest controllers, the REAL
 * CustomerFailureAlertFilter and the REAL AuthFailureThrottleService over an
 * in-memory Redis stub, then sends an actual Bearer JWT at the ingest door and
 * watches what comes back off the socket.
 *
 * Modeled on modules/auth/authfail-throttle-enforcement.spec.ts. Only jose is
 * mocked, because verifying a real Better Auth signature would need a live JWKS
 * endpoint.
 *
 * The three things only this file can prove:
 *   - the contracted 401 body and its code reach the client, not just the throw
 *     site, and no 500 escapes,
 *   - the filter classifies it 'auth_401' and keeps it on the UNTRUSTED IP
 *     bucket even though req.user is set,
 *   - the failed-auth counter is never incremented by this path.
 */
import 'reflect-metadata';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as jose from 'jose';
import { SdkController } from './sdk.controller';
import { SdkPublicAliasesController } from './sdk-public-aliases.controller';
import { SdkService } from './sdk.service';
import { InvoicesService } from '../invoices/invoices.service';
import { AuthService } from '../auth/auth.service';
import { AuthFailureThrottleService } from '../auth/auth-failure-throttle.service';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { CustomerFailureAlertFilter } from '../../common/filters/customer-failure-alert.filter';
import { CustomerFailureAlertService } from '../auth/customer-failure-alert.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ingestBodyParsers, INGEST_PATHS } from '../../common/utils/ingest-body-limit';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'jwks-key-set'),
  jwtVerify: jest.fn(),
  errors: {
    JWTExpired: class JWTExpired extends Error {},
    JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {},
  },
}));
const jwtVerifyMock = jose.jwtVerify as unknown as jest.Mock;

// Counting the REAL throttle service's Redis calls is the point: "the counter is
// never incremented" is only meaningful against the real service.
const throttleEval = jest.fn().mockResolvedValue(1);
const mockRedis = {
  eval: throttleEval,
  incr: jest.fn(),
  expire: jest.fn(),
  set: jest.fn(),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
};
jest.mock('ioredis', () => jest.fn().mockImplementation(() => mockRedis));

const DOORS = [
  ['canonical', '/v1/usage/record'],
  ['legacy alias', '/v1/sdk/usage/record'],
] as const;

const JWT = 'header.payload.signature';

async function boot() {
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const recordUsage = jest.fn().mockResolvedValue({ processed: 1, successful: 1, failed: 0 });
  const env: Record<string, string> = {
    REDIS_URL: 'redis://localhost:6379',
    BETTER_AUTH_URL: 'https://auth.example.test',
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [SdkController, SdkPublicAliasesController],
    providers: [
      { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      {
        provide: PrismaService,
        useValue: { api_keys: { findFirst: jest.fn(), update: jest.fn() } },
      },
      { provide: SdkService, useValue: { recordUsage } },
      { provide: InvoicesService, useValue: {} },
      { provide: CustomerFailureAlertService, useValue: { recordFailure } },
      AuthService,
      AuthFailureThrottleService,
      { provide: APP_GUARD, useClass: CombinedAuthGuard },
      { provide: APP_FILTER, useClass: CustomerFailureAlertFilter },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  app.use(INGEST_PATHS, ...ingestBodyParsers());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: false,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.listen(0);
  return { app, url: await app.getUrl(), recordFailure, recordUsage };
}

function ingestBody() {
  return {
    records: [
      {
        customerExternalId: 'cust-1',
        agentCode: 'agent-1',
        signalName: 'signal-1',
        model: 'claude-sonnet-4-6',
        modelProvider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
      },
    ],
  };
}

async function postWithJwt(url: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${JWT}`,
      'user-agent': '@marginfront/sdk/1.0',
    },
    body: JSON.stringify(ingestBody()),
  });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

describe('enforcement — a login token at the ingest door, end to end', () => {
  let active: INestApplication | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    throttleEval.mockResolvedValue(1);
    jwtVerifyMock.mockResolvedValue({
      payload: { id: 'user-1', email: 'a@acme.example', name: 'A Human', emailVerified: true },
    });
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

  it.each(DOORS)('%s door puts the contracted 401 on the wire, never a 500', async (_l, path) => {
    const { app, url, recordUsage } = await boot();
    active = app;

    const { status, body } = await postWithJwt(`${url}${path}`);

    expect(status).toBe(401);
    expect(body).toEqual({
      statusCode: 401,
      code: 'use_api_key',
      message:
        "This endpoint records usage with an API key, and a login token doesn't carry one. " +
        'Send your secret key (mf_sk_...) in the x-api-key header instead. ' +
        'You can create one in Build > API keys.',
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('the filter records auth_401 and keeps the count on the caller IP, not an org', async () => {
    const { app, url, recordFailure } = await boot();
    active = app;

    await postWithJwt(`${url}/v1/usage/record`);

    expect(recordFailure).toHaveBeenCalledTimes(1);
    const [failureClass, ctx] = recordFailure.mock.calls[0];
    expect(failureClass).toBe('auth_401');
    // req.user IS set on this 401. buildContext keys on
    // organizationId, so the request correctly stays on the untrusted IP bucket.
    expect(ctx.organizationId).toBeUndefined();
    expect(ctx.callerIp).toBeDefined();
  });

  it('never increments the failed-auth counter', async () => {
    const { app, url } = await boot();
    active = app;

    await postWithJwt(`${url}/v1/usage/record`);

    expect(throttleEval).not.toHaveBeenCalled();
  });
});
