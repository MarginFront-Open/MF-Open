import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
// The ONE shared helper that turns a raw key into its
// deterministic lookup hash. The SAME function the key creators use on write,
// so the value we match here is guaranteed to equal what was stored.
// The ONE shared helper that reads a key's dashboard role
// off its permissions blob, floored to 'ingest' on anything malformed.
import { hashApiKeyForLookup, parseKeyRole } from '@marginfront/db';
import { RevokedApiKeyException } from '../../common/exceptions/revoked-api-key.exception';
import { hasRecognizedApiKeyPrefix } from './lib/extract-claimed-identity';

/**
 * Authenticated user interface returned by auth guards
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name?: string;
  organizationId?: string;
  organizationName?: string;
  emailVerified?: boolean;
  keyType?: 'secret' | 'publishable';
  // Which auth method was used — lets controllers handle API key vs human differently
  authMethod: 'api-key' | 'jwt' | 'session' | 'portal';
  // The actual human user's ID. undefined for API key auth (there's no human behind an API key)
  userId?: string;
  // The api_keys.id of the key that authenticated this request. Set only when
  // authMethod === 'api-key'. Used by the audit logging interceptor.
  apiKeyId?: string;
  // The dashboard role an api-key auth carries, read via
  // parseKeyRole(record.permissions). Populated on every api-key request;
  // OrgRoleGuard reads it to enforce key roles.
  role?: string;
}

/**
 * Portal session user (customer context)
 */
export interface PortalSessionUser {
  customerId: string;
  organizationId: string;
  sessionId: string;
  customerEmail?: string;
  customerName?: string;
}

