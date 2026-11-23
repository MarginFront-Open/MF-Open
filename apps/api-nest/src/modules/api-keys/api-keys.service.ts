import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateApiKeyDto, QueryApiKeyDto } from './dto';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
// Every key WRITER also stores the deterministic lookup hash
// so validateApiKey can find the key by hash. Same shared helper as the verify
// path — they cannot drift.
// MintableKeyRoles is the per-minter ceiling on which role a
// new key may carry — a key can never be more powerful than whoever minted it.
// Revoking a secret key ends the org's live portal magic links +
// sessions in the same transaction — the same cascade the dashboard revoke
// action runs, imported from one place so the two doors cannot drift.
import { hashApiKeyForLookup, mintableKeyRoles, revokePortalAccessForOrg } from '@marginfront/db';
import { AuthenticatedUser } from '../auth/auth.service';
import { getUserId } from '../../common/helpers/get-user-id';

// The floor role a key carries when the minter chooses none (least privilege). An ingest key can only hit the usage-record routes.
const DEFAULT_KEY_ROLE = 'ingest';

// Publishable keys are read-capped to GET by PublishableKeyWriteGuardInterceptor
// regardless of role, so a pair's publishable half is always stamped 'member' —
// the read-open role — never the (possibly write-carrying) role the secret gets.
const PUBLISHABLE_KEY_ROLE = 'member';

const SALT_ROUNDS = 10;

type ApiKeyType = 'secret' | 'publishable';

