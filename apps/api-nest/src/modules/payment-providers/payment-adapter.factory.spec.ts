/**
 * PaymentAdapterFactory: a payment_providers row becomes a StripeAdapter, whether it holds
 * the organization's own secret key or a Stripe Connect account ID. Any other provider type,
 * and any credentials that are not an encryption envelope, are refused.
 */
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

const stripeMockInstance = {
  checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
  refunds: { create: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => jest.fn().mockImplementation(() => stripeMockInstance));

import { PaymentAdapterFactory } from './payment-adapter.factory';
import { CryptoService } from '../../common/crypto/crypto.service';
import { StripeAdapter } from './adapters/stripe.adapter';

function buildCrypto(): CryptoService {
  const config = {
    get: jest.fn((name: string) =>
      name === 'ENCRYPTION_KEY' ? randomBytes(32).toString('base64') : undefined,
    ),
  } as unknown as ConfigService;
  const crypto = new CryptoService(config);
  crypto.onModuleInit();
  return crypto;
}

function buildConfig(values: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: jest.fn((name: string) => values[name]),
  } as unknown as ConfigService;
}

describe('PaymentAdapterFactory: Stripe', () => {
  it('own secret key builds a StripeAdapter', () => {
    const crypto = buildCrypto();
    const factory = new PaymentAdapterFactory(buildConfig({}), crypto);

    const adapter = factory.createAdapter({
      id: 'pp-1',
      type: 'stripe',
      encrypted_secrets: crypto.encrypt(JSON.stringify({ secretKey: 'sk_test_merchant_key' })),
    });

    expect(adapter).toBeInstanceOf(StripeAdapter);
    expect(adapter.providerType).toBe('stripe');
  });

  it('Stripe Connect account ID builds a StripeAdapter on the platform key', () => {
    const crypto = buildCrypto();
    const factory = new PaymentAdapterFactory(
      buildConfig({ STRIPE_SECRET_KEY: 'sk_test_platform' }),
      crypto,
    );

    const adapter = factory.createAdapter({
      id: 'pp-2',
      type: 'stripe',
      encrypted_secrets: crypto.encrypt(JSON.stringify({ stripeConnectAccountId: 'acct_xyz' })),
    });

    expect(adapter).toBeInstanceOf(StripeAdapter);
  });
});

describe('PaymentAdapterFactory: refusals', () => {
  it('unsupported provider type throws a helpful BadRequestException', () => {
    const crypto = buildCrypto();
    const factory = new PaymentAdapterFactory(buildConfig({}), crypto);

    expect(() =>
      factory.createAdapter({
        id: 'pp-6',
        type: 'square',
        encrypted_secrets: crypto.encrypt(JSON.stringify({ apiKey: 'x' })),
      }),
    ).toThrow(/not supported/i);
  });

  it('refuses secrets that are not an encryption envelope', () => {
    const crypto = buildCrypto();
    const factory = new PaymentAdapterFactory(buildConfig({}), crypto);

    expect(() =>
      factory.createAdapter({
        id: 'pp-7',
        type: 'stripe',
        encrypted_secrets: JSON.stringify({ secretKey: 'sk_test_plain' }),
      }),
    ).toThrow(/not encrypted/);
  });
});