/**
 * Auth Service
 *
 * Handles API key validation. The database record is the source of truth —
 * key prefixes are cosmetic and are never used to gate access.
 * Better Auth handles user authentication (login, register, logout, etc.)
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate any API key and return the associated org.
   * A key is valid if it exists and is active in the database — prefix is irrelevant.
   */
  async validateApiKey(apiKey: string): Promise<AuthenticatedUser> {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new UnauthorizedException('API key is required');
    }

    // The database record is the source of truth — prefix is cosmetic only.

    // ONLY lookup: match on the deterministic SHA-256 lookup hash. Every key stores it
    // on write via the same shared hashApiKeyForLookup helper, so write and verify cannot
    // drift. There is no plaintext or apiKeyHash fallback: a miss here is a 401.
    //
    // NO .catch on this lookup. A query that RAN and missed is a
    // credential verdict (→ 401 below); a query that COULD NOT RUN (DB down,
    // pooler timeout, missing column) REJECTS and must propagate so
    // CombinedAuthGuard can answer an honest 503 instead of "Invalid API key".
    // Still fail-closed either way: a throw authenticates nobody.
    //
    // Every lookup also filters `deletedAt: null` so a
    // soft-deleted key — which deleteApiKey leaves at status='active' — can never
    // re-authenticate. (Mirrors the deletedAt:null filter every other api_keys read
    // already uses, e.g. record-sdk-usage.)
    const apiKeyRecord = await this.prisma.api_keys.findFirst({
      where: {
        apiKeyLookupHash: hashApiKeyForLookup(apiKey),
        status: 'active',
        deletedAt: null,
      },
      include: {
        organizations: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!apiKeyRecord) {
      await this.throwIfKeyWasRevoked(apiKey);
      throw new UnauthorizedException('Invalid API key');
    }

    if (apiKeyRecord.expiresAt && new Date(apiKeyRecord.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedException(
        `This API key expired on ${new Date(apiKeyRecord.expiresAt).toISOString()}, so it can no ` +
          'longer be used. Create a new key in the dashboard and update the app or tool that ' +
          'sends this one.',
      );
    }

    // Update last used timestamp (fire and forget)
    this.prisma.api_keys
      .update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {}); // Ignore errors

    return {
      id: apiKeyRecord.organizationId,
      email: '',
      name: 'API User',
      organizationId: apiKeyRecord.organizationId,
      organizationName: apiKeyRecord.organizations?.name,
      keyType: apiKeyRecord.keyType as 'secret' | 'publishable',
      authMethod: 'api-key' as const,
      userId: undefined, // API keys have no human behind them — no user ID exists
      apiKeyId: apiKeyRecord.id, // For audit logging
      role: parseKeyRole(apiKeyRecord.permissions),
    };
  }

  /**
   * Honest 401: after the active lookup misses, check whether the
   * presented key's hash matches a REVOKED row's retained apiKeyLookupHash and,
   * if so, throw the distinct key_revoked 401 instead of "Invalid API key".
   * Runs ONLY on auth misses. A successful auth never reaches this, so the hot
   * path pays nothing for it.
   *
   * The prefix gate is the cost ceiling: only a key that looks like ours
   * (mf_sk_/mf_pk_) earns the extra indexed lookup, so scanner floods
   * spraying junk tokens pay zero additional queries. Full 64-char hash
   * equality, never a prefix — the 12-char alert fingerprint would false-match.
   *
   * A revoked key with a NULL apiKeyLookupHash never matches a hex-string equality, so
   * those fall through to the generic 401 with no special-casing. No deletedAt
   * clause: deleting a revoked key also nulls the hash, so a delete downgrades
   * the answer back to generic on its own.
   */
  private async throwIfKeyWasRevoked(apiKey: string): Promise<void> {
    if (!hasRecognizedApiKeyPrefix(apiKey)) {
      return;
    }

    // .catch kept HERE on purpose (unlike the primary lookup): by
    // the time this probe runs, the active lookup already answered "not an
    // active key" — the verdict exists. The probe only picks WHICH 401 message
    // we give, so a rejecting probe degrades to the generic 401, never up to
    // a 503.
    const revokedRecord = await this.prisma.api_keys
      .findFirst({
        where: {
          apiKeyLookupHash: hashApiKeyForLookup(apiKey),
          status: 'revoked',
        },
        select: {
          name: true,
          revokedAt: true,
          organizationId: true,
          organizations: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      })
      .catch(() => null);

    if (revokedRecord?.revokedAt) {
      throw new RevokedApiKeyException({
        organizationId: revokedRecord.organizationId,
        organizationName: revokedRecord.organizations?.name ?? null,
        keyLabel: revokedRecord.name,
        revokedAt: revokedRecord.revokedAt,
      });
    }
  }

  /**
   * Validate a secret key — requires keyType='secret' in the database.
   * Used for sensitive operations like creating portal sessions.
   */
  async validateSecretKey(apiKey: string): Promise<AuthenticatedUser> {
    const user = await this.validateApiKey(apiKey);

    if (user.keyType !== 'secret') {
      throw new ForbiddenException(
        'Publishable keys cannot perform write operations (POST/PUT/PATCH/DELETE). Use a secret key (mf_sk_*) for operations that create, update, or delete data.',
      );
    }

    return user;
  }

  /**
   * Validate any key for publishable-level operations.
   * Accepts both secret and publishable keys (secret keys have higher privilege).
   */
  async validatePublishableKey(apiKey: string): Promise<AuthenticatedUser> {
    return this.validateApiKey(apiKey);
  }

  /**
   * Validate a portal session token (prtl_*)
   * Returns the customer context for the session
   */
  async validatePortalSessionToken(token: string): Promise<PortalSessionUser | null> {
    // Portal session tokens start with 'prtl_'
    if (!token.startsWith('prtl_')) {
      return null;
    }

    // Portal_sessions.token holds only the SHA-256 hash of the token,
    // so the lookup must never match the raw value: a stored hash is not a token.
    const session = await this.prisma.portal_sessions.findFirst({
      where: {
        token: hashApiKeyForLookup(token),
        expiresAt: { gt: new Date() },
      },
      include: {
        customers: {
          select: {
            id: true,
            name: true,
            email: true,
            organizationId: true,
          },
        },
      },
    });

    if (!session || !session.customers) {
      return null;
    }

    return {
      customerId: session.customerId,
      organizationId: session.organizationId,
      sessionId: session.id,
      customerEmail: session.customers.email || undefined,
      customerName: session.customers.name || undefined,
    };
  }
}
