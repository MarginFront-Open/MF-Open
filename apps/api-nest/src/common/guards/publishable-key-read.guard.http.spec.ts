/**
 * Registration-order and full-chain proof over real Nest apps (same harness
 * family as json-body-depth.guard.http.spec.ts).
 *
 * The unit spec proves canActivate; THIS file proves the wiring, because the wiring is
 * where a fail-open mistake would live: root-module APP_GUARDs run BEFORE imported modules'
 * (Nest scans the root first), so PublishableKeyReadGuard registered in app.module.ts
 * would run before CombinedAuthGuard, see request.user undefined, and silently allow
 * every publishable key. Under deny-by-default that un-gates the ENTIRE API, which makes
 * it the single highest-consequence wiring fact in the repo.
 *
 * Three apps:
 *   A — the real topology (guard in the imported auth module, AFTER the auth guard).
 *       Proves deny-by-default on an unmarked route, the allow paths, that the REAL
 *       SdkPublicAliasesController answers a publishable key on /v1/verify and
 *       /v1/me/key (the wire test — a dropped decorator on that controller
 *       would pass a probe-only test), and that a route-scoped SecretKeyGuard (the
 *       portal-sessions topology) runs AFTER the global deny, so a publishable key
 *       gets the publishable_key_forbidden body there, not SecretKeyGuard's 401.
 *   B — the guard in the ROOT module: documents the fail-open no-op.
 *   C — the real chain, guard + PublishableKeyWriteGuardInterceptor, mirroring
 *       app.module.ts's APP_INTERCEPTOR registration. Proves the pk ingest 403
 *       comes from the interceptor (whose exception class pages the alerts channel) while
 *       every other pk write gets the guard's deny first.
 */

import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  Module,
  Post,
  Provider,
  UseGuards,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { PublishableKeyReadGuard, PublishableKeyAllowed } from './publishable-key-read.guard';
import { PublishableKeyWriteGuardInterceptor } from '../interceptors/publishable-key-write-guard.interceptor';
import { SecretKeyGuard } from './secret-key.guard';
import { IngestRoute } from './org-role.guard';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { SdkPublicAliasesController } from '../../modules/sdk/sdk-public-aliases.controller';
import { SdkService } from '../../modules/sdk/sdk.service';
import { AuthService } from '../../modules/auth/auth.service';
import { CombinedAuthGuard } from '../../modules/auth/guards/combined-auth.guard';

/**
 * Stands in for CombinedAuthGuard: populates request.user from a test header, at the
 * same position in the guard chain (first provider of the imported auth module).
 */
@Injectable()
class HeaderAuthStubGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const keyType = request.headers['x-test-key-type'];
    if (keyType === 'publishable' || keyType === 'secret') {
      request.user = {
        authMethod: 'api-key',
        keyType,
        organizationId: 'org-http-probe',
        apiKeyId: 'key_http_probe',
        role: 'member',
      };
    }
    return true;
  }
}

@Controller('probe')
class ReadProbeController {
  @Get('allowed')
  @PublishableKeyAllowed()
  allowed() {
    return { ok: true };
  }

  // No decorator on purpose: this probe IS the default posture — denied.
  @Get('unmarked')
  unmarked() {
    return { ok: true };
  }

  @Get('public')
  @Public()
  publicProbe() {
    return { ok: true };
  }

  // The portal-sessions topology (POST /v1/portal-sessions): a route-scoped
  // SecretKeyGuard, secret-only by construction. Route-scoped guards run AFTER global
  // ones, so the global deny wins for a publishable key and no double-deny is possible.
  @Post('secret-guarded')
  @UseGuards(SecretKeyGuard)
  secretGuarded() {
    return { ok: true };
  }
}

@Controller('chain')
class ChainProbeController {
  @Post('ingest')
  @IngestRoute()
  ingest() {
    return { ok: true };
  }

  @Post('unmarked')
  unmarkedWrite() {
    return { ok: true };
  }

  @Get('allowed')
  @PublishableKeyAllowed()
  allowed() {
    return { ok: true };
  }
}

