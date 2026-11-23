/**
 * INGEST CAPS — HTTP-level enforcement over both usage-record doors.
 *
 * Boots a real Nest HTTP app wired the way main.ts wires production for the
 * pieces under test: the SAME global ValidationPipe options, the SAME
 * ingestBodyParsers() / INGEST_PATHS body cap (imported, not re-declared), and
 * the REAL controllers whose @UsePipes(ingestValidationPipe) decorators carry
 * the strict unknown-field policy. Every case runs against BOTH doors —
 * canonical POST /v1/usage/record and alias POST /v1/sdk/usage/record —
 * so the doors cannot drift apart.
 *
 * Also proves the scope: strictness is method-scoped to the ingest doors, so a
 * non-ingest route on the same controller still tolerates unknown fields.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SdkController } from './sdk.controller';
import { SdkPublicAliasesController } from './sdk-public-aliases.controller';
import { SdkService } from './sdk.service';
import { InvoicesService } from '../invoices/invoices.service';
import { CombinedAuthGuard } from '../auth/guards/combined-auth.guard';
import { OrgRoleGuard } from '../../common/guards/org-role.guard';
import {
  INGEST_STRING_MAX_LENGTH,
  MODEL_PROVIDER_MAX_LENGTH,
  METADATA_MAX_BYTES,
  METADATA_MAX_DEPTH,
  SERVICES_MAX_SIZE,
  NUMERIC_FIELD_MAX,
} from './dto/record-usage.dto';
import {
  ingestBodyParsers,
  INGEST_PATHS,
  INGEST_BODY_MAX_DEPTH,
} from '../../common/utils/ingest-body-limit';

const DOORS = [
  ['canonical', '/v1/usage/record'],
  ['alias', '/v1/sdk/usage/record'],
] as const;

const serviceResult = { processed: 1, successful: 1, failed: 0, results: {} };
const recordUsage = jest.fn().mockResolvedValue(serviceResult);
const generateInvoice = jest.fn().mockResolvedValue({ id: 'inv-1' });

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [SdkController, SdkPublicAliasesController],
    providers: [
      { provide: SdkService, useValue: { recordUsage } },
      { provide: InvoicesService, useValue: { generateInvoice } },
    ],
  })
    .overrideGuard(CombinedAuthGuard)
    .useValue({
      canActivate(context: any) {
        context.switchToHttp().getRequest().user = { organizationId: 'org-1' };
        return true;
      },
    })
    .overrideGuard(OrgRoleGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  app.use(INGEST_PATHS, ...ingestBodyParsers());
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
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
});

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function singleServiceRecord(overrides: Record<string, unknown> = {}) {
  return {
    customerExternalId: 'cust-1',
    agentCode: 'agent-1',
    signalName: 'signal-1',
    model: 'claude-sonnet-4-6',
    modelProvider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

/** metadata that serializes to exactly `bytes` bytes: {"pad":"xx…x"} */
function metadataOfSerializedBytes(bytes: number) {
  return { pad: 'x'.repeat(bytes - '{"pad":""}'.length) };
}

/** objects nested exactly `depth` container-levels deep (root counts as 1) */
function metadataOfDepth(depth: number) {
  let value: Record<string, unknown> = {};
  for (let i = 1; i < depth; i++) {
    value = { nest: value };
  }
  return value;
}

