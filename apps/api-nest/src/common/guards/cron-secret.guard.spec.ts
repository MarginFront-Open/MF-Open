/**
 * Tests for CronSecretGuard.
 *
 * The guard is the only thing standing between random internet traffic and our cron
 * endpoints (which generate invoices and send customer emails). Locking down its auth
 * behavior properly is the difference between "only the configured scheduler runs cron" and "anyone
 * with the URL can fire the billing job on demand."
 */

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronSecretGuard } from './cron-secret.guard';

function buildContext(authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authHeader ? { authorization: authHeader } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

function buildGuard(cronSecret: string | undefined): CronSecretGuard {
  const config = {
    get: jest.fn((key: string) => (key === 'CRON_SECRET' ? cronSecret : undefined)),
  } as unknown as ConfigService;
  return new CronSecretGuard(config);
}

describe('CronSecretGuard', () => {
  it('allows requests with the correct Bearer token', () => {
    const guard = buildGuard('correct-secret');
    const ctx = buildContext('Bearer correct-secret');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects requests with no Authorization header', () => {
    const guard = buildGuard('correct-secret');
    const ctx = buildContext();
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects requests with the wrong secret', () => {
    const guard = buildGuard('correct-secret');
    const ctx = buildContext('Bearer wrong-secret');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects requests with no Bearer prefix', () => {
    const guard = buildGuard('correct-secret');
    const ctx = buildContext('correct-secret');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects requests with a partial-prefix match (timing-safe even on length diff)', () => {
    const guard = buildGuard('correct-secret-with-extra-length');
    const ctx = buildContext('Bearer correct-secret');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects the correct secret followed by extra characters', () => {
    const guard = buildGuard('correct-secret');
    const ctx = buildContext('Bearer correct-secret-plus-more');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects ALL requests when CRON_SECRET is not configured on the server', () => {
    const guard = buildGuard(undefined);
    const ctx = buildContext('Bearer anything');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects requests when CRON_SECRET is whitespace-only', () => {
    const guard = buildGuard('   ');
    expect(() => guard.canActivate(buildContext('Bearer    '))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(buildContext('Bearer '))).toThrow(UnauthorizedException);
  });

  it('rejects the correct secret with a trailing NUL byte', () => {
    const guard = buildGuard('correct-secret');
    const ctx = buildContext('Bearer correct-secret\0');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects a multi-byte UTF-8 header that matches string .length but differs in byte length', () => {
    const guard = buildGuard('secret');
    const header = 'Bearer secreé';
    expect(header.length).toBe('Bearer secret'.length);
    expect(Buffer.byteLength(header)).not.toBe(Buffer.byteLength('Bearer secret'));
    expect(() => guard.canActivate(buildContext(header))).toThrow(UnauthorizedException);
  });
});
