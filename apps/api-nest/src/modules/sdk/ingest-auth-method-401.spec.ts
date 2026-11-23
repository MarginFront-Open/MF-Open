/**
 * A login token on the usage-ingest doors gets a clean, actionable
 * 401 instead of a bare-Error 500.
 *
 * Boots a real Nest HTTP app the way ingest-caps.http.spec.ts does (same global
 * ValidationPipe options, same ingestBodyParsers() body cap, the REAL
 * controllers and their @UsePipes(ingestValidationPipe)) and runs every case
 * against BOTH doors — canonical POST /v1/usage/record and alias POST
 * /v1/sdk/usage/record — so the two can never drift apart.
 *
 * CombinedAuthGuard is overridden so each case can stamp an arbitrary validated
 * principal onto the request. The guard's own behaviour (a real JWT really does
 * come back with no organizationId, and this path never touches the failed-auth
 * throttle) is pinned separately in
 * modules/auth/guards/combined-auth.guard.jwt-org-less.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SdkController } from './sdk.controller';
import { SdkPublicAliasesController } from './sdk-public-aliases.controller';
import { SdkService } from './sdk.service';
import { InvoicesService } from '../invoices/invoices.service';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import { ingestBodyParsers, INGEST_PATHS } from '../../common/utils/ingest-body-limit';

const DOORS = [
  ['canonical', '/v1/usage/record'],
  ['legacy alias', '/v1/sdk/usage/record'],
] as const;

const serviceResult = { processed: 1, successful: 1, failed: 0, results: {} };
const recordUsage = jest.fn().mockResolvedValue(serviceResult);

// Whatever the overridden guard stamps onto request.user for the next request.
let principal: Record<string, unknown> | undefined;

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [SdkController, SdkPublicAliasesController],
    providers: [
      { provide: SdkService, useValue: { recordUsage } },
      { provide: InvoicesService, useValue: {} },
    ],
  })
    .overrideGuard(CombinedAuthGuard)
    .useValue({
      canActivate(context: any) {
        context.switchToHttp().getRequest().user = principal;
        return true;
      },
    })
    .overrideGuard(OrgRoleGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  // Load-bearing: without the ingest body parsers req.body is undefined on these
  // doors, and the 400-before-401 ordering case below would measure nothing.
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
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  principal = undefined;
});

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function validIngestBody(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
      },
    ],
  };
}

describe.each(DOORS)('%s ingest door (%s)', (_label, path) => {
  it('a login token (JWT, no organizationId) gets a 401 that names the fix, never a 500', async () => {
    principal = { id: 'user-1', email: 'a@acme.example', authMethod: 'jwt', userId: 'user-1' };

    const { status, body } = await post(path, validIngestBody());

    // A bare Error would render a 500.
    expect(status).not.toBe(500);
    expect(status).toBe(401);
    expect(body).toMatchObject({ statusCode: 401, code: 'use_api_key' });
    expect(body.message).toContain('x-api-key');
    expect(body.message).toContain('mf_sk_');
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('a session cookie WITH an active org still records usage exactly as before', async () => {
    principal = {
      id: 'user-1',
      email: 'a@acme.example',
      authMethod: 'session',
      organizationId: 'org-1',
    };

    const { status } = await post(path, validIngestBody());

    expect(status).toBe(200);
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][0]).toBe('org-1');
  });

  it('an API key still records usage exactly as before', async () => {
    principal = { id: 'key-1', authMethod: 'api-key', keyType: 'secret', organizationId: 'org-1' };

    const { status } = await post(path, validIngestBody());

    expect(status).toBe(200);
    expect(recordUsage.mock.calls[0][0]).toBe('org-1');
  });

  it('a session with NO active org gets the same 401, not a 500', async () => {
    // Better Auth's activeOrganizationId can be null for a signed-in human who
    // has not selected an org, so the check covers any org-less principal, not
    // only JWTs.
    principal = {
      id: 'user-1',
      email: 'a@acme.example',
      authMethod: 'session',
      organizationId: undefined,
    };

    const { status, body } = await post(path, validIngestBody());

    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'use_api_key' });
  });

  it('a malformed body from a login token answers 400, not the new 401', async () => {
    // Deliberate ordering: @UsePipes(ingestValidationPipe) runs BEFORE the
    // handler, so the body complaint wins. Do NOT "fix" this by promoting the
    // org check into a guard. The @IngestRoute machinery exists so that
    // no guard can ever block the ingest path.
    principal = { id: 'user-1', email: 'a@acme.example', authMethod: 'jwt', userId: 'user-1' };

    const { status } = await post(path, { records: [{ agentCode: 'agent-1' }] });

    expect(status).toBe(400);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
