import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto';
import { isSafePublicHttpsUrl } from '../pdf/pdf-url-safety';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
// The key minted at org creation stores the deterministic lookup hash, or it
// could not authenticate via the hash path. Same shared helper as the verify path.
import { hashApiKeyForLookup } from '@marginfront/db';
// The projection writes and the last-owner lock live in @marginfront/db
// (packages/db/src/lib/membership.ts) because the DASHBOARD writes membership too,
// through its own Server Actions that never reach api-nest. One implementation, so
// the two apps cannot disagree about what a projected role is.
import {
  countOwnersForUpdate,
  deleteMembershipProjections,
  setDefaultOrganization,
  writeMembershipProjections,
} from '@marginfront/db';

const SALT_ROUNDS = 10;
const KEY_PREFIXES = {
  secret: 'mf_sk_',
  publishable: 'mf_pk_',
};

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get the user's organizations, with role and default info.
   *
   * Membership and role come from the CANONICAL `ba_member` table. `user_organizations`
   * is read only for the two columns `ba_member` has no equivalent of: `isDefault` and
   * `joinedAt`. A member with no projection row still appears here; they sort last and report
   * their `ba_member.createdAt` as the join date.
   */
  async getCurrentOrganization(userId: string, _userOrgId?: string) {
    if (!userId) {
      throw new NotFoundException('User ID is required');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        current_organization_id: true,
        organizationId: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const memberships = await this.prisma.ba_member.findMany({
      where: { userId },
      include: {
        organizations: {
          select: {
            id: true,
            name: true,
            organizationInfo: true,
            website: true,
            linkedin: true,
            logo: true,
            timezone: true,
            tagline: true,
            address_line1: true,
            address_line2: true,
            city: true,
            state: true,
            zip_code: true,
            country: true,
            billing_email: true,
            billing_phone: true,
            default_currency: true,
            onboarding_complete: true,
            dashboard_mode: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) {
      return {
        hasOrg: false,
        organization: null,
        organizations: [],
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      };
    }

    // Preference only, never membership: an org missing from this list is still an org the user
    // belongs to.
    const preferences = await this.prisma.user_organizations.findMany({
      where: { userId },
      select: { organizationId: true, isDefault: true, joinedAt: true },
    });
    const preferenceByOrgId = new Map(preferences.map((p) => [p.organizationId, p]));

    const orgs = memberships.map((membership) => {
      const preference = preferenceByOrgId.get(membership.organizationId);
      return {
        ...membership.organizations,
        role: membership.role,
        isDefault: preference?.isDefault ?? false,
        joinedAt: preference?.joinedAt ?? membership.createdAt,
        onboardingComplete: membership.organizations.onboarding_complete,
      };
    });

    // Default org first. Array.prototype.sort is stable, so orgs that tie keep the ba_member
    // createdAt ordering the query above established.
    orgs.sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false));

    // Determine current organization
    // Priority: 1) current_organization_id, 2) isDefault=true, 3) first org
    let currentOrg = orgs.find((org) => org.id === user.current_organization_id);
    if (!currentOrg) {
      currentOrg = orgs.find((org) => org.isDefault) || orgs[0];
    }

    return {
      hasOrg: true,
      organization: currentOrg,
      organizations: orgs,
      orgs: orgs, // Same list as `organizations`, under the name the dashboard reads
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }

  async getOrganizationById(orgId: string) {
    const organization = await this.prisma.organizations.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        organizationInfo: true,
        website: true,
        linkedin: true,
        logo: true,
        timezone: true,
        tagline: true,
        address_line1: true,
        address_line2: true,
        city: true,
        state: true,
        zip_code: true,
        country: true,
        billing_email: true,
        billing_phone: true,
        default_currency: true,
        dashboard_mode: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return {
      organization,
    };
  }

  private generateSecureApiKey(keyType: 'secret' | 'publishable'): string {
    const prefix = KEY_PREFIXES[keyType];
    const randomBytes = crypto.randomBytes(24).toString('base64url');
    return `${prefix}${randomBytes}`;
  }

  private async hashApiKey(apiKey: string): Promise<string> {
    return bcrypt.hash(apiKey, SALT_ROUNDS);
  }

  private validateLogoUrl(logo: unknown): void {
    if (logo === undefined || logo === null || logo === '') {
      return;
    }
    if (!isSafePublicHttpsUrl(logo as string)) {
      throw new BadRequestException(
        'Logo URL was rejected because it must be a public https:// address. Provide an https:// URL hosted on a public domain or omit the logo field.',
      );
    }
  }

  /**
   * Create an organization with the caller as owner and one publishable API key.
   */
  async createOrganization(userId: string, createDto: CreateOrganizationDto) {
    if (!userId) {
      throw new BadRequestException('User ID is required');
    }

    this.validateLogoUrl(createDto.logo);

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const existingDefaultOrg = await this.prisma.user_organizations.findFirst({
      where: {
        userId,
        isDefault: true,
      },
    });

    // Pre-generate the publishable key before the transaction (hashing is async).
    // Org creation mints no secret key: secret keys are created only by the
    // user from the API Keys page, and onboarding provisions no keys at all.
    const publishableKey = this.generateSecureApiKey('publishable');
    const publishableKeyHash = await this.hashApiKey(publishableKey);

    // The organization, the owner's membership and the publishable key in one transaction
    const result = await this.prisma.$transaction(async (prisma) => {
      const orgId = crypto.randomUUID();
      const now = new Date();

      const organization = await prisma.organizations.create({
        data: {
          id: orgId,
          name: createDto.name,
          organizationInfo: createDto.organizationInfo,
          website: createDto.website,
          linkedin: createDto.linkedin,
          logo: createDto.logo,
          timezone: createDto.timezone || 'UTC',
          tagline: createDto.tagline,
          address_line1: createDto.address_line1,
          address_line2: createDto.address_line2,
          city: createDto.city,
          state: createDto.state,
          zip_code: createDto.zip_code,
          country: createDto.country,
          billing_email: createDto.billing_email,
          billing_phone: createDto.billing_phone,
          default_currency: createDto.default_currency || 'USD',
          owner_id: userId,
          createdAt: now,
          updatedAt: now,
        },
      });

      // The CANONICAL owner row, written FIRST. Without it the creator is a stranger
      // to OrgRoleGuard, OrgAccessGuard and the team API on the org they just
      // made, because none of those read the projection the mirrors below write.
      await prisma.ba_member.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: organization.id,
          userId,
          role: 'owner',
          createdAt: now,
        },
      });

      await writeMembershipProjections(prisma, {
        organizationId: organization.id,
        userId,
        role: 'owner',
      });

      // Only if the user has no default org yet — an existing one is their choice and this is
      // not the place to overrule it. setDefaultOrganization is the ONE writer of `isDefault`.
      // The flag is one-per-user, so setting it here means clearing it on every
      // other org, and a helper that could set it per-membership would sooner or later leave a
      // user with two.
      if (!existingDefaultOrg) {
        await setDefaultOrganization(prisma, {
          organizationId: organization.id,
          userId,
          role: 'owner',
        });
      }

      await prisma.users.update({
        where: { id: userId },
        data: {
          current_organization_id: organization.id,
          organizationId: organization.id, // Mirror of current_organization_id
        },
      });

      // No secret key minted here (see note above).
      const keyName = `Default Keys`;

      const publishableApiKey = await prisma.api_keys.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: organization.id,
          createdById: userId,
          name: `${keyName} (Publishable)`,
          description: 'Auto-generated on organization creation',
          apiKeyHash: publishableKeyHash,
          apiKeyPlaintext: publishableKey,
          apiKeyLookupHash: hashApiKeyForLookup(publishableKey),
          status: 'active',
          keyType: 'publishable',
          keyPrefix: KEY_PREFIXES.publishable,
          // Every key carries a role: parseKeyRole floors a role-less key to 'ingest'.
          // 'member' matches ApiKeysService.PUBLISHABLE_KEY_ROLE and widens nothing: a
          // publishable key's write block is keyType-based, not role-based.
          permissions: { role: 'member', minterUserId: userId, minterRole: 'owner' },
          lastUsedAt: null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      return {
        organization,
        apiKeys: {
          publishableKey: {
            id: publishableApiKey.id,
            name: publishableApiKey.name,
            key: publishableKey, // Safe to expose
            keyType: 'publishable',
          },
        },
      };
    });

    return {
      organization: result.organization,
      apiKeys: result.apiKeys,
      message: 'Organization created successfully.',
    };
  }

  async updateOrganization(userId: string, orgId: string, updateDto: UpdateOrganizationDto) {
    if (!userId) {
      throw new BadRequestException('User ID is required');
    }

    // Owner check against the CANONICAL ba_member row, the table OrgRoleGuard
    // reads.
    //
    // The `!userId` guard above is load-bearing: Prisma DROPS a `where` field whose value is
    // `undefined`, so `{ organizationId, userId: undefined, role: 'owner' }` would degenerate to
    // "any owner of the target org". Same fail-closed shape as OrgRoleGuard.
    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId: orgId, userId },
      select: { role: true },
    });

    if (membership?.role !== 'owner') {
      throw new ForbiddenException('You must be an owner to update this organization');
    }

    this.validateLogoUrl(updateDto.logo);

    const organization = await this.prisma.organizations.update({
      where: { id: orgId },
      data: {
        name: updateDto.name,
        organizationInfo: updateDto.organizationInfo,
        website: updateDto.website,
        linkedin: updateDto.linkedin,
        logo: updateDto.logo,
        timezone: updateDto.timezone,
        tagline: updateDto.tagline,
        address_line1: updateDto.address_line1,
        address_line2: updateDto.address_line2,
        city: updateDto.city,
        state: updateDto.state,
        zip_code: updateDto.zip_code,
        country: updateDto.country,
        billing_email: updateDto.billing_email,
        billing_phone: updateDto.billing_phone,
        default_currency: updateDto.default_currency,
        dashboard_mode: updateDto.dashboard_mode,
      },
    });

    return {
      organization,
      message: 'Organization updated successfully',
    };
  }

  async switchOrganization(userId: string, orgId: string) {
    if (!userId) {
      throw new BadRequestException('User ID is required');
    }

    // This route carries no OrgRoleGuard — this lookup IS the authorization boundary (noted in
    // org-id-param.route-sweep.spec.ts), so it must consult the same table the guards do. See
    // updateOrganization for why the `!userId` guard above must stay.
    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId: orgId, userId },
      select: { role: true },
    });

    if (!membership) {
      throw new NotFoundException('You are not a member of this organization');
    }

    const organization = await this.prisma.organizations.findUnique({
      where: { id: orgId },
      select: { onboarding_complete: true },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.onboarding_complete === false) {
      throw new BadRequestException(
        'Cannot switch to an organization with incomplete onboarding. Please complete the onboarding first.',
      );
    }

    // The default-org bookkeeping lives entirely in user_organizations (ba_member has no
    // isDefault column). One transaction so a user can never end up with two default orgs, or
    // none, if the second write fails.
    await this.prisma.$transaction(async (tx) => {
      await setDefaultOrganization(tx, {
        organizationId: orgId,
        userId,
        role: membership.role,
      });

      await tx.users.update({
        where: { id: userId },
        data: {
          current_organization_id: orgId,
          organizationId: orgId, // Mirror of current_organization_id
        },
      });
    });

    return {
      message: 'Default organization updated successfully',
    };
  }

  /**
   * Remove the CALLING OWNER from an organization. Despite the route name, the organization is
   * never deleted and no other member is touched — this is "leave the org", restricted to owners.
   *
   * All three membership rows go, in one transaction, under the same last-owner lock the team
   * API uses. Deleting only `user_organizations` would leave the caller's canonical `ba_member`
   * row — and therefore full owner access — in place.
   */
  async deleteOrganization(userId: string, orgId: string) {
    if (!userId) {
      throw new BadRequestException('User ID is required');
    }

    // Owner check against the CANONICAL row. See updateOrganization for why `!userId` above is
    // load-bearing (Prisma drops undefined `where` fields).
    const membership = await this.prisma.ba_member.findFirst({
      where: { organizationId: orgId, userId },
      select: { id: true, role: true },
    });

    if (membership?.role !== 'owner') {
      throw new ForbiddenException('You must be an owner to delete this organization');
    }

    await this.prisma.$transaction(async (tx) => {
      // Refuse when the caller is the last owner: deleting the canonical row would orphan
      // the org.
      const ownerCount = await countOwnersForUpdate(tx, orgId);
      if (ownerCount <= 1) {
        throw new ForbiddenException(
          'You are the last owner of this organization. Promote another member to owner before leaving.',
        );
      }

      await tx.ba_member.delete({ where: { id: membership.id } });
      await deleteMembershipProjections(tx, { organizationId: orgId, userId });
    });

    // Best-effort, outside the transaction and on a different table, exactly as
    // TeamService.removeMember does it — with the same residual: a stateless human JWT is not
    // stored in ba_session, so one minted before this call works until it expires.
    await this.prisma.ba_session.deleteMany({
      where: { userId, activeOrganizationId: orgId },
    });

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { current_organization_id: true },
    });

    if (user?.current_organization_id === orgId) {
      await this.prisma.users.update({
        where: { id: userId },
        data: {
          current_organization_id: null,
          organizationId: null,
        },
      });
    }

    return {
      message: 'Organization removed successfully',
    };
  }
}
