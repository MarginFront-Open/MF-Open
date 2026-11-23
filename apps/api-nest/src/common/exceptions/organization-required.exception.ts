import { UnauthorizedException } from '@nestjs/common';

/**
 * The 401 an ingest caller gets when it DID authenticate but the principal
 * carries no organizationId: a Better Auth JWT, which never sets
 * one, or a session whose activeOrganizationId is null.
 *
 * The plain object handed to super() IS the response body, verbatim. `code` lets
 * clients branch without string-matching, mirroring RevokedApiKeyException.
 *
 * Thrown from the HANDLER, after CombinedAuthGuard already returned true, so it
 * can never reach the failed-auth counter — that counter runs only on
 * the guard's reject path, and only for requests carrying an x-api-key.
 *
 * Accepted interaction: a caller sending BOTH an x-api-key whose
 * lookup faulted AND a valid login token gets this 401 rather than the 503,
 * because the login token did authenticate. The 503 is unreachable for that one
 * header combination.
 */
export class OrganizationRequiredException extends UnauthorizedException {
  constructor() {
    super({
      statusCode: 401,
      code: 'use_api_key',
      message:
        "This endpoint records usage with an API key, and a login token doesn't carry one. " +
        'Send your secret key (mf_sk_...) in the x-api-key header instead. ' +
        'You can create one in Build > API keys.',
    });
  }
}
