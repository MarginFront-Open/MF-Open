/**
 * Validation tests for UsageRecordDto and ServiceEntryDto.
 *
 * Mirrors the SDK validator tests in
 * packages/sdk/src/__tests__/validation.test.ts so the backend
 * gatekeeper produces parallel accept/reject decisions to the SDK
 * gatekeeper. Same single- and multi-service shape cases, same
 * single-service coverage, same multi-service guards.
 *
 * Mechanism: plainToInstance materializes a UsageRecordDto from a raw
 * payload; class-validator's `validate()` runs every decorator,
 * including the class-level IsExactlyOneShape rule, and returns the
 * accumulated errors.
 */

import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  UsageRecordDto,
  ServiceEntryDto,
  RecordUsageDto,
  INGEST_STRING_MAX_LENGTH,
  MODEL_PROVIDER_MAX_LENGTH,
  METADATA_MAX_BYTES,
  METADATA_MAX_DEPTH,
  SERVICES_MAX_SIZE,
  NUMERIC_FIELD_MAX,
} from './record-usage.dto';

// ─── Helpers ──────────────────────────────────────────────────────────

async function validateRecord(payload: unknown): Promise<ValidationError[]> {
  const instance = plainToInstance(UsageRecordDto, payload as object);
  return await validate(instance);
}

async function validateEntry(payload: unknown): Promise<ValidationError[]> {
  const instance = plainToInstance(ServiceEntryDto, payload as object);
  return await validate(instance);
}

/**
 * Walk the error tree and collect every constraint message at any depth.
 * class-validator nests errors under children[]; the SDK's validator
 * emits flat strings. This helper bridges the two for assertion convenience.
 */
function collectMessages(errors: ValidationError[]): string[] {
  const out: string[] = [];
  const walk = (errs: ValidationError[]) => {
    for (const err of errs) {
      if (err.constraints) {
        out.push(...Object.values(err.constraints));
      }
      if (err.children?.length) {
        walk(err.children);
      }
    }
  };
  walk(errors);
  return out;
}

const validSingleService = {
  customerExternalId: 'cust-123',
  agentCode: 'sourcing-bot',
  signalName: 'sourcing-report',
  model: 'claude-sonnet-4-6',
  modelProvider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 500,
};

const claudeService = {
  model: 'claude-sonnet-4-6',
  modelProvider: 'anthropic',
  inputTokens: 1000,
  outputTokens: 500,
};

const googlePlacesService = {
  model: 'google-maps-places',
  modelProvider: 'google',
  quantity: 3,
};

const validMultiService = {
  customerExternalId: 'cust-123',
  agentCode: 'sourcing-bot',
  signalName: 'sourcing-report',
  services: [claudeService, googlePlacesService],
};

// ─── Single-service records are valid ──────────────

