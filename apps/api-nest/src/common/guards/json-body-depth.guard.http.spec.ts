/**
 * DEEP-JSON 500 BAND — HTTP-level proof over a real Nest app with
 * the SAME global ValidationPipe options main.ts uses.
 *
 * App A boots WITHOUT the guard and documents the failure mode this guard
 * exists for: JSON.parse accepts a ~10,000-level-deep payload, then the
 * transform:true pipe's recursive walks (Nest's stripProtoKeys, then
 * class-transformer) blow the call stack — a 500 on a plain validation
 * problem. If this test ever starts failing because the 500 became something
 * else, the pipe internals changed and GLOBAL_BODY_MAX_DEPTH deserves a
 * fresh look.
 *
 * App B boots WITH the guard registered the way app.module.ts registers it and
 * proves the same payload now answers a clean 400 through Nest's exception
 * filter, while sane payloads are untouched.
 */
import { Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsOptional, IsString } from 'class-validator';
import * as fs from 'fs';
import * as path from 'path';
import { GLOBAL_BODY_MAX_DEPTH, JsonBodyDepthGuard } from './json-body-depth.guard';
import { INGEST_PATHS } from '../utils/ingest-body-limit';

class DepthProbeDto {
  @IsString()
  name: string;

  @IsOptional()
  payload?: unknown;
}

@Controller('probe')
class DepthProbeController {
  @Post('deep')
  receive(@Body() _dto: DepthProbeDto) {
    return { ok: true };
  }
}

const DEEP_LEVELS = 10_000;
// Raw string: JSON.stringify would itself blow the stack on a structure this
// deep, while JSON.parse handles it fine (same trick as ingest-caps.http.spec).
const deepRawBody = `{"name":"probe","payload":${'['.repeat(DEEP_LEVELS)}1${']'.repeat(DEEP_LEVELS)}}`;

function nestedObjectOfDepth(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let i = 1; i < depth; i++) {
    value = { nest: value };
  }
  return value;
}

async function bootProbeApp(withGuard: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [DepthProbeController],
    providers: withGuard ? [{ provide: APP_GUARD, useClass: JsonBodyDepthGuard }] : [],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  // Identical options to the global pipe in main.ts.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: false,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  await app.listen(0);
  return app;
}

async function postDeep(app: INestApplication, body: string) {
  const response = await fetch(`${await app.getUrl()}/v1/probe/deep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: response.status, text: await response.text() };
}

describe('without the guard (the bug this guard exists for)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootProbeApp(false);
  });
  afterAll(async () => {
    await app.close();
  });

  it("a deep payload on a transform route → 500 from the pipe's recursive walk", async () => {
    const { status } = await postDeep(app, deepRawBody);
    expect(status).toBe(500);
  });
});

describe('with the guard registered as in app.module.ts', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootProbeApp(true);
  });
  afterAll(async () => {
    await app.close();
  });

  it('the same deep payload → 400 Nest envelope naming the depth limit', async () => {
    const { status, text } = await postDeep(app, deepRawBody);
    expect(status).toBe(400);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(JSON.stringify(body.message)).toContain(String(GLOBAL_BODY_MAX_DEPTH));
  });

  it('a sane nested payload still passes', async () => {
    const { status } = await postDeep(
      app,
      JSON.stringify({ name: 'probe', payload: nestedObjectOfDepth(10) }),
    );
    expect(status).toBe(201);
  });

  it('a depth-guard 400 and a ValidationPipe 400 share the same envelope keys', async () => {
    const depthRejection = await postDeep(app, deepRawBody);
    const validationRejection = await postDeep(app, JSON.stringify({ payload: 'no name' }));
    expect(validationRejection.status).toBe(400);
    expect(Object.keys(JSON.parse(depthRejection.text)).sort()).toEqual(
      Object.keys(JSON.parse(validationRejection.text)).sort(),
    );
  });
});

describe('guard unit behavior', () => {
  const guard = new JsonBodyDepthGuard();
  const contextFor = (requestPath: string, body: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ path: requestPath, body }) }),
    }) as any;

  it('skips the ingest doors — their pre-router middleware already bounds depth at 16', () => {
    const deepBody = nestedObjectOfDepth(GLOBAL_BODY_MAX_DEPTH + 10);
    for (const ingestPath of INGEST_PATHS) {
      expect(guard.canActivate(contextFor(ingestPath, deepBody))).toBe(true);
    }
  });

  it('rejects the same body on a non-ingest path', () => {
    const deepBody = nestedObjectOfDepth(GLOBAL_BODY_MAX_DEPTH + 10);
    expect(() => guard.canActivate(contextFor('/v1/subscriptions/sub-1', deepBody))).toThrow(
      /nested more than/,
    );
  });

  it('skips raw Buffer bodies (Stripe webhook mount)', () => {
    expect(guard.canActivate(contextFor('/v1/webhooks/stripe', Buffer.alloc(64)))).toBe(true);
  });

  it('skips body-less requests', () => {
    expect(guard.canActivate(contextFor('/v1/subscriptions', undefined))).toBe(true);
    expect(guard.canActivate(contextFor('/v1/subscriptions', null))).toBe(true);
  });

  it('accepts a body at exactly the cap', () => {
    expect(
      guard.canActivate(
        contextFor('/v1/subscriptions', nestedObjectOfDepth(GLOBAL_BODY_MAX_DEPTH)),
      ),
    ).toBe(true);
  });
});

describe('production wiring', () => {
  it('app.module.ts registers JsonBodyDepthGuard as a global APP_GUARD', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../app.module.ts'), 'utf8');
    expect(source).toMatch(/provide:\s*APP_GUARD,\s*useClass:\s*JsonBodyDepthGuard/);
  });
});