function authStubModule(withReadGuard: boolean) {
  const providers: Provider[] = [{ provide: APP_GUARD, useClass: HeaderAuthStubGuard }];
  if (withReadGuard) {
    providers.push({ provide: APP_GUARD, useClass: PublishableKeyReadGuard });
  }

  @Module({ providers })
  class AuthStubModule {}

  return AuthStubModule;
}

const sdkServiceStub = {
  verifyApiKey: async (organizationId: string) => ({
    valid: true,
    organization: { id: organizationId, name: 'Probe Org' },
  }),
};

async function bootApp(
  topology: 'imported-module-after-auth' | 'root-module' | 'full-chain',
): Promise<INestApplication> {
  const rootProviders: Provider[] = [];
  if (topology === 'root-module') {
    rootProviders.push({ provide: APP_GUARD, useClass: PublishableKeyReadGuard });
  }
  if (topology === 'full-chain') {
    rootProviders.push({ provide: APP_INTERCEPTOR, useClass: PublishableKeyWriteGuardInterceptor });
  }

  const builder = Test.createTestingModule({
    imports: [authStubModule(topology !== 'root-module')],
    controllers:
      topology === 'full-chain'
        ? [ChainProbeController]
        : [ReadProbeController, SdkPublicAliasesController],
    providers: [
      ...rootProviders,
      { provide: SdkService, useValue: sdkServiceStub },
      // SecretKeyGuard's dependency. Never reached in these tests: the requests that
      // get PAST the global deny carry no x-api-key header, so the guard 401s first.
      { provide: AuthService, useValue: {} },
    ],
  });
  // The real SdkPublicAliasesController mounts CombinedAuthGuard at class scope; the
  // header stub already plays that role at the global position.
  builder.overrideGuard(CombinedAuthGuard).useValue({ canActivate: () => true });

  const app = (await builder.compile()).createNestApplication();
  app.setGlobalPrefix('v1');
  await app.listen(0);
  return app;
}

async function request(
  app: INestApplication,
  method: 'GET' | 'POST',
  routePath: string,
  keyType?: string,
) {
  const headers: Record<string, string> = keyType ? { 'x-test-key-type': keyType } : {};
  const response = await fetch(`${await app.getUrl()}/v1/${routePath}`, { method, headers });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

describe('App A — guard registered as in auth.module.ts: imported module, after the auth guard', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp('imported-module-after-auth');
  });
  afterAll(async () => {
    await app.close();
  });

  it('a publishable key on an UNMARKED route gets the 403 with the actionable code — deny by default', async () => {
    const { status, body } = await request(app, 'GET', 'probe/unmarked', 'publishable');
    expect(status).toBe(403);
    expect(body.code).toBe('publishable_key_forbidden');
    expect(String(body.message)).toContain('mf_sk_');
  });

  it('a secret key still reads the same unmarked route', async () => {
    const { status } = await request(app, 'GET', 'probe/unmarked', 'secret');
    expect(status).toBe(200);
  });

  it('a publishable key still reads a @PublishableKeyAllowed route', async () => {
    const { status } = await request(app, 'GET', 'probe/allowed', 'publishable');
    expect(status).toBe(200);
  });

  it('a publishable key still reads a @Public route — under deny-by-default this branch is the difference between a working public route and a dead one', async () => {
    const { status } = await request(app, 'GET', 'probe/public', 'publishable');
    expect(status).toBe(200);
  });

  it("an unauthenticated request is not this guard's business", async () => {
    const { status } = await request(app, 'GET', 'probe/unmarked');
    expect(status).toBe(200);
  });

  it('wire test: the REAL /v1/verify still answers a publishable key 200', async () => {
    const { status, body } = await request(app, 'GET', 'verify', 'publishable');
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });

  it("wire test: the REAL /v1/me/key still answers a publishable key 200 — code-cost-clarity's auth-hold recovery probes this route and a 403 would wedge the hold permanently", async () => {
    const { status, body } = await request(app, 'GET', 'me/key', 'publishable');
    expect(status).toBe(200);
    expect(body).toEqual({ role: 'member', keyType: 'publishable' });
  });

  it("a publishable key on a route-scoped SecretKeyGuard route (the portal-sessions topology) gets the GLOBAL deny body, not SecretKeyGuard's 401 — route-scoped guards run after global ones", async () => {
    const { status, body } = await request(app, 'POST', 'probe/secret-guarded', 'publishable');
    expect(status).toBe(403);
    expect(body.code).toBe('publishable_key_forbidden');
  });

  it('the real SecretKeyGuard IS still in that chain, after the global guard: a non-publishable caller with no x-api-key header reaches it and gets its 401', async () => {
    const { status, body } = await request(app, 'POST', 'probe/secret-guarded', 'secret');
    expect(status).toBe(401);
    expect(String(body.message)).toContain('API key required');
  });
});