describe.each(DOORS)('POST usage-record via %s door', (_label, path) => {
  describe('at-cap requests pass (real payloads must never be clipped)', () => {
    it('accepts every string field at its exact cap', async () => {
      const { status } = await post(path, {
        records: [
          singleServiceRecord({
            customerExternalId: 'c'.repeat(INGEST_STRING_MAX_LENGTH),
            agentCode: 'a'.repeat(INGEST_STRING_MAX_LENGTH),
            signalName: 's'.repeat(INGEST_STRING_MAX_LENGTH),
            model: 'm'.repeat(INGEST_STRING_MAX_LENGTH),
            modelProvider: 'p'.repeat(MODEL_PROVIDER_MAX_LENGTH),
          }),
        ],
      });
      expect(status).toBe(200);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    it('accepts nested service entries at their exact caps, 100 of them', async () => {
      const entry = {
        model: 'm'.repeat(INGEST_STRING_MAX_LENGTH),
        modelProvider: 'p'.repeat(MODEL_PROVIDER_MAX_LENGTH),
        inputTokens: 1,
        outputTokens: 1,
      };
      const { status } = await post(path, {
        records: [
          singleServiceRecord({
            model: undefined,
            modelProvider: undefined,
            inputTokens: undefined,
            outputTokens: undefined,
            services: Array.from({ length: SERVICES_MAX_SIZE }, () => ({ ...entry })),
          }),
        ],
      });
      expect(status).toBe(200);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    it('accepts metadata at exactly the serialized-byte cap and at the depth cap', async () => {
      const { status } = await post(path, {
        records: [
          singleServiceRecord({ metadata: metadataOfSerializedBytes(METADATA_MAX_BYTES) }),
          singleServiceRecord({ metadata: metadataOfDepth(METADATA_MAX_DEPTH) }),
        ],
      });
      expect(status).toBe(200);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe('over-cap requests answer 400 naming the field and the limit', () => {
    it.each([
      ['customerExternalId', 'customerExternalId', 'Z'.repeat(INGEST_STRING_MAX_LENGTH + 1), '255'],
      ['agentCode', 'agentCode', 'Z'.repeat(INGEST_STRING_MAX_LENGTH + 1), '255'],
      ['signalName', 'signalName', 'Z'.repeat(INGEST_STRING_MAX_LENGTH + 1), '255'],
      ['model', 'model', 'Z'.repeat(INGEST_STRING_MAX_LENGTH + 1), '255'],
      ['modelProvider', 'modelProvider', 'Z'.repeat(MODEL_PROVIDER_MAX_LENGTH + 1), '100'],
      ['idempotencyKey', 'idempotencyKey', 'Z'.repeat(INGEST_STRING_MAX_LENGTH + 1), '255'],
    ])('%s over cap → 400', async (_field, key, oversized, limit) => {
      const { status, text } = await post(path, {
        records: [singleServiceRecord({ [key]: oversized })],
      });
      expect(status).toBe(400);
      expect(text).toContain(key);
      expect(text).toContain(limit);
      // The rejected value must never be echoed back or logged.
      expect(text).not.toContain(oversized);
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it.each([
      ['model', 'Z'.repeat(INGEST_STRING_MAX_LENGTH + 1), '255'],
      ['modelProvider', 'Z'.repeat(MODEL_PROVIDER_MAX_LENGTH + 1), '100'],
    ])('nested services[].%s over cap → 400', async (key, oversized, limit) => {
      const { status, text } = await post(path, {
        records: [
          singleServiceRecord({
            model: undefined,
            modelProvider: undefined,
            inputTokens: undefined,
            outputTokens: undefined,
            services: [{ model: 'gpt-4o', modelProvider: 'openai', [key]: oversized }],
          }),
        ],
      });
      expect(status).toBe(400);
      expect(text).toContain(key);
      expect(text).toContain(limit);
      expect(text).not.toContain(oversized);
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it.each([
      ['inputTokens', 'inputTokens'],
      ['outputTokens', 'outputTokens'],
      ['quantity', 'quantity'],
    ])('numeric %s past the cap → 400 naming the field and the limit', async (_field, key) => {
      const { status, text } = await post(path, {
        records: [singleServiceRecord({ [key]: NUMERIC_FIELD_MAX + 1 })],
      });
      expect(status).toBe(400);
      expect(text).toContain(key);
      expect(text).toContain(String(NUMERIC_FIELD_MAX));
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('accepts a numeric field sitting exactly on the cap', async () => {
      const { status } = await post(path, {
        records: [singleServiceRecord({ inputTokens: NUMERIC_FIELD_MAX })],
      });
      expect(status).toBe(200);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    it('metadata over the serialized-byte cap → 400 naming metadata and the byte limit', async () => {
      const { status, text } = await post(path, {
        records: [
          singleServiceRecord({ metadata: metadataOfSerializedBytes(METADATA_MAX_BYTES + 1) }),
        ],
      });
      expect(status).toBe(400);
      expect(text).toContain('metadata');
      expect(text).toContain(String(METADATA_MAX_BYTES));
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('metadata nested past the depth cap → 400 naming metadata and the depth limit', async () => {
      const { status, text } = await post(path, {
        records: [singleServiceRecord({ metadata: metadataOfDepth(METADATA_MAX_DEPTH + 1) })],
      });
      expect(status).toBe(400);
      expect(text).toContain('metadata');
      expect(text).toContain(`${METADATA_MAX_DEPTH}`);
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('101 service entries → 400 naming services and the limit', async () => {
      const entry = { model: 'gpt-4o', modelProvider: 'openai', inputTokens: 1, outputTokens: 1 };
      const { status, text } = await post(path, {
        records: [
          singleServiceRecord({
            model: undefined,
            modelProvider: undefined,
            inputTokens: undefined,
            outputTokens: undefined,
            services: Array.from({ length: SERVICES_MAX_SIZE + 1 }, () => ({ ...entry })),
          }),
        ],
      });
      expect(status).toBe(400);
      expect(text).toContain('services');
      expect(text).toContain(String(SERVICES_MAX_SIZE));
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('101 records → 400 (batch cap regression pin)', async () => {
      const { status } = await post(path, {
        records: Array.from({ length: 101 }, () => singleServiceRecord()),
      });
      expect(status).toBe(400);
      expect(recordUsage).not.toHaveBeenCalled();
    });
  });

  describe('unknown-field policy: strict on the ingest doors', () => {
    it.each([
      ['top level', { records: [singleServiceRecord()], junkField: true }],
      ['record level', { records: [singleServiceRecord({ junkField: true })] }],
      [
        'service-entry level',
        {
          records: [
            singleServiceRecord({
              model: undefined,
              modelProvider: undefined,
              inputTokens: undefined,
              outputTokens: undefined,
              services: [{ model: 'gpt-4o', modelProvider: 'openai', junkField: true }],
            }),
          ],
        },
      ],
    ])('unknown field at %s → 400 naming the property', async (_where, body) => {
      const { status, text } = await post(path, body);
      expect(status).toBe(400);
      expect(text).toContain('junkField');
      expect(recordUsage).not.toHaveBeenCalled();
    });
  });

  describe('explicit body cap answers 413', () => {
    it('a body past the ingest limit → 413 with a plain-English message', async () => {
      const { status, text } = await post(path, {
        records: [singleServiceRecord({ metadata: { pad: 'x'.repeat(2 * 1024 * 1024 + 1024) } })],
      });
      expect(status).toBe(413);
      expect(text).toContain('2mb');
      expect(text).toContain('usage-ingest limit');
      expect(recordUsage).not.toHaveBeenCalled();
    });
  });

  describe('malformed JSON answers the standard error envelope', () => {
    // Without an explicit entity.parse.failed branch, the parse error rides
    // Nest's SyntaxError mapping (routes-resolver mapExternalException), whose
    // message is V8's raw JSON.parse error — and on modern Node that message
    // echoes a window of the payload back to the caller.
    it('a syntactically broken body → 400 Nest envelope that never echoes the payload', async () => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"records": [{"customerExternalId": LEAKME1}]}',
      });
      expect(response.status).toBe(400);
      const body = JSON.parse(await response.text());
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(typeof body.message).toBe('string');
      expect(body.message).toContain('not valid JSON');
      expect(body.message).not.toContain('LEAKME1');
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('a truncated body → 400 Nest envelope', async () => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"records": [ {"customerExternalId": "c",',
      });
      expect(response.status).toBe(400);
      const body = JSON.parse(await response.text());
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(body.message).toContain('not valid JSON');
      expect(recordUsage).not.toHaveBeenCalled();
    });
  });

  describe('envelope nesting guard answers 400, never 500', () => {
    it('a 10,000-level-deep body → 400 naming the envelope depth limit', async () => {
      // Built as a raw string: JSON.stringify would itself blow the stack on a
      // structure this deep, while JSON.parse handles it fine — which is exactly
      // the gap the envelope guard closes before class-transformer recurses.
      const depth = 10_000;
      const rawBody =
        `{"records":[{"customerExternalId":"c","agentCode":"a","signalName":"s",` +
        `"model":"m","modelProvider":"p","metadata":{"bomb":` +
        '['.repeat(depth) +
        '1' +
        ']'.repeat(depth) +
        `}}]}`;
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      });
      const text = await response.text();
      expect(response.status).toBe(400);
      expect(text).toContain(String(INGEST_BODY_MAX_DEPTH));
      expect(recordUsage).not.toHaveBeenCalled();
    });
  });
});

describe('scope proof: non-ingest routes keep tolerating unknown fields', () => {
  it('POST /v1/sdk/invoices/generate with an unknown field still passes validation', async () => {
    const { status, text } = await post('/v1/sdk/invoices/generate', {
      customerId: '3f0e5a5e-5c1e-4a5e-9d3e-1a2b3c4d5e6f',
      subscriptionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      junkField: true,
    });
    expect(status).toBe(201);
    expect(text).not.toContain('junkField');
    expect(generateInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('capped parser name stays distinct from express jsonParser', () => {
  // Nest's ExpressAdapter skips its app-wide json parser if ANY stack layer is
  // named "jsonParser" — even a path-scoped one. Direct pin; the scope test
  // above only catches this as a side effect of its required-UUID DTO.
  it('no ingest body parser presents the name Nest checks for', () => {
    for (const handler of ingestBodyParsers()) {
      expect(handler.name).not.toBe('jsonParser');
    }
  });
});
