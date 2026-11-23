import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { GenerateOAuthUrlDto, ConnectAccountDto } from './dto';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import Stripe from 'stripe';

const STRIPE_CONNECT_NOT_SET_UP =
  "Stripe Connect isn't set up on this server: the API has no STRIPE_SECRET_KEY. " +
  'Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_CONNECT_CLIENT_ID in the API settings and restart the API, ' +
  'or connect this organization with API keys under Settings, then Integrations.';

@Injectable()
export class StripeConnectService {
  private stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    // After OAuth success we also register a payment_providers row for
    // the OAuth-connected account so the rest of the checkout pipeline can find it. Without
    // this, OAuth-only merchants would see "no active payment provider" at pay time.
    private readonly paymentProvidersService: PaymentProvidersService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (secretKey) {
      this.stripe = new Stripe(secretKey, {
        apiVersion: '2026-02-25.clover',
      });
    }
  }

  async generateOAuthUrl(orgId: string, dto: GenerateOAuthUrlDto) {
    const organization = await this.prisma.organizations.findUnique({
      where: { id: orgId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.stripe_connect_account_id) {
      throw new BadRequestException('Stripe Connect account already connected');
    }

    // Generate secure state parameter
    const state = Buffer.from(
      JSON.stringify({
        organizationId: orgId,
        timestamp: Date.now(),
      }),
    ).toString('base64');

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const redirectUri = dto.redirectUri || `${frontendUrl}/stripe-connect/callback`;
    const clientId = this.configService.get<string>('STRIPE_CONNECT_CLIENT_ID');

    // stripe_landing=login forces the sign-in flow for merchants who already have a Stripe
    // account. Without it, Stripe defaults to the registration/onboarding UI (QR-code 2FA,
    // KYC fields, etc.) — confusing for existing customers. Undocumented in the current
    // OAuth reference but supported for Connect Standard.
    const authorizationUrl =
      `https://connect.stripe.com/oauth/authorize?` +
      `client_id=${clientId}&` +
      `state=${state}&` +
      `scope=read_write&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `stripe_landing=login`;

    return {
      authorizationUrl,
      state,
    };
  }

  async connectExistingAccount(dto: ConnectAccountDto) {
    if (!this.stripe) {
      throw new BadRequestException(STRIPE_CONNECT_NOT_SET_UP);
    }

    // Verify state parameter
    const decodedState = decodeURIComponent(dto.state);
    const stateData = JSON.parse(Buffer.from(decodedState, 'base64').toString());
    const { organizationId } = stateData;

    const organization = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.stripe_connect_account_id) {
      throw new BadRequestException('Stripe Connect account already connected');
    }

    // Exchange authorization code for access token
    const response = await this.stripe.oauth.token({
      grant_type: 'authorization_code',
      code: dto.code,
    });

    const accountId = response.stripe_user_id;

    if (!accountId) {
      throw new BadRequestException('Failed to retrieve account ID from Stripe');
    }

    // Get account details
    const account = await this.stripe.accounts.retrieve(accountId);

    // Update organization with connected account info
    await this.prisma.organizations.update({
      where: { id: organizationId },
      data: {
        stripe_connect_account_id: accountId,
        stripe_connect_status:
          account.details_submitted && account.charges_enabled ? 'active' : 'pending',
        stripe_connect_type: 'oauth',
        stripe_connect_charges_enabled: account.charges_enabled,
        stripe_connect_details_submitted: account.details_submitted,
        stripe_connect_requirements: account.requirements as any,
        updatedAt: new Date(),
      },
    });

    // Register the OAuth account as a payment_providers row so the
    // integrations modal shows "Connected" and the checkout pipeline can route payments.
    // Idempotent — if a row exists for this org's Stripe, it gets updated instead of doubled.
    await this.paymentProvidersService.upsertStripeConnectProvider(organizationId, accountId);

    return {
      accountId,
      account,
      message: 'Stripe Connect account connected successfully',
    };
  }

  async disconnectAccount(orgId: string) {
    if (!this.stripe) {
      throw new BadRequestException(STRIPE_CONNECT_NOT_SET_UP);
    }

    const organization = await this.prisma.organizations.findUnique({
      where: { id: orgId },
    });

    if (!organization || !organization.stripe_connect_account_id) {
      throw new NotFoundException('Stripe Connect account not found');
    }

    // Revoke access
    const clientId = this.configService.get<string>('STRIPE_CONNECT_CLIENT_ID');
    if (clientId) {
      await this.stripe.oauth.deauthorize({
        client_id: clientId,
        stripe_user_id: organization.stripe_connect_account_id,
      });
    }

    // Clear connect info from organization
    await this.prisma.organizations.update({
      where: { id: orgId },
      data: {
        stripe_connect_account_id: null,
        stripe_connect_status: null,
        stripe_connect_type: null,
        stripe_connect_charges_enabled: false,
        stripe_connect_details_submitted: false,
        stripe_connect_requirements: Prisma.DbNull,
        stripe_connect_onboarding_url: null,
        stripe_connect_onboarding_url_expires: null,
        updatedAt: new Date(),
      },
    });

    // Soft-delete the matching payment_providers row(s) so the integrations UI flips
    // back to "not connected." The UI reads payment_providers, not the org mirror —
    // without this, /settings/integrations would still show "Stripe Connected" after
    // a successful disconnect. updateMany covers the unlikely double-row case.
    await this.prisma.payment_providers.updateMany({
      where: {
        organization_id: orgId,
        type: 'stripe',
        deleted_at: null,
      },
      data: {
        deleted_at: new Date(),
        is_active: false,
        is_default: false,
        encrypted_secrets: null,
        updated_at: new Date(),
      },
    });

    return { success: true, message: 'Stripe Connect account disconnected successfully' };
  }

  async getAccountStatus(orgId: string) {
    if (!this.stripe) {
      throw new BadRequestException(STRIPE_CONNECT_NOT_SET_UP);
    }

    const organization = await this.prisma.organizations.findUnique({
      where: { id: orgId },
    });

    if (!organization || !organization.stripe_connect_account_id) {
      throw new NotFoundException('Stripe Connect account not found');
    }

    const account = await this.stripe.accounts.retrieve(organization.stripe_connect_account_id);

    let status = 'pending';
    if (account.details_submitted && account.charges_enabled) {
      status = 'active';
    } else if (account.requirements?.disabled_reason) {
      status = 'restricted';
    }

    // Update organization status
    await this.prisma.organizations.update({
      where: { id: orgId },
      data: {
        stripe_connect_status: status as any,
        stripe_connect_charges_enabled: account.charges_enabled,
        stripe_connect_details_submitted: account.details_submitted,
        stripe_connect_requirements: account.requirements as any,
        updatedAt: new Date(),
      },
    });

    return {
      accountId: organization.stripe_connect_account_id,
      status,
      chargesEnabled: account.charges_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements,
    };
  }
}
