import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../../modules/auth/auth.service';

/**
 * The value getUserId returns when there is no human behind the request. Exported so
 * the guards that must special-case it compare against one definition instead of
 * hand-copying the literal.
 */
export const API_KEY_ACTOR_SENTINEL = 'system:api-key';

/**
 * Extracts the human user's ID from an authenticated request.
 *
 * - For JWT/session auth: returns the real user ID (a UUID from the users table)
 * - For API key auth: returns API_KEY_ACTOR_SENTINEL — there is no human to name.
 *
 * WHERE THE RETURN VALUE MAY BE STORED (read before adding a call site):
 * only a free-text audit column, e.g. credit_grants.createdBy (@db.VarChar, no FK).
 * NEVER a `@db.Uuid` column and never one with an FK to users: 'system:api-key' is
 * not a UUID and names no user row, so Postgres REJECTS the insert. `changedBy` and
 * `createdById` are both `@db.Uuid` FKs.
 *
 * So before you store this: if the caller may be an API key AND the column is a uuid,
 * refuse the request instead (requireHumanAuth, or a route-local 403). Do NOT use
 * req.user.id — that's the org ID for API keys.
 */
export function getUserId(user: AuthenticatedUser): string {
  if (user.authMethod === 'api-key') {
    return API_KEY_ACTOR_SENTINEL;
  }

  // For human auth methods, userId is always set by CombinedAuthGuard
  if (!user.userId) {
    throw new ForbiddenException(
      'Signed in, but the session names no user, so this action cannot be recorded against anyone. ' +
        'Sign out and sign in again. If it keeps happening, check that CombinedAuthGuard sets userId for this sign-in method.',
    );
  }

  return user.userId;
}

/**
 * Throws 403 if the request was made with an API key.
 * Use this for endpoints that only make sense for logged-in humans
 * (e.g., GET /users/me, POST /invitations/accept).
 */
export function requireHumanAuth(user: AuthenticatedUser): void {
  if (user.authMethod === 'api-key') {
    throw new ForbiddenException(
      'This endpoint requires a logged-in user session. API key authentication cannot access user-specific resources.',
    );
  }
}
