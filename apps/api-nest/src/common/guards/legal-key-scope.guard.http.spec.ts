/**
 * Registration-order proof over a real Nest app for LegalKeyScopeGuard, a
 * structural twin of ingest-key-scope.guard.http.spec.ts.
 *
 * The unit spec proves canActivate; THIS file proves the wiring, because the wiring is
 * where a fail-open mistake would live. Root-module APP_GUARDs run BEFORE imported modules'
 * (Nest scans the root first), so LegalKeyScopeGuard registered in app.module.ts would
 * run before the auth guard, see request.user undefined, return true for every request,
 * and ship green having gated nothing.
 *
 * Two apps:
 *   A — the real topology (guard in the imported auth module, after the stub auth
 *       guard). Proves deny-by-default on an unmarked route, every allow path (the real
 *       @OrgRoles('legal') surface, the read-floor carve-out that must NOT apply, and
 *       the shared ingest doors), and that other roles/auth methods pass untouched.
 *   B — the guard in the ROOT module: documents the fail-open no-op this guard's
 *       "REGISTRATION IS LOAD-BEARING" header comment depends on.
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
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { LegalKeyScopeGuard } from './legal-key-scope.guard';
import { IngestKeyAllowed } from './ingest-key-scope.guard';
import { OrgRoles, IngestRoute } from './org-role.guard';
import { Public } from '../../modules/auth/decorators/public.decorator';

/**
 * Stands in for CombinedAuthGuard: populates request.user from test headers, at the same
 * position in the guard chain (first provider of the imported auth module). Only the
 * fields LegalKeyScopeGuard reads are set.
 */
@Injectable()
class HeaderAuthStubGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authMethod = request.headers['x-test-auth-method'];
    if (authMethod === 'api-key') {
      request.user = {
        authMethod: 'api-key',
        keyType: 'secret',
        organizationId: 'org-http-probe',
        apiKeyId: 'key_http_probe',
        role: request.headers['x-test-role'] ?? 'member',
      };
    } else if (authMethod === 'session') {
      request.user = {
        authMethod: 'session',
        organizationId: 'org-http-probe',
        userId: 'user_http_probe',
      };
    }
    return true;
  }
}

@Controller('legal-probe')
class LegalProbeController {
  // No decorator on purpose: this probe IS the default posture — denied to a legal key.
  @Get('unmarked')
  unmarked() {
    return { ok: true };
  }

  // The real Law surface shape: @OrgRoles(...) whose list includes 'legal'.
  @Get('legal-route')
  @OrgRoles('owner', 'admin', 'finance', 'legal')
  legalRoute() {
    return { ok: true };
  }

  // The any-member read floor. A legal key must NOT inherit it — empty @OrgRoles()
  // deliberately does not clear this guard.
  @Get('read-floor')
  @OrgRoles()
  readFloor() {
    return { ok: true };
  }

  @Get('ingest-allowed')
  @IngestKeyAllowed()
  ingestAllowed() {
    return { ok: true };
  }

  @Post('ingest-route')
  @IngestRoute()
  ingestRoute() {
    return { ok: true };
  }

  @Get('public')
  @Public()
  publicProbe() {
    return { ok: true };
  }
}

function authStubModule(guards: Provider[]) {
  const providers: Provider[] = [{ provide: APP_GUARD, useClass: HeaderAuthStubGuard }, ...guards];

  @Module({ providers })
  class AuthStubModule {}

  return AuthStubModule;
}

