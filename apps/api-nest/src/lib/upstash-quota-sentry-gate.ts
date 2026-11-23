// When the Upstash monthly request cap is hit, every Redis command fails with the
// same error. Reporting each one would quickly exhaust a Sentry error quota, so
// callers report it at most once per window per process.

const QUOTA_ERROR_TEXT = 'max requests limit exceeded';

export const UPSTASH_QUOTA_REPORT_INTERVAL_MS = 60 * 60 * 1000;

export const UPSTASH_QUOTA_SENTRY_FINGERPRINT = ['upstash-redis-max-requests-limit-exceeded'];

let lastReportedAt: number | null = null;

export function isUpstashQuotaError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.toLowerCase().includes(QUOTA_ERROR_TEXT);
}

export function shouldReportUpstashQuotaError(now: number = Date.now()): boolean {
  if (lastReportedAt !== null && now - lastReportedAt < UPSTASH_QUOTA_REPORT_INTERVAL_MS) {
    return false;
  }
  lastReportedAt = now;
  return true;
}

export function resetUpstashQuotaReportGate(): void {
  lastReportedAt = null;
}
