import { ForbiddenException } from '@nestjs/common';

/**
 * The 403 a publishable-key (mf_pk_) request gets on any authenticated route that is not
 * on the publishable-key allowlist.
 *
 * SIBLING of PublishableKeyWriteForbiddenException, deliberately NOT a subclass:
 * CustomerFailureAlertFilter pages the alerts channel on that class with copy asserting
 * "a customer is using a publishable key to WRITE" — a false root cause for a read
 * denial. Extending ForbiddenException directly keeps classifyCustomerFailure at null
 * (no page); observability comes from the guard's log line instead.
 *
 * The plain object passed to super() becomes the response body verbatim, mirroring
 * InsufficientKeyRoleException: the distinct `code` lets the SDK/MCP branch on it
 * instead of string-matching the message.
 */
export class PublishableKeyReadForbiddenException extends ForbiddenException {
  constructor() {
    super({
      statusCode: 403,
      code: 'publishable_key_forbidden',
      message:
        'This endpoint needs a secret key. The key you sent starts with mf_pk_, which is the ' +
        'publishable key: it is safe to put in browser code and can only confirm your account. ' +
        'Use the secret key that starts with mf_sk_, from Settings, then API Keys.',
    });
  }
}