async function bootApp(
  topology: 'imported-module-after-auth' | 'root-module',
): Promise<INestApplication> {
  const importedGuards: Provider[] = [];
  const rootProviders: Provider[] = [];
  if (topology === 'imported-module-after-auth') {
    importedGuards.push({ provide: APP_GUARD, useClass: LegalKeyScopeGuard });
  }
  if (topology === 'root-module') {
    rootProviders.push({ provide: APP_GUARD, useClass: LegalKeyScopeGuard });
  }

  const builder = Test.createTestingModule({
    imports: [authStubModule(importedGuards)],
    controllers: [LegalProbeController],
    providers: [...rootProviders],
  });

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

const LEGAL_KEY = { 'x-test-auth-method': 'api-key', 'x-test-role': 'legal' };
const FINANCE_KEY = { 'x-test-auth-method': 'api-key', 'x-test-role': 'finance' };
const SESSION_AUTH = { 'x-test-auth-method': 'session' };

describe('App A — guard registered as in auth.module.ts: imported module, after the auth guard', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp('imported-module-after-auth');
  });
  afterAll(async () => {
    await app.close();
  });

  it('a legal key on an UNMARKED route gets the 403 with the actionable code — deny by default', async () => {
    const { status, body } = await request(app, 'GET', 'legal-probe/unmarked', LEGAL_KEY);
    expect(status).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
    expect(body.required_roles).toEqual([]);
    expect(body.key_role).toBe('legal');
  });

  it("a legal key reads the real @OrgRoles(...,'legal') surface", async () => {
    const { status } = await request(app, 'GET', 'legal-probe/legal-route', LEGAL_KEY);
    expect(status).toBe(200);
  });

  it('an EMPTY @OrgRoles() read floor does NOT clear a legal key — the generic read floor must not leak', async () => {
    const { status, body } = await request(app, 'GET', 'legal-probe/read-floor', LEGAL_KEY);
    expect(status).toBe(403);
    expect(body.code).toBe('insufficient_key_role');
  });

  it('a legal key still reads an @IngestKeyAllowed door', async () => {
    const { status } = await request(app, 'GET', 'legal-probe/ingest-allowed', LEGAL_KEY);
    expect(status).toBe(200);
  });

  it('a legal key still POSTs to an @IngestRoute usage record (201 is the Nest default for POST)', async () => {
    const { status } = await request(app, 'POST', 'legal-probe/ingest-route', LEGAL_KEY);
    expect(status).toBe(201);
  });

  it('a legal key still reads a @Public route', async () => {
    const { status } = await request(app, 'GET', 'legal-probe/public', LEGAL_KEY);
    expect(status).toBe(200);
  });

  it('a finance-role key is untouched by this guard on the same unmarked route', async () => {
    const { status } = await request(app, 'GET', 'legal-probe/unmarked', FINANCE_KEY);
    expect(status).toBe(200);
  });

  it("a session-auth request (authMethod !== 'api-key') is not this guard's business", async () => {
    const { status } = await request(app, 'GET', 'legal-probe/unmarked', SESSION_AUTH);
    expect(status).toBe(200);
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

  it('root-module APP_GUARDs run before the imported auth guard, so request.user is unset and the legal key sails through — the same key that gets a 403 under App A gets a 200 here', async () => {
    const { status } = await request(app, 'GET', 'legal-probe/unmarked', LEGAL_KEY);
    expect(status).toBe(200);
  });

  it('the same request denies under App A — the two apps differ ONLY in where the guard is registered, which is what makes this a wiring proof and not a behavior one', async () => {
    const appA = await bootApp('imported-module-after-auth');
    try {
      const { status } = await request(appA, 'GET', 'legal-probe/unmarked', LEGAL_KEY);
      expect(status).toBe(403);
    } finally {
      await appA.close();
    }
  });
});

// App B proves what the WRONG wiring does; this pins that production carries the RIGHT
// one. Same shape as the ingest twin's production-wiring describe.
describe('production wiring', () => {
  const authModuleSource = fs.readFileSync(
    path.join(__dirname, '../../modules/auth/auth.module.ts'),
    'utf8',
  );
  const appModuleSource = fs.readFileSync(path.join(__dirname, '../../app.module.ts'), 'utf8');

  it('auth.module.ts registers LegalKeyScopeGuard as an APP_GUARD', () => {
    expect(authModuleSource).toMatch(/provide:\s*APP_GUARD,\s*useClass:\s*LegalKeyScopeGuard/);
  });

  it('the registration sits AFTER CombinedAuthGuard in the providers array (order is execution order within one module) — before it, request.user is undefined and the guard is a no-op', () => {
    const combinedIndex = authModuleSource.indexOf('useClass: CombinedAuthGuard');
    const legalGuardIndex = authModuleSource.indexOf('useClass: LegalKeyScopeGuard');
    expect(combinedIndex).toBeGreaterThan(-1);
    expect(legalGuardIndex).toBeGreaterThan(combinedIndex);
  });

  it('and AFTER IngestKeyScopeGuard — LAST in the chain, so the publishable/ingest guards answer first with the error naming the right fix', () => {
    const ingestGuardIndex = authModuleSource.indexOf('useClass: IngestKeyScopeGuard');
    const legalGuardIndex = authModuleSource.indexOf('useClass: LegalKeyScopeGuard');
    expect(ingestGuardIndex).toBeGreaterThan(-1);
    expect(legalGuardIndex).toBeGreaterThan(ingestGuardIndex);
  });

  it('app.module.ts does NOT register it — a root-module registration is the fail-open no-op App B proves', () => {
    expect(appModuleSource).not.toMatch(/useClass:\s*LegalKeyScopeGuard/);
  });
});
