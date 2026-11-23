import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as Sentry from '@sentry/nestjs';
import { ReplyError } from 'ioredis';
import { PerTenantThrottlerGuard } from '../modules/auth/guards/per-tenant-throttler.guard';
import { WebhookDedupeService } from '../modules/webhooks/webhook-dedupe.service';
import {
  isUpstashQuotaError,
  resetUpstashQuotaReportGate,
  shouldReportUpstashQuotaError,
  UPSTASH_QUOTA_REPORT_INTERVAL_MS,
} from './upstash-quota-sentry-gate';

const mockRedisInstance = {
  set: jest.fn(),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
};
jest.mock('ioredis', () => {
  const actual = jest.requireActual('ioredis');
  return {
    __esModule: true,
    ...actual,
    default: jest.fn().mockImplementation(() => mockRedisInstance),
  };
});

jest.mock('@sentry/nestjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const UPSTASH_MESSAGE =
  'ERR max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details';

describe('isUpstashQuotaError', () => {
  it('recognizes the real ioredis ReplyError Upstash returns', () => {
    expect(isUpstashQuotaError(new ReplyError(UPSTASH_MESSAGE))).toBe(true);
  });

  it('matches regardless of case', () => {
    expect(isUpstashQuotaError(new Error('Max Requests Limit Exceeded'))).toBe(true);
  });

  it.each([
    ['a connection reset', new Error('read ECONNRESET')],
    ['the cold-start TypeError', new TypeError('this.throttlers is not iterable')],
    ['a different Upstash limit', new Error('ERR max daily request limit exceeded')],
    ['a plain string', UPSTASH_MESSAGE],
    ['null', null],
    ['undefined', undefined],
    ['an object with a non-string message', { message: 42 }],
  ])('rejects %s', (_label, value) => {
    expect(isUpstashQuotaError(value)).toBe(false);
  });
});

describe('shouldReportUpstashQuotaError', () => {
  beforeEach(() => resetUpstashQuotaReportGate());

  it('says yes once, then no for the rest of the window, then yes again', () => {
    const start = 1_000_000;
    expect(shouldReportUpstashQuotaError(start)).toBe(true);
    expect(shouldReportUpstashQuotaError(start + 1)).toBe(false);
    expect(shouldReportUpstashQuotaError(start + UPSTASH_QUOTA_REPORT_INTERVAL_MS - 1)).toBe(false);
    expect(shouldReportUpstashQuotaError(start + UPSTASH_QUOTA_REPORT_INTERVAL_MS)).toBe(true);
    expect(shouldReportUpstashQuotaError(start + UPSTASH_QUOTA_REPORT_INTERVAL_MS + 1)).toBe(false);
  });

  it('uses a 60-minute window', () => {
    expect(UPSTASH_QUOTA_REPORT_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

describe('the throttler guard and webhook dedupe share one quota report gate', () => {
  const captureException = Sentry.captureException as jest.Mock;
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ url: '/v1/sdk/usage/record', method: 'POST' }) }),
  } as unknown as ExecutionContext;
  const config = { get: () => 'redis://localhost:6379' } as unknown as ConfigService;

  beforeEach(() => {
    process.env.RATE_LIMIT_STORE_FAILURE_MODE = 'open';
    resetUpstashQuotaReportGate();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest
      .spyOn(ThrottlerGuard.prototype, 'canActivate')
      .mockImplementation(() => Promise.reject(new ReplyError(UPSTASH_MESSAGE)));
    mockRedisInstance.set.mockImplementation(() => Promise.reject(new ReplyError(UPSTASH_MESSAGE)));
    captureException.mockClear();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_STORE_FAILURE_MODE;
    jest.restoreAllMocks();
    mockRedisInstance.set.mockReset();
  });

  it('a report from the guard suppresses the webhook report in the same window', async () => {
    const guard = new PerTenantThrottlerGuard(null as any, null as any, null as any);
    const dedupe = new WebhookDedupeService(config);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(dedupe.claim('stripe', 'evt_1')).resolves.toBe(true);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1].tags.component).toBe('PerTenantThrottlerGuard');
  });

  it('a report from the webhook path suppresses the guard report in the same window', async () => {
    const guard = new PerTenantThrottlerGuard(null as any, null as any, null as any);
    const dedupe = new WebhookDedupeService(config);

    await expect(dedupe.claim('stripe', 'evt_1')).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1].tags.service).toBe('WebhookDedupeService');
  });
});
