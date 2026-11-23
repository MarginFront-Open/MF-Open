// Sentry initialization MUST run before any other application code so that
// auto-instrumentation hooks attach to Express, Nest, HTTP, etc. main.ts
// imports this file as its very first line — do not move it.
import * as Sentry from '@sentry/nestjs';
import { tracesSampler } from './sentry-traces-sampler';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampler,
  });
} else {
  console.warn('Sentry DSN not configured (api-nest)');
}