const KEY_PREFIXES: Record<ApiKeyType, string> = {
  secret: 'mf_sk_',
  publishable: 'mf_pk_',
};

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a cryptographically secure API key with proper prefix
   */
  private generateSecureApiKey(keyType: ApiKeyType): string {
    const prefix = KEY_PREFIXES[keyType];
    const randomBytes = crypto.randomBytes(24).toString('base64url');
    return `${prefix}${randomBytes}`;
  }

  /**
   * Hash API key for secure storage
   */
  private async hashApiKey(apiKey: string): Promise<string> {
    return bcrypt.hash(apiKey, SALT_ROUNDS);
  }

  /**
   * Only a signed-in person mints a key. api_keys.createdById is a
   * @db.Uuid with an FK to users, and getUserId() flattens every key to the
   * 'system:api-key' sentinel, so a key-minted key can never be stored — Postgres
   * rejects the insert.
   */
  private assertHumanMinter(user: AuthenticatedUser): void {
    if (user.authMethod === 'api-key') {
      throw new ForbiddenException(
        "An API key can't create another API key. Every key is recorded against the person " +
          "who made it, and an API key isn't a person. Create it while signed in: in the " +
          'MarginFront dashboard under Build, then API keys, or by calling this endpoint ' +
          'with a user session.',
      );
    }
  }

  /**
   * The role of the signed-in human who is minting, used as the ceiling for the new key
   *Their ba_member.role in THIS org — the same row and org the OrgRoleGuard
   * route gate already checked. Fails CLOSED to '' (mints nothing) if no membership is
   * found, so a caller we can't place can't mint.
   *
   * No api-key branch: assertHumanMinter refuses those first, and the ''
   * fallthrough keeps this fail-closed if that check is ever moved or removed.
   */
  private async resolveMinterRole(orgId: string, user: AuthenticatedUser): Promise<string> {
    if (!user.userId) {
      return '';
    }
    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId: orgId, userId: user.userId },
      select: { role: true },
    });
    return membership?.role ?? '';
  }

  /**
   * Enforce the mint ceiling: the chosen key role must be one the minter
   * is allowed to hand out. A finance minter can stamp {finance, member, ingest}; a
   * developer {developer, member, ingest}; neither can cross into the other's lane or
   * reach admin/owner. Throws 403 otherwise.
   */
  private assertCanMint(minterRole: string, chosenRole: string): void {
    if (!mintableKeyRoles(minterRole).includes(chosenRole)) {
      throw new ForbiddenException(
        `Your role (${minterRole || 'unknown'}) cannot create a "${chosenRole}" key. ` +
          `You can create these key roles: [${mintableKeyRoles(minterRole).join(', ') || 'none'}]. ` +
          `Ask an owner or admin to create a higher-privilege key.`,
      );
    }
  }

  /**
   * The provenance object written into the api_keys.permissions Json column at mint time:
   * the role the key carries (what parseKeyRole reads on every request) plus who minted it
   * and with what role, so a demoted-user review can trace every key back to its minter.
   */
  private buildKeyPermissions(role: string, minterUserId: string, minterRole: string) {
    return { role, minterUserId, minterRole };
  }

  /**
   * Create a key pair (secret + publishable) for an organization
   * Returns both keys - secret key shown once, publishable key always accessible
   */
  async createApiKeyPair(orgId: string, user: AuthenticatedUser, dto: CreateApiKeyDto) {
    const now = new Date();

    this.assertHumanMinter(user);
    const userId = getUserId(user);
    const minterRole = await this.resolveMinterRole(orgId, user);
    const chosenRole = dto.role ?? DEFAULT_KEY_ROLE;
    this.assertCanMint(minterRole, chosenRole);
    const secretPermissions = this.buildKeyPermissions(chosenRole, userId, minterRole);
    const publishablePermissions = this.buildKeyPermissions(
      PUBLISHABLE_KEY_ROLE,
      userId,
      minterRole,
    );

    const secretKey = this.generateSecureApiKey('secret');
    const publishableKey = this.generateSecureApiKey('publishable');

    const secretKeyHash = await this.hashApiKey(secretKey);
    const publishableKeyHash = await this.hashApiKey(publishableKey);

    const [secretApiKey, publishableApiKey] = await this.prisma.$transaction([
      this.prisma.api_keys.create({
        data: {
          id: this.generateUuid(),
          organizationId: orgId,
          createdById: userId,
          name: `${dto.name} (Secret)`,
          description: dto.description || null,
          apiKeyHash: secretKeyHash,
          // Secret keys are hash-only at rest — no apiKeyPlaintext.
          apiKeyLookupHash: hashApiKeyForLookup(secretKey),
          status: 'active',
          keyType: 'secret',
          keyPrefix: KEY_PREFIXES.secret,
          permissions: secretPermissions,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
      this.prisma.api_keys.create({
        data: {
          id: this.generateUuid(),
          organizationId: orgId,
          createdById: userId,
          name: `${dto.name} (Publishable)`,
          description: dto.description || null,
          apiKeyHash: publishableKeyHash,
          apiKeyPlaintext: publishableKey,
          apiKeyLookupHash: hashApiKeyForLookup(publishableKey),
          status: 'active',
          keyType: 'publishable',
          keyPrefix: KEY_PREFIXES.publishable,
          permissions: publishablePermissions,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);

    return {
      secretKey: {
        id: secretApiKey.id,
        name: secretApiKey.name,
        key: secretKey, // Returned only in this response
        keyType: 'secret',
        createdAt: secretApiKey.createdAt,
      },
      publishableKey: {
        id: publishableApiKey.id,
        name: publishableApiKey.name,
        key: publishableKey, // Safe to expose
        keyType: 'publishable',
        createdAt: publishableApiKey.createdAt,
      },
      message:
        'Secret key will only be displayed once. Store it securely. Publishable key is safe to use in frontend code.',
    };
  }

  async getApiKeys(orgId: string, query: QueryApiKeyDto) {
    const { page = 1, limit = 10, name, keyType } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      organizationId: orgId,
      status: 'active',
    };

    if (name) {
      where.name = { contains: name, mode: 'insensitive' };
    }

    if (keyType) {
      where.keyType = keyType;
    }

    const [apiKeys, totalResults] = await Promise.all([
      this.prisma.api_keys.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          createdById: true,
          keyType: true,
          keyPrefix: true,
          permissions: true,
          lastUsedAt: true,
          createdAt: true,
          updatedAt: true,
          // Publishable keys return in full; the map below masks any stored
          // secret plaintext to its last 4 chars.
          apiKeyPlaintext: true,
          users: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.api_keys.count({ where }),
    ]);

    const maskedKeys = apiKeys.map((key) => ({
      ...key,
      apiKey:
        key.keyType === 'publishable'
          ? key.apiKeyPlaintext // Safe to expose
          : key.apiKeyPlaintext
            ? `${key.keyPrefix || ''}...${key.apiKeyPlaintext.slice(-4)}`
            : null,
      apiKeyPlaintext: undefined,
    }));

    return {
      results: maskedKeys,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
      totalResults,
    };
  }

  /**
   * Get publishable keys for an organization (safe to expose to frontend)
   */
  async getPublishableKeys(orgId: string) {
    const keys = await this.prisma.api_keys.findMany({
      where: {
        organizationId: orgId,
        status: 'active',
        keyType: 'publishable',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyType: true,
        apiKeyPlaintext: true, // Safe to return for publishable keys
        createdAt: true,
      },
    });

    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      key: key.apiKeyPlaintext,
      keyType: key.keyType,
      createdAt: key.createdAt,
    }));
  }

  async revokeApiKey(keyId: string, orgId: string) {
    const apiKey = await this.prisma.api_keys.findFirst({
      where: {
        id: keyId,
        organizationId: orgId,
        status: 'active',
      },
    });

    if (!apiKey) {
      throw new NotFoundException('API key not found or already revoked');
    }

    // Key write and portal cascade in ONE transaction, key first — a
    // cascade failure rolls the revoke back rather than leaving a dead key
    // whose portal sessions quietly live on.
    const { updated, portalAccess } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.api_keys.update({
        where: { id: keyId },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          // Parity with the dashboard revoke door: plaintext is
          // cleared, but apiKeyLookupHash SURVIVES the revoke on purpose.
          // status='revoked' is what blocks auth (validateApiKey filters
          // status:'active'); the retained hash is what lets the 401 path
          // recognize the key and say "revoked" instead of "invalid".
          apiKeyPlaintext: null,
          updatedAt: new Date(),
        },
      });
      // Only a secret key can mint portal access (SecretKeyGuard on the mint
      // route), so a publishable revoke ends nothing.
      const portalAccess =
        apiKey.keyType === 'secret'
          ? await revokePortalAccessForOrg(tx, orgId)
          : { magicLinksEnded: 0, portalSessionsEnded: 0 };
      return { updated, portalAccess };
    });

    this.logger.log(
      `Revoked API key for org ${orgId}: ended ${portalAccess.magicLinksEnded} magic links, ${portalAccess.portalSessionsEnded} portal sessions`,
    );

    return {
      message: 'API key revoked successfully',
      apiKey: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        revokedAt: updated.revokedAt,
      },
      portalAccess,
    };
  }

  private generateUuid(): string {
    return crypto.randomUUID();
  }
}
