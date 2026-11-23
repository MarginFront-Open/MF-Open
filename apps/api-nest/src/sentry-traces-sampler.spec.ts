import {
  CONTROL_CAPS_TRACE_RATE,
  DEFAULT_TRACE_RATE,
  INGEST_TRACE_RATE,
  ORPHAN_PRISMA_TRACE_RATE,
  resolveTransactionName,
  tracesSampler,
} from './sentry-traces-sampler';

type SamplerArg = Parameters<typeof tracesSampler>[0];

function context(overrides: Partial<SamplerArg> = {}): SamplerArg {
  return {
    name: '',
    inheritOrSampleWith: jest.fn(() => DEFAULT_TRACE_RATE),
    ...overrides,
  } as SamplerArg;
}

describe('sentry traces sampler rates', () => {
  it('pins the sampling rates', () => {
    expect(INGEST_TRACE_RATE).toBe(0.02);
    expect(CONTROL_CAPS_TRACE_RATE).toBe(0.05);
    expect(ORPHAN_PRISMA_TRACE_RATE).toBe(0.02);
    expect(DEFAULT_TRACE_RATE).toBe(1);
  });
});

describe('resolveTransactionName', () => {
  it('strips the query string from the transaction name', () => {
    expect(resolveTransactionName({ name: 'GET /v1/control/caps?orgId=abc&x=1' })).toBe(
      'GET /v1/control/caps',
    );
  });

  it('leaves a name with no query string alone', () => {
    expect(resolveTransactionName({ name: 'POST /v1/sdk/usage/record' })).toBe(
      'POST /v1/sdk/usage/record',
    );
  });

  it('composes the name from current semconv attributes when there is no name', () => {
    expect(
      resolveTransactionName({
        attributes: { 'http.request.method': 'POST', 'url.path': '/v1/sdk/usage/record' },
      }),
    ).toBe('POST /v1/sdk/usage/record');
  });

  it('composes the name from legacy semconv attributes', () => {
    expect(
      resolveTransactionName({
        attributes: { 'http.method': 'GET', 'http.target': '/v1/control/caps?orgId=abc' },
      }),
    ).toBe('GET /v1/control/caps');
  });

  it('returns an empty string when neither a name nor a path is available', () => {
    expect(resolveTransactionName({ attributes: { 'http.request.method': 'POST' } })).toBe('');
    expect(resolveTransactionName({})).toBe('');
  });
});

describe('tracesSampler', () => {
  it('samples the SDK ingest route at 2%', () => {
    expect(tracesSampler(context({ name: 'POST /v1/sdk/usage/record' }))).toBe(INGEST_TRACE_RATE);
  });

  it('samples the ingest alias route at 2%', () => {
    expect(tracesSampler(context({ name: 'POST /v1/usage/record' }))).toBe(INGEST_TRACE_RATE);
  });

  it('samples the ingest route at 2% with a query string attached', () => {
    expect(tracesSampler(context({ name: 'POST /v1/sdk/usage/record?dryRun=true' }))).toBe(
      INGEST_TRACE_RATE,
    );
  });

  it('holds the ingest rate fixed even when the incoming trace was sampled', () => {
    const inheritOrSampleWith = jest.fn(() => 1);
    const result = tracesSampler(
      context({ name: 'POST /v1/sdk/usage/record', parentSampled: true, inheritOrSampleWith }),
    );

    expect(result).toBe(INGEST_TRACE_RATE);
    expect(inheritOrSampleWith).not.toHaveBeenCalled();
  });

  it('samples the control caps route at 5%', () => {
    expect(tracesSampler(context({ name: 'GET /v1/control/caps' }))).toBe(CONTROL_CAPS_TRACE_RATE);
    expect(tracesSampler(context({ name: 'GET /v1/control/caps?x=1' }))).toBe(
      CONTROL_CAPS_TRACE_RATE,
    );
  });

  it('samples orphaned prisma root spans at 2%', () => {
    expect(tracesSampler(context({ name: 'prisma:client:operation' }))).toBe(
      ORPHAN_PRISMA_TRACE_RATE,
    );
    expect(tracesSampler(context({ name: 'prisma:client:transaction' }))).toBe(
      ORPHAN_PRISMA_TRACE_RATE,
    );
  });

  it('defers everything else to inheritOrSampleWith at full rate', () => {
    const inheritOrSampleWith = jest.fn(() => 0.42);
    const result = tracesSampler(context({ name: 'GET /v1/customers', inheritOrSampleWith }));

    expect(inheritOrSampleWith).toHaveBeenCalledTimes(1);
    expect(inheritOrSampleWith).toHaveBeenCalledWith(1);
    expect(result).toBe(0.42);
  });

  it('falls back to the default rate when the context has no inheritOrSampleWith', () => {
    const ctx = { name: 'GET /v1/customers' } as unknown as SamplerArg;
    expect(tracesSampler(ctx)).toBe(DEFAULT_TRACE_RATE);
  });

  it('matches the ingest route from attributes when the name is missing', () => {
    expect(
      tracesSampler(
        context({
          name: undefined,
          attributes: { 'http.request.method': 'POST', 'url.path': '/v1/sdk/usage/record' },
        }),
      ),
    ).toBe(INGEST_TRACE_RATE);
  });

  it('matches the ingest route from legacy attributes when the name is empty', () => {
    expect(
      tracesSampler(
        context({
          name: '',
          attributes: { 'http.method': 'POST', 'http.target': '/v1/usage/record?x=1' },
        }),
      ),
    ).toBe(INGEST_TRACE_RATE);
  });
});
