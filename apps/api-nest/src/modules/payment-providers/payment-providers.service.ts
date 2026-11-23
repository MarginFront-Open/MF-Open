import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { CreatePaymentProviderDto } from './dto/create-payment-provider.dto';
import { UpdatePaymentProviderDto } from './dto/update-payment-provider.dto';
import { randomUUID } from 'crypto';

@Injectable()
export class PaymentProvidersService {
  constructor(
    private prisma: PrismaService,
    // Encrypts secrets at rest before write. Read-side decryption happens in
    // PaymentAdapterFactory.parseSecrets.
    private crypto: CryptoService,
  ) {}

  async create(organizationId: string, createDto: CreatePaymentProviderDto) {
    if (createDto.type === 'stripe' && !createDto.apiKey) {
      throw new BadRequestException('API key is required for Stripe providers');
    }

    if (createDto.isDefault) {
      await this.prisma.payment_providers.updateMany({
        where: { organization_id: organizationId, is_default: true },
        data: { is_default: false, updated_at: new Date() },
      });
    }

    const secrets = {
      apiKey: createDto.apiKey,
      secretKey: createDto.secretKey,
      webhookSecret: createDto.webhookSecret,
    };

    const now = new Date();
    const provider = await this.prisma.payment_providers.create({
      data: {
        id: randomUUID(),
        organization_id: organizationId,
        type: createDto.type,
        name: createDto.name || createDto.type,
        code: createDto.code || createDto.type,
        // AES-256-GCM envelope. See CryptoService + crypto-core.ts. Format on disk:
        // v1:<base64-iv>:<base64-ciphertext>:<base64-authTag>
        encrypted_secrets: this.crypto.encrypt(JSON.stringify(secrets)),
        is_default: createDto.isDefault ?? false,
        is_active: true,
        settings: createDto.settings || {},
        created_at: now,
        updated_at: now,
      },
    });

    return provider;
  }

  /**
   * Takes a plaintext JSON secrets blob and writes back an encrypted envelope to the row.
   * Idempotent: calling it on an already-encrypted row still works (the next read
   * decrypts cleanly) and produces a fresh IV.
   */
  async reEncryptSecrets(providerId: string, plaintextSecretsJson: string): Promise<void> {
    await this.prisma.payment_providers.update({
      where: { id: providerId },
      data: {
        encrypted_secrets: this.crypto.encrypt(plaintextSecretsJson),
        updated_at: new Date(),
      },
    });
  }

  /**
   * Register a payment_providers row for a Stripe Connect OAuth
   * connection. The row carries no per-merchant API key — the Stripe adapter detects the
   * `stripeConnectAccountId` field in the (encrypted) secrets envelope and routes calls
   * through the platform's STRIPE_SECRET_KEY plus a `Stripe-Account` header.
   *
   * Why we need a payment_providers row at all (the org already has stripe_connect_account_id):
   * the rest of the payment-processing pipeline (`getActiveProvider`, invoice payments,
   * webhooks) keys off payment_providers. Without a row here, OAuth-connected merchants
   * would see "no active payment provider" at checkout time.
   *
   * Idempotent: if an OAuth-sourced Stripe row already exists for the org, update it
   * instead of creating a duplicate.
   */
  async upsertStripeConnectProvider(
    organizationId: string,
    stripeConnectAccountId: string,
  ): Promise<void> {
    const existing = await this.prisma.payment_providers.findFirst({
      where: {
        organization_id: organizationId,
        type: 'stripe',
        deleted_at: null,
      },
    });

    const encryptedSecrets = this.crypto.encrypt(JSON.stringify({ stripeConnectAccountId }));
    const settings = { source: 'oauth', stripeConnectAccountId };
    const now = new Date();

    if (existing) {
      await this.prisma.payment_providers.update({
        where: { id: existing.id },
        data: {
          encrypted_secrets: encryptedSecrets,
          settings,
          is_active: true,
          updated_at: now,
        },
      });
      return;
    }

    // No existing Stripe row — also clear any other default flag for this org so the new
    // OAuth provider becomes the default.
    await this.prisma.payment_providers.updateMany({
      where: { organization_id: organizationId, is_default: true },
      data: { is_default: false, updated_at: now },
    });

    await this.prisma.payment_providers.create({
      data: {
        id: randomUUID(),
        organization_id: organizationId,
        type: 'stripe',
        name: 'Stripe (Connected)',
        code: 'stripe_connect',
        encrypted_secrets: encryptedSecrets,
        is_default: true,
        is_active: true,
        settings,
        created_at: now,
        updated_at: now,
      },
    });
  }

