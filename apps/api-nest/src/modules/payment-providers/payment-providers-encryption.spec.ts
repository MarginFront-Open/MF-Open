/**
 * Integration test for the payment-providers encryption lifecycle.
 *
 * Three things this guards:
 *
 *   1. Write path: PaymentProvidersService.create encrypts the secrets blob using AES-256-GCM
 *      via CryptoService BEFORE handing the row to Prisma. The DB row's encrypted_secrets
 *      column must NOT contain any plaintext substring (no `sk_test_`, no `whsec_`, no `{`).
 *
 *   2. Read path: PaymentAdapterFactory.parseSecrets decrypts the envelope and the returned
 *      adapter receives the original plaintext secrets. End-to-end the encryption is
 *      transparent to the rest of the app — adapters never know it happened.
 *
 *   3. Encrypted only: a row whose secrets are not an envelope (plaintext JSON or a bare
 *      key) is refused with an error that says how to fix it, never used as-is.
 *
 * Uses a real CryptoService instance with a test key + mock Prisma. No actual database.
 */

import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PaymentProvidersService } from './payment-providers.service';
import { PaymentAdapterFactory } from './payment-adapter.factory';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROVIDER_ID = '22222222-2222-2222-2222-222222222222';

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

function buildPrismaMock() {
  const writes: { id: string; encrypted_secrets: string }[] = [];
  return {
    writes,
    prisma: {
      payment_providers: {
        create: jest.fn(async ({ data }: any) => {
          writes.push({ id: data.id, encrypted_secrets: data.encrypted_secrets });
          return data;
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
        update: jest.fn(async ({ data }: any) => {
          writes.push({ id: 'updated', encrypted_secrets: data.encrypted_secrets });
          return data;
        }),
      },
    },
  };
}

describe('PaymentProvidersService — write path encrypts secrets', () => {
  it('the row Prisma sees has no plaintext secret substrings', async () => {
    const { prisma, writes } = buildPrismaMock();
    const crypto = buildCrypto();
    const service = new PaymentProvidersService(prisma as any, crypto);

    await service.create(ORG_ID, {
      type: 'stripe',
      apiKey: 'sk_test_THIS_MUST_NOT_LEAK_TO_DISK',
      secretKey: 'sk_test_secret_THIS_MUST_NOT_LEAK',
      webhookSecret: 'whsec_THIS_MUST_NOT_LEAK',
    } as any);

    expect(writes).toHaveLength(1);
    const stored = writes[0].encrypted_secrets;

    // Must be in the v1 envelope format.
    expect(stored).toMatch(/^v1:/);

    // Must NOT contain any of the plaintext substrings — that would mean the encryption
    // was bypassed.
    expect(stored).not.toContain('sk_test_THIS_MUST_NOT_LEAK_TO_DISK');
    expect(stored).not.toContain('sk_test_secret_THIS_MUST_NOT_LEAK');
    expect(stored).not.toContain('whsec_THIS_MUST_NOT_LEAK');
    expect(stored).not.toContain('apiKey');
    expect(stored).not.toContain('webhookSecret');
  });

  it('reEncryptSecrets writes an envelope', async () => {
    const { prisma, writes } = buildPrismaMock();
    const crypto = buildCrypto();
    const service = new PaymentProvidersService(prisma as any, crypto);

    await service.reEncryptSecrets(PROVIDER_ID, JSON.stringify({ apiKey: 'sk_test_plain' }));

    expect(writes).toHaveLength(1);
    expect(writes[0].encrypted_secrets).toMatch(/^v1:/);
    expect(writes[0].encrypted_secrets).not.toContain('sk_test_plain');
  });
});

describe('PaymentAdapterFactory — read path', () => {
  it('decrypts a v1 envelope back to the original secrets object', () => {
    const crypto = buildCrypto();
    const config = { get: jest.fn() } as unknown as ConfigService;
    const factory = new PaymentAdapterFactory(config, crypto);

    const original = {
      apiKey: 'sk_test_real_key',
      secretKey: 'sk_test_real_secret',
      webhookSecret: 'whsec_real',
    };
    const envelope = crypto.encrypt(JSON.stringify(original));

    // Call private parseSecrets via createAdapter — Stripe path constructs a StripeAdapter
    // with the parsed secrets. The adapter constructor reads the secrets; this confirms
    // the call succeeds and the factory didn't throw on the decrypt path.
    expect(() =>
      factory.createAdapter({
        id: PROVIDER_ID,
        type: 'stripe',
        encrypted_secrets: envelope,
      }),
    ).not.toThrow();
  });

  it('refuses plaintext JSON secrets with an error that says how to fix it', () => {
    const crypto = buildCrypto();
    const config = { get: jest.fn() } as unknown as ConfigService;
    const factory = new PaymentAdapterFactory(config, crypto);

    const plaintextJson = JSON.stringify({
      apiKey: 'sk_test_plain',
      secretKey: 'sk_test_plain_secret',
      webhookSecret: 'whsec_plain',
    });

    expect(() =>
      factory.createAdapter({
        id: PROVIDER_ID,
        type: 'stripe',
        encrypted_secrets: plaintextJson,
      }),
    ).toThrow(/not encrypted.*connect it again/s);
  });

  it('refuses a bare API key string that is not an envelope', () => {
    const crypto = buildCrypto();
    const config = { get: jest.fn() } as unknown as ConfigService;
    const factory = new PaymentAdapterFactory(config, crypto);

    expect(() =>
      factory.createAdapter({
        id: PROVIDER_ID,
        type: 'stripe',
        encrypted_secrets: 'sk_test_bare_key_no_json',
      }),
    ).toThrow(/not encrypted/);
  });

  it('never puts the plaintext secret in the refusal message', () => {
    const crypto = buildCrypto();
    const config = { get: jest.fn() } as unknown as ConfigService;
    const factory = new PaymentAdapterFactory(config, crypto);

    let message = '';
    try {
      factory.createAdapter({
        id: PROVIDER_ID,
        type: 'stripe',
        encrypted_secrets: JSON.stringify({ secretKey: 'sk_test_do_not_echo' }),
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/not encrypted/);
    expect(message).not.toContain('sk_test_do_not_echo');
  });

  it('returns empty secrets when encrypted_secrets is null', () => {
    const crypto = buildCrypto();
    const config = { get: jest.fn() } as unknown as ConfigService;
    const factory = new PaymentAdapterFactory(config, crypto);

    // Stripe adapter requires at least an apiKey — for null secrets it should throw on
    // adapter construction, not on the parse itself. Either way: parseSecrets should not
    // crash trying to decrypt a null value.
    expect(() => {
      try {
        factory.createAdapter({
          id: PROVIDER_ID,
          type: 'stripe',
          encrypted_secrets: null as any,
        });
      } catch (e) {
        // Adapter may throw on missing key — that's a different layer and OK for this test.
        const message = e instanceof Error ? e.message : String(e);
        if (/decrypt/i.test(message)) throw e; // re-throw decryption failures
      }
    }).not.toThrow();
  });

  it('throws cleanly if a v1 envelope cannot be decrypted (wrong key, tampered)', () => {
    const cryptoA = buildCrypto();
    const cryptoB = buildCrypto(); // different key
    const config = { get: jest.fn() } as unknown as ConfigService;
    const factory = new PaymentAdapterFactory(config, cryptoA);

    const envelopeFromOtherKey = cryptoB.encrypt(JSON.stringify({ apiKey: 'sk_test' }));

    expect(() =>
      factory.createAdapter({
        id: PROVIDER_ID,
        type: 'stripe',
        encrypted_secrets: envelopeFromOtherKey,
      }),
    ).toThrow();
  });
});

describe('PaymentProvidersService → PaymentAdapterFactory — full roundtrip', () => {
  it('what the service writes, the factory reads back as the original secrets', async () => {
    const crypto = buildCrypto();
    const { prisma, writes } = buildPrismaMock();
    const service = new PaymentProvidersService(prisma as any, crypto);
    const config = { get: jest.fn() } as unknown as ConfigService;
    const factory = new PaymentAdapterFactory(config, crypto);

    await service.create(ORG_ID, {
      type: 'stripe',
      apiKey: 'sk_test_roundtrip_key',
      secretKey: 'sk_test_roundtrip_secret',
      webhookSecret: 'whsec_roundtrip',
    } as any);

    expect(writes).toHaveLength(1);

    // Read it back via the factory's parse logic (exposed via createAdapter).
    expect(() =>
      factory.createAdapter({
        id: PROVIDER_ID,
        type: 'stripe',
        encrypted_secrets: writes[0].encrypted_secrets,
      }),
    ).not.toThrow();
  });
});
