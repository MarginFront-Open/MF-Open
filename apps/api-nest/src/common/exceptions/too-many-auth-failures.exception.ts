import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Seconds we ask a client to wait before retrying, deliberately far SHORTER than
 * the throttle window that produced the 429. The SDK treats 429 as retryable and
 * sleeps this value verbatim between each of its 3 retries
 * (packages/sdk/src/utils/http.ts, no ceiling), so sending the window remainder
 * (up to 900) would freeze the customer's own request handler for ~45 minutes.
 *
 * Same value as AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS and deliberately a SEPARATE
 * constant: the two knobs answer to different mechanisms and must be tunable
 * independently.
 */
export const AUTH_FAILURE_THROTTLE_RETRY_AFTER_SECONDS = 5;

/**
 * The 429 a caller gets when one network has burned through its budget of FAILED
 * API-key attempts. It is a credential verdict, not a tenant rate
 * limit, and the distinct `code` is what keeps the two apart: the filter
 * excludes it from the 'rate_limit' alert class, whose copy asserts an
 * AUTHENTICATED customer straining their limits.
 *
 * KNOWN CLIENT GAPS (in packages/*): code-cost-clarity's setup-time key check
 * reads any non-401/403 as "unreachable" (packages/code-cost-clarity/src/forwarder.ts)
 * and MCP replaces any 429 body with generic rate-limit copy
 * (packages/mcp/src/index.ts). This message reaches raw HTTP and curl callers,
 * NOT those two clients.
 */
export class TooManyAuthFailuresException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 429,
        code: 'too_many_auth_failures',
        message:
          'Too many failed API key attempts from this network. Wait a few minutes, ' +
          "then check the key you're sending in Build > API keys.",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
