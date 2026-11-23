import {
  DEFAULT_PRODUCT_NAME,
  requireFrontendUrl,
  resolveLimiterFailureMode,
  resolveProductName,
  validateEnvironment,
} from './app-config';

const reader = (values: Record<string, string | undefined>) => ({
  get: (key: string) => values[key] as any,
});

describe('validateEnvironment', () => {
  const minimal = { FRONTEND_URL: 'http://localhost:3000' };

  it('accepts the minimal configuration: no email, no Redis, no product name', () => {
    expect(validateEnvironment({ ...minimal })).toEqual(minimal);
  });

  it('refuses to start without FRONTEND_URL and says what to set', () => {
    expect(() => validateEnvironment({})).toThrow(
      /cannot start[\s\S]*FRONTEND_URL is not set[\s\S]*http:\/\/localhost:3000[\s\S]*\.env\.example/,
    );
  });

  it('refuses a FRONTEND_URL that is not an http(s) address', () => {
    expect(() => validateEnvironment({ FRONTEND_URL: 'billing.example.com' })).toThrow(
      /FRONTEND_URL must be a full http:\/\/ or https:\/\/ address/,
    );
  });

  it('refuses an email key with no sender address', () => {
    expect(() => validateEnvironment({ ...minimal, RESEND_API_KEY: 're_test' })).toThrow(
      /RESEND_API_KEY is set but RESEND_FROM_EMAIL is not/,
    );
  });

  it('accepts an email key with a sender address', () => {
    expect(() =>
      validateEnvironment({
        ...minimal,
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'Billing <billing@example.com>',
      }),
    ).not.toThrow();
  });

  it('refuses an unknown RATE_LIMIT_STORE_FAILURE_MODE and lists the valid ones', () => {
    expect(() =>
      validateEnvironment({ ...minimal, RATE_LIMIT_STORE_FAILURE_MODE: 'sometimes' }),
    ).toThrow(/closed-anonymous, closed, open/);
  });

  it('reports every problem at once', () => {
    let message = '';
    try {
      validateEnvironment({ RESEND_API_KEY: 're_test', RATE_LIMIT_STORE_FAILURE_MODE: 'x' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.match(/^ {2}- /gm)).toHaveLength(3);
  });
});

describe('requireFrontendUrl', () => {
  it('returns the address without a trailing slash', () => {
    expect(requireFrontendUrl(reader({ FRONTEND_URL: 'https://billing.example.com/' }))).toBe(
      'https://billing.example.com',
    );
  });

  it('throws a fix-it message instead of falling back to any default host', () => {
    expect(() => requireFrontendUrl(reader({}))).toThrow(/FRONTEND_URL is missing.*Fix: set/s);
  });
});

describe('resolveProductName', () => {
  it('defaults to a neutral name', () => {
    expect(resolveProductName(reader({}))).toBe(DEFAULT_PRODUCT_NAME);
    expect(DEFAULT_PRODUCT_NAME).not.toMatch(/marginfront/i);
  });

  it('uses PRODUCT_NAME when set', () => {
    expect(resolveProductName(reader({ PRODUCT_NAME: '  Larkspur Billing ' }))).toBe(
      'Larkspur Billing',
    );
  });
});

describe('resolveLimiterFailureMode', () => {
  it.each(['closed-anonymous', 'closed', 'open'] as const)('accepts %s', (mode) => {
    expect(resolveLimiterFailureMode(mode)).toBe(mode);
  });

  it('defaults to closed-anonymous when unset or unknown', () => {
    expect(resolveLimiterFailureMode(undefined)).toBe('closed-anonymous');
    expect(resolveLimiterFailureMode('nope')).toBe('closed-anonymous');
  });
});