  async findAll(organizationId: string) {
    const providers = await this.prisma.payment_providers.findMany({
      where: { organization_id: organizationId },
      orderBy: { created_at: 'desc' },
    });

    return providers.map(({ encrypted_secrets: _encrypted_secrets, ...provider }) => provider);
  }

  async findOne(organizationId: string, providerId: string) {
    const provider = await this.prisma.payment_providers.findFirst({
      where: {
        id: providerId,
        organization_id: organizationId,
      },
    });

    if (!provider) {
      throw new NotFoundException('Payment provider not found');
    }

    const { encrypted_secrets: _encrypted_secrets, ...rest } = provider;
    return rest;
  }

  async update(organizationId: string, providerId: string, updateDto: UpdatePaymentProviderDto) {
    const provider = await this.prisma.payment_providers.findFirst({
      where: {
        id: providerId,
        organization_id: organizationId,
      },
    });

    if (!provider) {
      throw new NotFoundException('Payment provider not found');
    }

    if (updateDto.isDefault) {
      await this.prisma.payment_providers.updateMany({
        where: { organization_id: organizationId, is_default: true, id: { not: providerId } },
        data: { is_default: false },
      });
    }

    const dataToUpdate: any = { updated_at: new Date() };
    if (updateDto.name) dataToUpdate.name = updateDto.name;
    if (updateDto.isDefault !== undefined) dataToUpdate.is_default = updateDto.isDefault;
    if (updateDto.isActive !== undefined) dataToUpdate.is_active = updateDto.isActive;
    if (updateDto.settings) dataToUpdate.settings = updateDto.settings;

    const updated = await this.prisma.payment_providers.update({
      where: { id: providerId },
      data: dataToUpdate,
    });

    return updated;
  }

  async remove(organizationId: string, providerId: string) {
    const provider = await this.prisma.payment_providers.findFirst({
      where: {
        id: providerId,
        organization_id: organizationId,
      },
    });

    if (!provider) {
      throw new NotFoundException('Payment provider not found');
    }

    // When removing an OAuth-sourced Stripe provider, also clear the
    // mirror fields on the organization. Without this, the org row still claims a Stripe
    // Connect account and `generateOAuthUrl` refuses to start a new flow ("already connected"),
    // but the actual payment_providers row that powered checkout is gone — broken middle state.
    //
    // We don't call Stripe's deauthorize endpoint here (that lives on /stripe-connect/disconnect
    // and needs the platform's STRIPE_SECRET_KEY + STRIPE_CONNECT_CLIENT_ID). The merchant can
    // revoke fully from their Stripe Dashboard; clearing our mirror is enough to let them
    // reconnect cleanly from the integrations modal.
    const settings = (provider.settings as { source?: string } | null) ?? {};
    if (provider.type === 'stripe' && settings.source === 'oauth') {
      await this.prisma.organizations.update({
        where: { id: organizationId },
        data: {
          stripe_connect_account_id: null,
          stripe_connect_status: null,
          stripe_connect_type: null,
          stripe_connect_charges_enabled: false,
          stripe_connect_details_submitted: false,
          updatedAt: new Date(),
        },
      });
    }

    await this.prisma.payment_providers.delete({
      where: { id: providerId },
    });
  }
}
