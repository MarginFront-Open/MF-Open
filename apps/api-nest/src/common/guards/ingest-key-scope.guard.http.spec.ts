/**
 * Registration-order and full-chain proof over real Nest apps (same harness
 * family as publishable-key-read.guard.http.spec.ts).
 *
 * The unit spec proves canActivate; THIS file proves the wiring, because the wiring is
 * where a fail-open mistake would live. Root-module APP_GUARDs run BEFORE imported modules'
 * (Nest scans the root first), so IngestKeyScopeGuard registered in app.module.ts would
 * run before CombinedAuthGuard, see request.user undefined, return true for every
 * request, and ship green having gated nothing. The guard would look installed and
 * every authenticated route would stay open to an ingest key.
 *
 * Three apps:
 *   A — the real topology (guard in the imported auth module, AFTER the auth guard).
 *       Proves deny-by-default on an unmarked route, every allow path, that the REAL SdkPublicAliasesController still answers an ingest key
 *       on /v1/verify and /v1/me/key (a dropped decorator there would pass a probe-only
 *       test), and that a route-scoped SecretKeyGuard route — the POST /v1/portal-sessions
 *       topology, which validates keyType and never role — gets the global role deny
 *       first. Without it, an ingest key could mint a customer portal token there.
 *   B — the guard in the ROOT module: documents the fail-open no-op. This app exists
 *       solely to keep that trap written down in executable form.
 *   C — the real two-guard order: PublishableKeyReadGuard THEN IngestKeyScopeGuard.
 *       Proves a publishable key whose permissions floored to 'ingest' is told to send
 *       its secret key, not to change its key's role. Whichever guard runs first owns
 *       the message, so the order is a customer-facing decision, not a style choice.
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
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { IngestKeyScopeGuard, IngestKeyAllowed } from './ingest-key-scope.guard';
import { PublishableKeyReadGuard } from './publishable-key-read.guard';
import { SecretKeyGuard } from './secret-key.guard';
import { IngestRoute } from './org-role.guard';
import { Public } from '../../modules/auth/decorators/public.decorator';
import { SdkPublicAliasesController } from '../../modules/sdk/sdk-public-aliases.controller';
import { SdkService } from '../../modules/sdk/sdk.service';
import { AuthService } from '../../modules/auth/auth.service';
import { CombinedAuthGuard } from '../../modules/auth/guards/combined-auth.guard';

/**
 * Stands in for CombinedAuthGuard: populates request.user from test headers, at the same
 * position in the guard chain (first provider of the imported auth module). The role
 * header mirrors what AuthService derives from the api_keys row.
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
        role: request.headers['x-test-role'] ?? 'member',
      };
    }
    return true;
  }
}

@Controller('probe')
class IngestProbeController {
  @Get('allowed')
  @IngestKeyAllowed()
  allowed() {
    return { ok: true };
  }

  // No decorator on purpose: this probe IS the default posture — denied.
  @Get('unmarked')
  unmarked() {
    return { ok: true };
  }

  @Post('unmarked-write')
  unmarkedWrite() {
    return { ok: true };
  }

  @Get('public')
  @Public()
  publicProbe() {
    return { ok: true };
  }

  @Post('ingest')
  @IngestRoute()
  ingest() {
    return { ok: true };
  }

  // The portal-sessions topology (POST /v1/portal-sessions): a route-scoped
  // SecretKeyGuard, which validates keyType and NEVER role. Route-scoped guards run
  // AFTER global ones, so the global role deny wins and an ingest key cannot
  // mint a customer portal token here.
  @Post('secret-guarded')
  @UseGuards(SecretKeyGuard)
  secretGuarded() {
    return { ok: true };
  }
}

function authStubModule(guards: Provider[]) {
  const providers: Provider[] = [{ provide: APP_GUARD, useClass: HeaderAuthStubGuard }, ...guards];

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
  topology: 'imported-module-after-auth' | 'root-module' | 'both-key-guards',
): Promise<INestApplication> {
  const importedGuards: Provider[] = [];
  const rootProviders: Provider[] = [];
  if (topology === 'imported-module-after-auth') {
    importedGuards.push({ provide: APP_GUARD, useClass: IngestKeyScopeGuard });
  }
  if (topology === 'root-module') {
    rootProviders.push({ provide: APP_GUARD, useClass: IngestKeyScopeGuard });
  }
  if (topology === 'both-key-guards') {
    // The production order in auth.module.ts: key TYPE first, then key ROLE.
    importedGuards.push({ provide: APP_GUARD, useClass: PublishableKeyReadGuard });
    importedGuards.push({ provide: APP_GUARD, useClass: IngestKeyScopeGuard });
  }

  const builder = Test.createTestingModule({
    imports: [authStubModule(importedGuards)],
    controllers: [IngestProbeController, SdkPublicAliasesController],
    providers: [
      ...rootProviders,
      { provide: SdkService, useValue: sdkServiceStub },
      // SecretKeyGuard's dependency. Never reached by the requests that matter here:
      // they carry no x-api-key header, so the guard 401s if it is ever reached.
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
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${await app.getUrl()}/v1/${routePath}`, { method, headers });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const EXPLICIT_INGEST = { 'x-test-key-type': 'secret', 'x-test-role': 'ingest' };
const MEMBER_SECRET = { 'x-test-key-type': 'secret', 'x-test-role': 'member' };

describe('App A — guard registered as in auth.module.ts: imported module, after the auth guard', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp('imported-module-after-auth');
  });
  afterAll(async () => {
    await app.close();
  });

  it('an explicit ingest key on an UNMARKED route gets the 403 with the actionable code — deny by default', async () => {
    const { status, body } = await request(app, 'GET', 'probe/unmarked', EXPLICIT_INGEST);
    expect(status).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
    expect(body.key_role).toBe('ingest');
    expect(String(body.message)).toContain('API keys');
  });

  it('the deny covers writes too, not only the money-shaped reads', async () => {
    const { status, body } = await request(app, 'POST', 'probe/unmarked-write', EXPLICIT_INGEST);
    expect(status).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
  });

  it('a member-role secret key still reads the same unmarked route', async () => {
    const { status } = await request(app, 'GET', 'probe/unmarked', MEMBER_SECRET);
    expect(status).toBe(200);
  });

  it('an explicit ingest key still reads an @IngestKeyAllowed route', async () => {
    const { status } = await request(app, 'GET', 'probe/allowed', EXPLICIT_INGEST);
    expect(status).toBe(200);
  });

  it('an explicit ingest key still POSTs to an @IngestRoute — the ingest path is untouched (201 is the Nest default for POST)', async () => {
    const { status } = await request(app, 'POST', 'probe/ingest', EXPLICIT_INGEST);
    expect(status).toBe(201);
  });

  it('an explicit ingest key still reads a @Public route', async () => {
    const { status } = await request(app, 'GET', 'probe/public', EXPLICIT_INGEST);
    expect(status).toBe(200);
  });

  it("an unauthenticated request is not this guard's business", async () => {
    const { status } = await request(app, 'GET', 'probe/unmarked');
    expect(status).toBe(200);
  });

  it('wire test: the REAL /v1/verify still answers an ingest key 200 — connect()/verify() is the first call the SDK and code-cost-clarity make', async () => {
    const { status, body } = await request(app, 'GET', 'verify', EXPLICIT_INGEST);
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });

  it("wire test: the REAL /v1/me/key still answers an ingest key 200 — code-cost-clarity's auth-hold recovery probes it every 5 minutes and a 403 would wedge the hold permanently", async () => {
    const { status, body } = await request(app, 'GET', 'me/key', EXPLICIT_INGEST);
    expect(status).toBe(200);
    expect(body).toEqual({ role: 'ingest', keyType: 'secret' });
  });

  it('an ingest key on the portal-sessions topology (route-scoped SecretKeyGuard) is refused by the GLOBAL role deny — SecretKeyGuard validates keyType and never role, so without it an ingest key could mint a customer portal token', async () => {
    const { status, body } = await request(app, 'POST', 'probe/secret-guarded', EXPLICIT_INGEST);
    expect(status).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
  });

  it('the real SecretKeyGuard IS still in that chain, after the global guard: a member-role caller with no x-api-key header reaches it and gets its 401', async () => {
    const { status, body } = await request(app, 'POST', 'probe/secret-guarded', MEMBER_SECRET);
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

  it('root-module APP_GUARDs run before the imported auth guard, so request.user is unset and the ingest key sails through — the guard ships green having gated nothing', async () => {
    const { status } = await request(app, 'GET', 'probe/unmarked', EXPLICIT_INGEST);
    expect(status).toBe(200);
  });

  it('the same request denies under App A — the two apps differ ONLY in where the guard is registered, which is what makes this a wiring proof and not a behavior one', async () => {
    const appA = await bootApp('imported-module-after-auth');
    try {
      const { status } = await request(appA, 'GET', 'probe/unmarked', EXPLICIT_INGEST);
      expect(status).toBe(403);
    } finally {
      await appA.close();
    }
  });
});

describe('App C — the two key guards in production order: PublishableKeyReadGuard, then IngestKeyScopeGuard', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp('both-key-guards');
  });
  afterAll(async () => {
    await app.close();
  });

  it("a publishable key whose permissions floored to 'ingest' is told to send its SECRET key, not to change its key's role — the key-TYPE answer is the true root cause and it has to win", async () => {
    const { status, body } = await request(app, 'GET', 'probe/unmarked', {
      'x-test-key-type': 'publishable',
      'x-test-role': 'ingest',
    });
    expect(status).toBe(403);
    expect(body.code).toBe('publishable_key_forbidden');
    expect(String(body.message)).toContain('mf_sk_');
  });

  it('an explicit ingest SECRET key still gets the role answer through the same chain', async () => {
    const { status, body } = await request(app, 'GET', 'probe/unmarked', EXPLICIT_INGEST);
    expect(status).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
  });

  it('a publishable key on a route both guards allow passes the whole chain', async () => {
    const { status } = await request(app, 'GET', 'verify', {
      'x-test-key-type': 'publishable',
      'x-test-role': 'ingest',
    });
    expect(status).toBe(200);
  });
});

describe('production wiring', () => {
  const authModuleSource = fs.readFileSync(
    path.join(__dirname, '../../modules/auth/auth.module.ts'),
    'utf8',
  );
  const appModuleSource = fs.readFileSync(path.join(__dirname, '../../app.module.ts'), 'utf8');

  it('auth.module.ts registers IngestKeyScopeGuard as an APP_GUARD', () => {
    expect(authModuleSource).toMatch(/provide:\s*APP_GUARD,\s*useClass:\s*IngestKeyScopeGuard/);
  });

  it('the registration sits AFTER CombinedAuthGuard in the providers array (order is execution order within one module) — before it, request.user is undefined and the guard is a no-op', () => {
    const combinedIndex = authModuleSource.indexOf('useClass: CombinedAuthGuard');
    const scopeGuardIndex = authModuleSource.indexOf('useClass: IngestKeyScopeGuard');
    expect(combinedIndex).toBeGreaterThan(-1);
    expect(scopeGuardIndex).toBeGreaterThan(combinedIndex);
  });

  it('and AFTER PublishableKeyReadGuard — a publishable key whose blob floored to ingest must get the "use your secret key" message, not a misleading role one', () => {
    const readGuardIndex = authModuleSource.indexOf('useClass: PublishableKeyReadGuard');
    const scopeGuardIndex = authModuleSource.indexOf('useClass: IngestKeyScopeGuard');
    expect(readGuardIndex).toBeGreaterThan(-1);
    expect(scopeGuardIndex).toBeGreaterThan(readGuardIndex);
  });

  it('app.module.ts does NOT register it — a root-module registration is the fail-open no-op App B proves', () => {
    expect(appModuleSource).not.toMatch(/useClass:\s*IngestKeyScopeGuard/);
  });
});
