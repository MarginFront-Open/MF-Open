import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Seconds we ask a client to wait before retrying. Kept SMALL on purpose: the
 * SDK sleeps this exact value between each of its 3 retries while
 * usage.trackEvent awaits the POST (packages/sdk/src/utils/http.ts honors
 * Retry-After verbatim), so a large value stalls the customer's own request
 * handler — 30 would mean up to ~110s of blocked caller per outage hit.
 */
export const AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * The 503 a caller gets when api-key validation COULD NOT RUN:
 * the DB rejected the lookup, so no credential verdict exists and a 401 would
 * falsely blame the customer's key. The `code` lets clients branch without
 * string-matching, mirroring RevokedApiKeyException. The message is printed
 * verbatim on customer terminals by code-cost-clarity and surfaced by MCP; it is
 * customer-facing copy.
 */
export class AuthUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: 503,
      code: 'auth_unavailable',
      message:
        "MarginFront couldn't check this API key because of a problem on our side. " +
        'Your key is probably fine. Try again in a moment.',
    });
  }
}
