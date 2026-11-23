/**
 * Payment Adapter Factory
 *
 * Turns a payment_providers row into an adapter the billing code can call.
 * Stripe is the one provider in this repo. To add another, implement
 * PaymentAdapter and return it from createAdapter for your provider type.
 *
 * Adapters are created per request (not singletons) because each
 * organization has different API keys.
 */
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PaymentAdapter } from './interfaces';
import { StripeAdapter } from './adapters/stripe.adapter';

@Injectable()
export class PaymentAdapterFactory {
  constructor(
    private readonly configService: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * @param provider - The payment_providers row from the database
   * @returns A PaymentAdapter ready to process payments
   */
  createAdapter(provider: {
    id?: string;
    type: string;
    encrypted_secrets: string | any;
  }): PaymentAdapter {
    if (provider.type !== 'stripe') {
      throw new BadRequestException(
        `Payment provider "${provider.type}" is not supported. Stripe is the only provider ` +
          'this API can charge through. Connect Stripe in Settings > Integrations.',
      );
    }
    return new StripeAdapter(this.parseSecrets(provider), this.configService);
  }

  /**
   * Build a Stripe adapter from the platform's own STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
   * These come from the environment, not a payment_providers row, so they are never encrypted.
   */
  createPlatformStripeAdapter(secrets: {
    secretKey: string;
    webhookSecret: string;
  }): PaymentAdapter {
    return new StripeAdapter(secrets, this.configService);
  }

  /**
   * Decode the encrypted_secrets field from the database into the plaintext secrets the
   * adapter needs. The value must be a v1 AES-256-GCM envelope; anything else is refused.
   */
  private parseSecrets(provider: {
    id?: string;
    encrypted_secrets: string | any;
  }): Record<string, string> {
    const raw = provider.encrypted_secrets;
    if (!raw) {
      return {};
    }

    if (typeof raw !== 'string' || !this.crypto.isEncrypted(raw)) {
      throw new Error(
        `The saved credentials for payment provider ${provider.id ?? 'unknown'} are not encrypted, ` +
          'so they were not used. This happens when a row was written outside the API. ' +
          'Fix: remove the provider and connect it again in the dashboard so the API stores ' +
          'its credentials encrypted.',
      );
    }

    const plaintextJson = this.crypto.decrypt(raw);
    try {
      return JSON.parse(plaintextJson);
    } catch {
      throw new Error(
        `The saved credentials for payment provider ${provider.id ?? 'unknown'} decrypted to ` +
          'something that is not valid JSON, so they were not used. Fix: remove the provider ' +
          'and connect it again in the dashboard.',
      );
    }
  }
}
