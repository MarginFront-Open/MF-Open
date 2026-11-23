type ConfigReader = { get<T = string>(key: string): T | undefined };

export const DEFAULT_PRODUCT_NAME = 'Usage Billing';

export const LIMITER_FAILURE_MODES = ['closed-anonymous', 'closed', 'open'] as const;
export type LimiterFailureMode = (typeof LIMITER_FAILURE_MODES)[number];
export const DEFAULT_LIMITER_FAILURE_MODE: LimiterFailureMode = 'closed-anonymous';

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function requireFrontendUrl(config: ConfigReader): string {
  const value = trimmed(config.get<string>('FRONTEND_URL'));
  if (!value || !isHttpUrl(value)) {
    throw new Error(
      'FRONTEND_URL is missing or is not an http(s) address. ' +
        'Why: every link the API puts in an email or a checkout redirect is built from it, ' +
        'and there is no safe default. ' +
        'Fix: set FRONTEND_URL in apps/api-nest/.env to the address of your dashboard, ' +
        'for example http://localhost:3000, then restart the API.',
    );
  }
  return value.replace(/\/+$/, '');
}

export function resolveProductName(config: ConfigReader): string {
  return trimmed(config.get<string>('PRODUCT_NAME')) || DEFAULT_PRODUCT_NAME;
}

export function resolveLimiterFailureMode(raw: string | undefined): LimiterFailureMode {
  const value = trimmed(raw);
  return (LIMITER_FAILURE_MODES as readonly string[]).includes(value)
    ? (value as LimiterFailureMode)
    : DEFAULT_LIMITER_FAILURE_MODE;
}

export function validateEnvironment(env: Record<string, unknown>): Record<string, unknown> {
  const problems: string[] = [];

  const frontendUrl = trimmed(env.FRONTEND_URL);
  if (!frontendUrl) {
    problems.push(
      'FRONTEND_URL is not set. It is the address of your dashboard, and every link in ' +
        'customer emails and checkout redirects is built from it. Set it, for example to ' +
        'http://localhost:3000.',
    );
  } else if (!isHttpUrl(frontendUrl)) {
    problems.push(
      `FRONTEND_URL must be a full http:// or https:// address; "${frontendUrl}" is not. ` +
        'Use the address of your dashboard, for example http://localhost:3000.',
    );
  }

  if (trimmed(env.RESEND_API_KEY) && !trimmed(env.RESEND_FROM_EMAIL)) {
    problems.push(
      'RESEND_API_KEY is set but RESEND_FROM_EMAIL is not, so there is no sender address. ' +
        'Set RESEND_FROM_EMAIL to an address on a domain you verified in Resend, for example ' +
        '"Your App <team@yourdomain.com>", or remove RESEND_API_KEY to run with email off.',
    );
  }

  const limiterMode = trimmed(env.RATE_LIMIT_STORE_FAILURE_MODE);
  if (limiterMode && !(LIMITER_FAILURE_MODES as readonly string[]).includes(limiterMode)) {
    problems.push(
      `RATE_LIMIT_STORE_FAILURE_MODE is "${limiterMode}", which is not a known value. ` +
        `Use one of: ${LIMITER_FAILURE_MODES.join(', ')}, or leave it empty for ` +
        `${DEFAULT_LIMITER_FAILURE_MODE}.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      'The API cannot start because its configuration is incomplete:\n' +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\nEdit apps/api-nest/.env (see .env.example for every setting), then start the API again.',
    );
  }

  return env;
}