describe('App B — the fail-open bug the placement prevents: guard registered in the ROOT module', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp('root-module');
  });
  afterAll(async () => {
    await app.close();
  });

  it('root-module APP_GUARDs run before the imported auth guard, so request.user is unset and the publishable key sails through — under deny-by-default this silently un-gates the ENTIRE API, not five routes', async () => {
    const { status } = await request(app, 'GET', 'probe/unmarked', 'publishable');
    expect(status).toBe(200);
  });
});

describe('App C — the real chain: guard + PublishableKeyWriteGuardInterceptor', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp('full-chain');
  });
  afterAll(async () => {
    await app.close();
  });

  it('a publishable-key POST to an @IngestRoute gets the WRITE interceptor 403 — the exception class that pages the alerts channel survives on the money path', async () => {
    const { status, body } = await request(app, 'POST', 'chain/ingest', 'publishable');
    expect(status).toBe(403);
    expect(String(body.message)).toContain('cannot perform write operations');
    expect(body.code).toBeUndefined();
  });

  it('a publishable-key POST to an unmarked route gets the GUARD 403 — guards precede interceptors, so the non-ingest pk write deny is a log line, not an alert', async () => {
    const { status, body } = await request(app, 'POST', 'chain/unmarked', 'publishable');
    expect(status).toBe(403);
    expect(body.code).toBe('publishable_key_forbidden');
  });

  it('a publishable-key GET to an @PublishableKeyAllowed route passes the full chain', async () => {
    const { status } = await request(app, 'GET', 'chain/allowed', 'publishable');
    expect(status).toBe(200);
  });

  it('a secret-key POST to the unmarked route passes the full chain — neither layer touches it (201 is the Nest default for POST)', async () => {
    const { status } = await request(app, 'POST', 'chain/unmarked', 'secret');
    expect(status).toBe(201);
  });
});

describe('production wiring', () => {
  const authModuleSource = fs.readFileSync(
    path.join(__dirname, '../../modules/auth/auth.module.ts'),
    'utf8',
  );
  const appModuleSource = fs.readFileSync(path.join(__dirname, '../../app.module.ts'), 'utf8');

  it('auth.module.ts registers PublishableKeyReadGuard as an APP_GUARD', () => {
    expect(authModuleSource).toMatch(/provide:\s*APP_GUARD,\s*useClass:\s*PublishableKeyReadGuard/);
  });

  it('the registration sits AFTER CombinedAuthGuard in the providers array (order is execution order within one module)', () => {
    const combinedIndex = authModuleSource.indexOf('useClass: CombinedAuthGuard');
    const readGuardIndex = authModuleSource.indexOf('useClass: PublishableKeyReadGuard');
    expect(combinedIndex).toBeGreaterThan(-1);
    expect(readGuardIndex).toBeGreaterThan(combinedIndex);
  });

  it('app.module.ts does NOT register it — a root-module registration is the fail-open no-op proven above', () => {
    // The comment above JsonBodyDepthGuard may NAME the guard; what must never appear
    // is a registration of it.
    expect(appModuleSource).not.toMatch(/useClass:\s*PublishableKeyReadGuard/);
  });
});
