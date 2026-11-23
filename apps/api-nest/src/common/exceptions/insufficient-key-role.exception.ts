import { ForbiddenException } from '@nestjs/common';

/**
 * The 403 an API-key request gets when its dashboard role is too low for the route.
 * A dedicated subclass, mirroring PublishableKeyWriteForbiddenException: the distinct `code` lets CustomerFailureAlertFilter
 * and the SDK/MCP client branch on it instead of string-matching a message. The plain object
 * passed to super() becomes the response body verbatim (NestJS behavior).
 */
export class InsufficientKeyRoleException extends ForbiddenException {
  constructor(requiredRoles: string[], keyRole: string) {
    super({
      statusCode: 403,
      code: 'insufficient_key_role',
      required_roles: requiredRoles,
      key_role: keyRole,
      message:
        `This API key's role ('${keyRole}') is not permitted to perform this action. ` +
        `Allowed roles: ${requiredRoles.join(', ') || '(none — control-plane, humans only)'}.`,
    });
  }
}
