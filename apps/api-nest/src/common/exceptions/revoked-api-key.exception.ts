import { UnauthorizedException } from '@nestjs/common';

/**
 * The validated facts behind a revoked-key rejection, read off the revoked
 * api_keys row. They travel as ONE object end to end: exception →
 * filter ctx → owner notice.
 */
export interface RevokedKeyFacts {
  organizationId: string;
  organizationName: string | null;
  /** api_keys.name — the label the owner gave the key. */
  keyLabel: string;
  revokedAt: Date;
}

/** "Aug 20, 2026" — UTC so the date can't drift across server timezones. */
export function formatUtcDay(d: Date): string {
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The 401 a caller gets when the key it presented matches a REVOKED row's
 * retained lookup hash. Dedicated subclass, mirroring
 * InsufficientKeyRoleException: the `code` lets clients branch without
 * string-matching, and CombinedAuthGuard / CustomerFailureAlertFilter branch on
 * the class to rethrow it and attribute the alert. Because it extends
 * UnauthorizedException, SecretKeyGuard and PublishableKeyGuard rethrow it
 * unchanged for free.
 *
 * `facts` rides on the exception for the filter/notice path and is NEVER
 * serialized into the response — only the plain object passed to super()
 * reaches the caller.
 */
export class RevokedApiKeyException extends UnauthorizedException {
  constructor(public readonly facts: RevokedKeyFacts) {
    super({
      statusCode: 401,
      code: 'key_revoked',
      message:
        `This API key was revoked on ${formatUtcDay(facts.revokedAt)}. ` +
        'Create a new key in Build > API keys, then update the app that still sends this one.',
    });
  }
}