describe('UsageRecordDto: single-service records', () => {
  it('accepts the canonical valid single-service LLM payload', async () => {
    expect(await validateRecord(validSingleService)).toEqual([]);
  });

  it('accepts a single-service non-LLM payload (model + provider + quantity)', async () => {
    const payload = {
      customerExternalId: 'cust-123',
      agentCode: 'agent-abc',
      signalName: 'api_call',
      model: 'twilio-sms',
      modelProvider: 'twilio',
      quantity: 1,
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it('accepts single-service with optional usageDate + metadata', async () => {
    const payload = {
      ...validSingleService,
      usageDate: '2026-04-26T12:00:00Z',
      metadata: { reportId: 'rep_42' },
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it('rejects single-service missing customerExternalId', async () => {
    const { customerExternalId: _drop, ...rest } = validSingleService;
    const messages = collectMessages(await validateRecord(rest));
    expect(messages.some((m) => /customerexternalid/i.test(m))).toBe(true);
  });

  it('rejects single-service missing agentCode', async () => {
    const { agentCode: _drop, ...rest } = validSingleService;
    const messages = collectMessages(await validateRecord(rest));
    expect(messages.some((m) => /agentcode/i.test(m))).toBe(true);
  });

  it('rejects single-service missing signalName', async () => {
    const { signalName: _drop, ...rest } = validSingleService;
    const messages = collectMessages(await validateRecord(rest));
    expect(messages.some((m) => /signalname/i.test(m))).toBe(true);
  });

  it('rejects single-service with negative inputTokens', async () => {
    const messages = collectMessages(
      await validateRecord({ ...validSingleService, inputTokens: -1 }),
    );
    expect(messages.some((m) => /inputtokens/i.test(m))).toBe(true);
  });

  it('rejects single-service with negative outputTokens', async () => {
    const messages = collectMessages(
      await validateRecord({ ...validSingleService, outputTokens: -10 }),
    );
    expect(messages.some((m) => /outputtokens/i.test(m))).toBe(true);
  });
});

// ─── Shape cases (no model lookup) ───────────────────

describe('UsageRecordDto — shape cases', () => {
  it('single-service with all valid fields passes', async () => {
    expect(await validateRecord(validSingleService)).toEqual([]);
  });

  it('single-service with unknown model passes (validator only checks shape)', async () => {
    const payload = {
      ...validSingleService,
      model: 'some-unknown-model-not-in-catalog',
      modelProvider: 'custom',
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it('single-service with missing volume passes (validator only checks shape)', async () => {
    const payload = {
      customerExternalId: 'cust-123',
      agentCode: 'agent-abc',
      signalName: 'api_call',
      model: 'claude-sonnet-4-6',
      modelProvider: 'anthropic',
      // no inputTokens, outputTokens, or quantity — the server flags
      // MISSING_VOLUME_DATA after model lookup; the gatekeeper just
      // checks shape.
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it('multi-service with all known + volume passes', async () => {
    expect(await validateRecord(validMultiService)).toEqual([]);
  });

  it('multi-service with one unknown model passes', async () => {
    const payload = {
      ...validMultiService,
      services: [
        claudeService,
        { model: 'some-unknown-model', modelProvider: 'custom', quantity: 1 },
      ],
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it('multi-service with one entry missing volume passes', async () => {
    const payload = {
      ...validMultiService,
      services: [
        claudeService,
        { model: 'google-maps-places', modelProvider: 'google' }, // no quantity
      ],
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it('multi-service with one unknown + one missing volume passes', async () => {
    const payload = {
      ...validMultiService,
      services: [
        { model: 'unknown-thing', modelProvider: 'custom' },
        {
          model: 'claude-sonnet-4-6',
          modelProvider: 'anthropic',
          inputTokens: 100,
          outputTokens: 50,
        },
      ],
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it('multi-service with same (model, provider) listed twice passes', async () => {
    const payload = {
      ...validMultiService,
      services: [
        { ...claudeService, inputTokens: 1000, outputTokens: 500 },
        { ...claudeService, inputTokens: 2000, outputTokens: 800 },
      ],
    };
    expect(await validateRecord(payload)).toEqual([]);
  });
});

// ─── Shape guards: the either-or rule + array-shape errors ────────────

describe('UsageRecordDto — shape guards', () => {
  it('rejects record missing both single-service fields and services[]', async () => {
    const payload = {
      customerExternalId: 'cust-123',
      agentCode: 'agent-abc',
      signalName: 'api_call',
    };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /provide either model \+ modelprovider/i.test(m))).toBe(true);
  });

  it('rejects record providing both model+modelProvider AND services[]', async () => {
    const payload = {
      ...validSingleService,
      services: [claudeService],
    };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /cannot mix shapes/i.test(m))).toBe(true);
  });

  it('rejects multi-service with empty services[]', async () => {
    const payload = {
      customerExternalId: 'cust-123',
      agentCode: 'agent-abc',
      signalName: 'api_call',
      services: [],
    };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /services\[\] is empty/i.test(m))).toBe(true);
  });

  it('rejects multi-service where services is not an array', async () => {
    const payload = {
      customerExternalId: 'cust-123',
      agentCode: 'agent-abc',
      signalName: 'api_call',
      services: 'not an array',
    };
    const errors = await validateRecord(payload);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects multi-service entry missing model', async () => {
    const payload = {
      ...validMultiService,
      services: [{ modelProvider: 'anthropic', inputTokens: 100 }],
    };
    const errors = await validateRecord(payload);
    expect(errors.length).toBeGreaterThan(0);
    const messages = collectMessages(errors);
    expect(messages.some((m) => /model/i.test(m))).toBe(true);
  });

  it('rejects multi-service entry missing modelProvider', async () => {
    const payload = {
      ...validMultiService,
      services: [{ model: 'claude-sonnet-4-6', inputTokens: 100 }],
    };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /modelprovider/i.test(m))).toBe(true);
  });

  it('rejects multi-service entry with negative inputTokens', async () => {
    const payload = {
      ...validMultiService,
      services: [{ ...claudeService, inputTokens: -1 }],
    };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /inputtokens/i.test(m))).toBe(true);
  });

  it('rejects multi-service entry with negative outputTokens', async () => {
    const payload = {
      ...validMultiService,
      services: [{ ...claudeService, outputTokens: -10 }],
    };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /outputtokens/i.test(m))).toBe(true);
  });

  it('rejects multi-service entry with negative quantity at index 1 (path-aware)', async () => {
    const payload = {
      ...validMultiService,
      services: [claudeService, { ...googlePlacesService, quantity: -3 }],
    };
    const errors = await validateRecord(payload);
    // Drill into the nested error tree to confirm the bad entry is at index 1
    const servicesErr = errors.find((e) => e.property === 'services');
    expect(servicesErr).toBeDefined();
    const indexedChild = servicesErr?.children?.find((c) => c.property === '1');
    expect(indexedChild).toBeDefined();
    const fieldErr = indexedChild?.children?.find((c) => c.property === 'quantity');
    expect(fieldErr).toBeDefined();
  });

  it('rejects when only model is provided (modelProvider missing)', async () => {
    const payload = {
      customerExternalId: 'cust-123',
      agentCode: 'agent-abc',
      signalName: 'api_call',
      model: 'claude-sonnet-4-6',
      // modelProvider missing — single-service shape incomplete
    };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /modelprovider/i.test(m))).toBe(true);
  });
});

// ─── Common-field guards ──────────────────────────────────────────────

describe('UsageRecordDto — common-field guards', () => {
  it('rejects empty payload (multiple errors)', async () => {
    const errors = await validateRecord({});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid usageDate string', async () => {
    const payload = { ...validSingleService, usageDate: 'not-a-date' };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /usagedate/i.test(m))).toBe(true);
  });

  it('rejects metadata that is not an object', async () => {
    const payload = { ...validSingleService, metadata: 'string' as unknown };
    const messages = collectMessages(await validateRecord(payload));
    expect(messages.some((m) => /metadata/i.test(m))).toBe(true);
  });

  it('accepts metadata as an arbitrary object', async () => {
    const payload = {
      ...validSingleService,
      metadata: { reportId: 'rep_42', nested: { ok: true } },
    };
    expect(await validateRecord(payload)).toEqual([]);
  });
});

// ─── ServiceEntryDto unit tests ───────────────────────────────────────

describe('ServiceEntryDto', () => {
  it('accepts a valid LLM entry', async () => {
    expect(await validateEntry(claudeService)).toEqual([]);
  });

  it('accepts a valid non-LLM entry', async () => {
    expect(await validateEntry(googlePlacesService)).toEqual([]);
  });

  it('rejects entry missing model', async () => {
    const errors = await validateEntry({
      modelProvider: 'anthropic',
      inputTokens: 100,
    });
    expect(errors.some((e) => e.property === 'model')).toBe(true);
  });

  it('rejects entry missing modelProvider', async () => {
    const errors = await validateEntry({
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
    });
    expect(errors.some((e) => e.property === 'modelProvider')).toBe(true);
  });

  it('rejects entry with negative inputTokens', async () => {
    const errors = await validateEntry({ ...claudeService, inputTokens: -1 });
    expect(errors.some((e) => e.property === 'inputTokens')).toBe(true);
  });

  it('rejects entry with negative outputTokens', async () => {
    const errors = await validateEntry({ ...claudeService, outputTokens: -10 });
    expect(errors.some((e) => e.property === 'outputTokens')).toBe(true);
  });

  it('rejects entry with negative quantity', async () => {
    const errors = await validateEntry({ ...googlePlacesService, quantity: -3 });
    expect(errors.some((e) => e.property === 'quantity')).toBe(true);
  });
});

// ─── Fractional quantity ───────────────────────────────────
//
// quantity is @IsNumber() + @Min(0) so non-LLM services billed in
// fractional units (e.g. 0.5 GB, 2.25 minutes) can report a real
// quantity. inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
// stay @IsInt() — token counts are never fractional.

describe('quantity accepts fractions', () => {
  it('ServiceEntryDto.quantity accepts a fractional value', async () => {
    const errors = await validateEntry({ ...googlePlacesService, quantity: 0.066 });
    expect(errors).toEqual([]);
  });

  it('ServiceEntryDto.quantity still accepts an integer (widen, not narrow)', async () => {
    const errors = await validateEntry({ ...googlePlacesService, quantity: 3 });
    expect(errors).toEqual([]);
  });

  it('UsageRecordDto.quantity (top-level) accepts a fractional value', async () => {
    const payload = {
      customerExternalId: 'cust-123',
      agentCode: 'agent-abc',
      signalName: 'api_call',
      model: 'twilio-sms',
      modelProvider: 'twilio',
      quantity: 0.066,
    };
    expect(await validateRecord(payload)).toEqual([]);
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a negative number', -0.5],
  ])('ServiceEntryDto.quantity rejects %s', async (_label, badValue) => {
    const errors = await validateEntry({ ...googlePlacesService, quantity: badValue });
    expect(errors.some((e) => e.property === 'quantity')).toBe(true);
  });

  it('ServiceEntryDto.quantity rejects a non-numeric string', async () => {
    const errors = await validateEntry({ ...googlePlacesService, quantity: 'not-a-number' });
    expect(errors.some((e) => e.property === 'quantity')).toBe(true);
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a negative number', -0.5],
  ])('UsageRecordDto.quantity (top-level) rejects %s', async (_label, badValue) => {
    const messages = collectMessages(
      await validateRecord({ ...validSingleService, quantity: badValue }),
    );
    expect(messages.some((m) => /quantity/i.test(m))).toBe(true);
  });

  it('UsageRecordDto.quantity (top-level) rejects a non-numeric string', async () => {
    const messages = collectMessages(
      await validateRecord({ ...validSingleService, quantity: 'not-a-number' }),
    );
    expect(messages.some((m) => /quantity/i.test(m))).toBe(true);
  });
});

// ─── Ingest caps ──────────────────────────────────────────
//
// Sampled provenance for the cap values lives with the constants in
// record-usage.dto.ts. Contract under test: at-cap passes (a real payload may
// one day sit exactly on the line); one-past-cap fails with a message naming
// the field and the limit.

describe('UsageRecordDto — ingest caps', () => {
  const stringCapCases: Array<[string, number]> = [
    ['customerExternalId', INGEST_STRING_MAX_LENGTH],
    ['agentCode', INGEST_STRING_MAX_LENGTH],
    ['signalName', INGEST_STRING_MAX_LENGTH],
    ['model', INGEST_STRING_MAX_LENGTH],
    ['modelProvider', MODEL_PROVIDER_MAX_LENGTH],
    ['idempotencyKey', INGEST_STRING_MAX_LENGTH],
  ];

  it.each(stringCapCases)('accepts %s at exactly %i characters', async (field, cap) => {
    const errors = await validateRecord({ ...validSingleService, [field]: 'x'.repeat(cap) });
    expect(errors).toHaveLength(0);
  });

  it.each(stringCapCases)('rejects %s one character past %i', async (field, cap) => {
    const errors = await validateRecord({ ...validSingleService, [field]: 'x'.repeat(cap + 1) });
    const messages = collectMessages(errors);
    expect(messages.some((m) => m.includes(field) && m.includes(String(cap)))).toBe(true);
  });

  it('trims surrounding whitespace before measuring length', async () => {
    const errors = await validateRecord({
      ...validSingleService,
      customerExternalId: `   ${'x'.repeat(INGEST_STRING_MAX_LENGTH)}   `,
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects oversized model/modelProvider inside a service entry', async () => {
    const entryErrors = await validateEntry({
      model: 'x'.repeat(INGEST_STRING_MAX_LENGTH + 1),
      modelProvider: 'x'.repeat(MODEL_PROVIDER_MAX_LENGTH + 1),
    });
    const messages = collectMessages(entryErrors);
    expect(messages.some((m) => m.includes('model') && m.includes('255'))).toBe(true);
    expect(messages.some((m) => m.includes('modelProvider') && m.includes('100'))).toBe(true);
  });

  it('rejects an oversized nested field through the record→services path', async () => {
    const errors = await validateRecord({
      customerExternalId: 'cust-1',
      agentCode: 'agent-1',
      signalName: 'signal-1',
      services: [{ ...claudeService, model: 'x'.repeat(INGEST_STRING_MAX_LENGTH + 1) }],
    });
    const messages = collectMessages(errors);
    expect(messages.some((m) => m.includes('model') && m.includes('255'))).toBe(true);
  });

  it('accepts services[] at exactly the max size', async () => {
    const errors = await validateRecord({
      customerExternalId: 'cust-1',
      agentCode: 'agent-1',
      signalName: 'signal-1',
      services: Array.from({ length: SERVICES_MAX_SIZE }, () => ({ ...claudeService })),
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects services[] one entry past the max size', async () => {
    const errors = await validateRecord({
      customerExternalId: 'cust-1',
      agentCode: 'agent-1',
      signalName: 'signal-1',
      services: Array.from({ length: SERVICES_MAX_SIZE + 1 }, () => ({ ...claudeService })),
    });
    const messages = collectMessages(errors);
    expect(
      messages.some((m) => m.includes('services') && m.includes(String(SERVICES_MAX_SIZE))),
    ).toBe(true);
  });

  it('accepts metadata at exactly the serialized-byte cap', async () => {
    const pad = 'x'.repeat(METADATA_MAX_BYTES - '{"pad":""}'.length);
    const metadata = { pad };
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBe(METADATA_MAX_BYTES);
    const errors = await validateRecord({ ...validSingleService, metadata });
    expect(errors).toHaveLength(0);
  });

  it('rejects metadata one byte past the serialized cap, naming the byte limit', async () => {
    const pad = 'x'.repeat(METADATA_MAX_BYTES - '{"pad":""}'.length + 1);
    const errors = await validateRecord({ ...validSingleService, metadata: { pad } });
    const messages = collectMessages(errors);
    expect(
      messages.some((m) => m.includes('metadata') && m.includes(String(METADATA_MAX_BYTES))),
    ).toBe(true);
    // The oversized contents must never travel back in the error.
    expect(messages.join(' ')).not.toContain(pad);
  });

  it('accepts metadata nested within the depth cap (arrays count as levels)', async () => {
    const errors = await validateRecord({
      ...validSingleService,
      metadata: { a: { b: [{ d: 'leaf' }] } }, // depth 4: root→a→array→object
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects metadata nested past the depth cap, naming the depth limit', async () => {
    let nested: Record<string, unknown> = {};
    for (let level = 1; level <= METADATA_MAX_DEPTH; level++) {
      nested = { nest: nested };
    }
    const errors = await validateRecord({ ...validSingleService, metadata: nested });
    const messages = collectMessages(errors);
    expect(
      messages.some((m) => m.includes('metadata') && m.includes(String(METADATA_MAX_DEPTH))),
    ).toBe(true);
  });

  it('rejects metadata nested far past the cap without erroring out', async () => {
    // Depths past ~2,000 blow class-transformer's recursive walk before any
    // validator runs; the ingest envelope guard rejects those at the HTTP
    // boundary instead (see ingest-caps.http.spec.ts). 1,000 proves the
    // validator itself handles depths far past its cap of 5.
    let bomb: unknown = 'leaf';
    for (let level = 0; level < 1000; level++) {
      bomb = [bomb];
    }
    const errors = await validateRecord({ ...validSingleService, metadata: { bomb } });
    expect(collectMessages(errors).some((m) => m.includes('metadata'))).toBe(true);
  });

  it('accepts long realistic shapes with headroom', async () => {
    const errors = await validateRecord({
      customerExternalId: 'x'.repeat(42),
      agentCode: 'x'.repeat(27),
      signalName: 'x'.repeat(40),
      model: 'x'.repeat(53),
      modelProvider: 'x'.repeat(41),
      inputTokens: 1000,
      outputTokens: 500,
      metadata: { observed: 'x'.repeat(300) },
    });
    expect(errors).toHaveLength(0);
  });
});

// ─── Numeric caps ─────────────────────────────────────────
//
// Every numeric ingest field gets a @Max(NUMERIC_FIELD_MAX) absurd-value ceiling on
// BOTH DTOs. Contract: exactly at the cap passes (a real payload may one day sit on
// the line); one past the cap fails with a message naming the field and the limit.

describe('numeric caps', () => {
  const integerFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  const allNumericFields = [...integerFields, 'quantity'];

  describe('UsageRecordDto (single-service, top-level fields)', () => {
    it.each(allNumericFields)('accepts %s at exactly the cap', async (field) => {
      const errors = await validateRecord({ ...validSingleService, [field]: NUMERIC_FIELD_MAX });
      expect(errors).toHaveLength(0);
    });

    it.each(allNumericFields)(
      'rejects %s one past the cap, naming field + limit',
      async (field) => {
        const messages = collectMessages(
          await validateRecord({ ...validSingleService, [field]: NUMERIC_FIELD_MAX + 1 }),
        );
        expect(
          messages.some((m) => m.includes(field) && m.includes(String(NUMERIC_FIELD_MAX))),
        ).toBe(true);
      },
    );
  });

  describe('ServiceEntryDto (per-service fields)', () => {
    it.each(integerFields)('accepts %s at exactly the cap', async (field) => {
      const errors = await validateEntry({ ...claudeService, [field]: NUMERIC_FIELD_MAX });
      expect(errors).toHaveLength(0);
    });

    it.each(integerFields)('rejects %s one past the cap', async (field) => {
      const errors = await validateEntry({ ...claudeService, [field]: NUMERIC_FIELD_MAX + 1 });
      expect(errors.some((e) => e.property === field)).toBe(true);
    });

    it('accepts quantity at exactly the cap and rejects one past it', async () => {
      expect(
        await validateEntry({ ...googlePlacesService, quantity: NUMERIC_FIELD_MAX }),
      ).toHaveLength(0);
      const errors = await validateEntry({
        ...googlePlacesService,
        quantity: NUMERIC_FIELD_MAX + 1,
      });
      expect(errors.some((e) => e.property === 'quantity')).toBe(true);
    });
  });

  it('rejects an oversized nested field through the record→services path', async () => {
    const errors = await validateRecord({
      customerExternalId: 'cust-1',
      agentCode: 'agent-1',
      signalName: 'signal-1',
      services: [{ ...claudeService, inputTokens: NUMERIC_FIELD_MAX + 1 }],
    });
    const messages = collectMessages(errors);
    expect(
      messages.some((m) => m.includes('inputTokens') && m.includes(String(NUMERIC_FIELD_MAX))),
    ).toBe(true);
  });
});

describe('RecordUsageDto — batch cap (regression pin)', () => {
  it('accepts 100 records and rejects 101', async () => {
    const atCap = plainToInstance(RecordUsageDto, {
      records: Array.from({ length: 100 }, () => ({ ...validSingleService })),
    });
    expect(await validate(atCap)).toHaveLength(0);

    const overCap = plainToInstance(RecordUsageDto, {
      records: Array.from({ length: 101 }, () => ({ ...validSingleService })),
    });
    const errors = await validate(overCap);
    expect(errors.some((e) => e.property === 'records')).toBe(true);
  });
});
