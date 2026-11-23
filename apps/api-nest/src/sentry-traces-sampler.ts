import type { NodeOptions } from '@sentry/nestjs';

// Ingest, cap reads and orphan Prisma roots produce almost all spans, so they are
// sampled down to keep span volume inside a tracing quota. Everything else is
// low-volume and stays at 100%.
export const INGEST_TRACE_RATE = 0.02;
export const CONTROL_CAPS_TRACE_RATE = 0.05;
export const ORPHAN_PRISMA_TRACE_RATE = 0.02;
export const DEFAULT_TRACE_RATE = 1;

type SamplerContext = Parameters<NonNullable<NodeOptions['tracesSampler']>>[0];

type TransactionNameContext = {
  name?: string;
  attributes?: SamplerContext['attributes'];
};

function withoutQueryString(value: string): string {
  const queryStart = value.indexOf('?');
  return queryStart === -1 ? value : value.slice(0, queryStart);
}

function firstString(...candidates: unknown[]): string | undefined {
  return candidates.find((candidate): candidate is string => typeof candidate === 'string');
}

// The SDK we run always supplies a non-empty name; for auto-instrumented HTTP server spans
// it is the inferred, query-stripped "<METHOD> <path>". The attribute rebuild stays
// as a fallback in case a future SDK passes a raw span name.
export function resolveTransactionName(ctx: TransactionNameContext): string {
  if (ctx.name) {
    return withoutQueryString(ctx.name);
  }

  const attributes = ctx.attributes ?? {};
  const method = firstString(attributes['http.request.method'], attributes['http.method']);
  const path = firstString(
    attributes['url.path'],
    attributes['http.target'],
    attributes['http.route'],
  );

  if (!path) {
    return '';
  }

  const cleanPath = withoutQueryString(path);
  return method ? `${method} ${cleanPath}` : cleanPath;
}

export const tracesSampler: NonNullable<NodeOptions['tracesSampler']> = (ctx) => {
  const name = resolveTransactionName(ctx);

  if (name.includes('/usage/record')) {
    return INGEST_TRACE_RATE;
  }
  if (name.startsWith('GET /v1/control/caps')) {
    return CONTROL_CAPS_TRACE_RATE;
  }
  if (name.startsWith('prisma:client:')) {
    return ORPHAN_PRISMA_TRACE_RATE;
  }

  return typeof ctx.inheritOrSampleWith === 'function'
    ? ctx.inheritOrSampleWith(DEFAULT_TRACE_RATE)
    : DEFAULT_TRACE_RATE;
};
