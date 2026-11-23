import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CreatePortalSessionDto,
  PortalFeature,
  PORTAL_FEATURES,
} from './dto/create-portal-session.dto';
import * as crypto from 'crypto';
import { hashApiKeyForLookup } from '@marginfront/db';

/**
 * Portal session response (single-use magic link)
 */
export interface PortalSessionResponse {
  id: string;
  object: 'portal_session';
  // url + token are only knowable at CREATION: the stored token
  // is a SHA-256 hash, so a later GET-by-id cannot reconstruct the usable link.
  // Present on createPortalSession's response, omitted on getPortalSession.
  url?: string;
  token?: string;
  customerId: string;
  customerName?: string;
  customerEmail?: string;
  expiresAt: Date;
  features: PortalFeature[];
  returnUrl?: string;
  createdAt: Date;
}

// Single-use magic link expiry: 1 hour, the same lifetime as the portal cookie session.
const MAGIC_LINK_EXPIRY_MS = 60 * 60 * 1000;
const MAGIC_LINK_TOKEN_PREFIX = 'mgl_';

@Injectable()
export class PortalSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private generatePortalToken(): string {
    // 32 chars of base64url entropy (192 bits), prefixed `mgl_`. Mirrors
    // `createPortalMagicLink` in apps/dashboard/app/lib/portal-auth.ts so
    // every magic-link mint point produces the same shape.
    const random = crypto.randomBytes(24).toString('base64url');
    return `${MAGIC_LINK_TOKEN_PREFIX}${random}`;
  }

  /**
   * Build the redeem URL the customer opens.
   *
   * Path-based portal architecture: the URL is `<base>/r/<token>`
   * with the slug intentionally absent. The token resolves to the org
   * server-side at the dashboard's /r/[token] route, which sets the cookie
   * and redirects to /<slug>/.
   *
   * Resolves the base host with a three-tier fallback chain:
   *   1. PORTAL_BASE_URL — the canonical per-env config, for example
   *      https://portal.yourdomain.com. One dedicated host per environment.
   *      No wildcards, no per-org DNS.
   *   2. BETTER_AUTH_URL — local-dev fallback (e.g. http://lvh.me:3000) when
   *      PORTAL_BASE_URL isn't set. Reuses the Better-Auth env var so a dev
   *      machine doesn't need two URL vars.
   *   3. http://localhost:3000 — last-resort default for the "I forgot to
   *      set anything" case.
   */
  private buildPortalUrl(token: string): string {
    const baseUrl =
      this.configService.get<string>('PORTAL_BASE_URL') ||
      this.configService.get<string>('BETTER_AUTH_URL') ||
      'http://localhost:3000';

    const trimmedBase = baseUrl.replace(/\/$/, '');
    return `${trimmedBase}/r/${token}`;
  }

  private resolveFeatures(requested?: PortalFeature[]): PortalFeature[] {
    if (!requested || requested.length === 0) return PORTAL_FEATURES;
    return requested.filter((f) => PORTAL_FEATURES.includes(f));
  }

  /**
   * Create a single-use portal magic link for a customer.
   */
  async createPortalSession(
    orgId: string,
    dto: CreatePortalSessionDto,
    mintingApiKeyId?: string,
  ): Promise<PortalSessionResponse> {
    if (!dto.customerId && !dto.customerExternalId) {
      throw new BadRequestException('Either customerId or customerExternalId must be provided');
    }

    const customer = await this.prisma.customers.findFirst({
      where: {
        organizationId: orgId,
        ...(dto.customerId ? { id: dto.customerId } : { externalId: dto.customerExternalId }),
      },
    });

    if (!customer) {
      throw new NotFoundException(
        `Customer not found with ${dto.customerId ? 'id' : 'externalId'}: ${
          dto.customerId || dto.customerExternalId
        }`,
      );
    }

    const organization = await this.prisma.organizations.findUnique({
      where: { id: orgId },
      select: { slug: true },
    });

    if (!organization?.slug) {
      throw new BadRequestException(
        'Organization has no slug configured — portal links cannot be generated',
      );
    }

    const token = this.generatePortalToken();
    const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);
    const features = this.resolveFeatures(dto.features);

    // Hash the magic-link token at rest. The raw `token` is kept in
    // memory for the URL + response below; the dashboard redeem route hashes the
    // incoming token to match this stored hash.
    const magicLink = await this.prisma.$transaction(async (tx) => {
      // Race closer: this filtered UPDATE takes the same api_keys row
      // lock the revoke door takes, so a mint racing a revoke serializes — if
      // the revoke wins, the WHERE no longer matches and the mint refuses.
      if (mintingApiKeyId) {
        const claimed = await tx.api_keys.updateMany({
          where: { id: mintingApiKeyId, status: 'active', deletedAt: null },
          data: { lastUsedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw new UnauthorizedException(
            "That API key was revoked, so this portal link wasn't created. Create a new secret key and retry.",
          );
        }
      }
      return tx.portal_magic_links.create({
        data: {
          customerId: customer.id,
          organizationId: orgId,
          token: hashApiKeyForLookup(token),
          expiresAt,
        },
      });
    });

    const url = this.buildPortalUrl(token);

    return {
      id: magicLink.id,
      object: 'portal_session',
      url,
      token,
      customerId: customer.id,
      customerName: customer.name || undefined,
      customerEmail: customer.email || undefined,
      expiresAt,
      features,
      returnUrl: dto.returnUrl,
      createdAt: magicLink.createdAt,
    };
  }

  /**
   * Get a portal session (magic link) by ID.
   */
  async getPortalSession(orgId: string, sessionId: string): Promise<PortalSessionResponse | null> {
    const magicLink = await this.prisma.portal_magic_links.findFirst({
      where: { id: sessionId, organizationId: orgId },
      include: {
        customers: { select: { id: true, name: true, email: true } },
        organizations: { select: { slug: true } },
      },
    });

    if (!magicLink || !magicLink.customers || !magicLink.organizations?.slug) {
      return null;
    }

    // Token is stored hashed, so the raw redeem URL/token cannot be
    // rebuilt here — they're surfaced once at creation only (same stance as
    // listPortalSessions). GET returns metadata only.
    return {
      id: magicLink.id,
      object: 'portal_session',
      customerId: magicLink.customerId,
      customerName: magicLink.customers.name || undefined,
      customerEmail: magicLink.customers.email || undefined,
      expiresAt: magicLink.expiresAt,
      features: PORTAL_FEATURES,
      createdAt: magicLink.createdAt,
    };
  }

  /**
   * Revoke a portal session.
   *
   * Hard-delete on the magic link — single-use semantics already cap the
   * exposure window at 1 hour, so there is no soft-delete or audit column.
   */
  async revokePortalSession(orgId: string, sessionId: string): Promise<void> {
    const magicLink = await this.prisma.portal_magic_links.findFirst({
      where: { id: sessionId, organizationId: orgId },
    });

    if (!magicLink) {
      throw new NotFoundException(`Portal session not found: ${sessionId}`);
    }

    await this.prisma.portal_magic_links.delete({
      where: { id: sessionId },
    });
  }

  /**
   * List portal sessions (magic links).
   *
   * Token is intentionally OMITTED from the response — the token is only
   * surfaced once at creation. List/get expose metadata only.
   */
  async listPortalSessions(
    orgId: string,
    customerId?: string,
    options?: { limit?: number | string; includeExpired?: boolean | string },
  ) {
    const rawLimit = options?.limit;
    let limit = 10;
    if (typeof rawLimit === 'string' && rawLimit) {
      const parsed = parseInt(rawLimit, 10);
      if (!isNaN(parsed)) limit = parsed;
    } else if (typeof rawLimit === 'number' && !isNaN(rawLimit)) {
      limit = rawLimit;
    }
    const includeExpired = options?.includeExpired === true || options?.includeExpired === 'true';

    const where: any = { organizationId: orgId };
    if (customerId) where.customerId = customerId;
    if (!includeExpired) where.expiresAt = { gt: new Date() };

    const magicLinks = await this.prisma.portal_magic_links.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        customers: { select: { id: true, name: true, email: true } },
      },
    });

    const now = new Date();
    return magicLinks.map((m) => ({
      id: m.id,
      object: 'portal_session' as const,
      customerId: m.customerId,
      customerName: m.customers?.name,
      customerEmail: m.customers?.email,
      expiresAt: m.expiresAt,
      isExpired: m.expiresAt < now,
      isUsed: !!m.usedAt,
      usedAt: m.usedAt,
      createdAt: m.createdAt,
      features: PORTAL_FEATURES,
    }));
  }
}
