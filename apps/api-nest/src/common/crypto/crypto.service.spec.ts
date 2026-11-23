/**
 * Tests for CryptoService.
 *
 * These tests use the actual node:crypto implementation (no mocks). Each test instantiates
 * the service with a known key, then exercises encrypt / decrypt round-trips, tampering
 * detection, key isolation, and version handling.
 *
 * If any of these break, customer payment provider secrets at rest are at risk.
 */

import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { CryptoService } from './crypto.service';

function buildService(keyB64?: string): CryptoService {
  const config = {
    get: jest.fn((name: string) => (name === 'ENCRYPTION_KEY' ? keyB64 : undefined)),
  } as unknown as ConfigService;
  const service = new CryptoService(config);
  service.onModuleInit();
  return service;
}

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

describe('CryptoService — initialization', () => {
  it('throws on startup if ENCRYPTION_KEY is missing', () => {
    expect(() => buildService(undefined)).toThrow(/ENCRYPTION_KEY/);
  });

  it('throws on startup if ENCRYPTION_KEY is wrong length', () => {
    const tooShort = Buffer.alloc(16).toString('base64');
    expect(() => buildService(tooShort)).toThrow(/32 bytes/);
  });

  it('boots cleanly with a valid 32-byte base64 key', () => {
    expect(() => buildService(KEY_A)).not.toThrow();
  });
});

describe('CryptoService — roundtrip', () => {
  let service: CryptoService;

  beforeEach(() => {
    service = buildService(KEY_A);
  });

  it('encrypts and decrypts a simple ASCII payload', () => {
    const original = JSON.stringify({ apiKey: 'sk_test_abc123', secretKey: 'sk_test_xyz' });
    const envelope = service.encrypt(original);
    expect(envelope).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(envelope).not.toContain('sk_test_abc123'); // ciphertext must hide the plaintext
    expect(service.decrypt(envelope)).toBe(original);
  });

  it('roundtrips Unicode and multibyte characters', () => {
    const original = 'Hello 🌍 — пароль 测试 secret';
    const envelope = service.encrypt(original);
    expect(service.decrypt(envelope)).toBe(original);
  });

  it('roundtrips a 100 KB payload (smoke test for chunked encryption)', () => {
    const original = randomBytes(100 * 1024).toString('hex');
    const envelope = service.encrypt(original);
    expect(service.decrypt(envelope)).toBe(original);
  });

  it('produces different ciphertext for the same plaintext on repeated encrypts (random IV per call)', () => {
    const plaintext = 'sk_test_constant_value';
    const env1 = service.encrypt(plaintext);
    const env2 = service.encrypt(plaintext);
    expect(env1).not.toBe(env2); // different IVs → different ciphertext
    expect(service.decrypt(env1)).toBe(plaintext);
    expect(service.decrypt(env2)).toBe(plaintext);
  });
});

describe('CryptoService — tampering detection', () => {
  let service: CryptoService;

  beforeEach(() => {
    service = buildService(KEY_A);
  });

  it('throws when the ciphertext segment is modified', () => {
    const envelope = service.encrypt('sensitive');
    const parts = envelope.split(':');
    // Flip a character in the ciphertext segment (index 2 = the ciphertext)
    const buf = Buffer.from(parts[2], 'base64');
    buf[0] = buf[0] ^ 0xff;
    parts[2] = buf.toString('base64');
    const tampered = parts.join(':');
    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('throws when the auth tag segment is modified', () => {
    const envelope = service.encrypt('sensitive');
    const parts = envelope.split(':');
    const buf = Buffer.from(parts[3], 'base64');
    buf[0] = buf[0] ^ 0xff;
    parts[3] = buf.toString('base64');
    const tampered = parts.join(':');
    expect(() => service.decrypt(tampered)).toThrow();
  });
});

describe('CryptoService — key isolation', () => {
  it('cannot decrypt an envelope produced by a different key', () => {
    const serviceA = buildService(KEY_A);
    const serviceB = buildService(KEY_B);
    const envelope = serviceA.encrypt('plaintext');
    expect(() => serviceB.decrypt(envelope)).toThrow();
  });
});

describe('CryptoService — version handling', () => {
  let service: CryptoService;

  beforeEach(() => {
    service = buildService(KEY_A);
  });

  it('throws on an envelope with no version prefix', () => {
    expect(() => service.decrypt('justBase64NotAnEnvelope')).toThrow(/version/i);
  });

  it('throws on a future version envelope', () => {
    expect(() => service.decrypt('v2:fake:fake:fake')).toThrow(/version/i);
  });

  it('throws on a malformed v1 envelope (wrong segment count)', () => {
    expect(() => service.decrypt('v1:onlyOnePart')).toThrow(/Malformed/i);
  });
});

describe('CryptoService — isEncrypted helper', () => {
  let service: CryptoService;

  beforeEach(() => {
    service = buildService(KEY_A);
  });

  it('returns true for v1 envelopes', () => {
    const env = service.encrypt('something');
    expect(service.isEncrypted(env)).toBe(true);
  });

  it('returns false for legacy plaintext JSON', () => {
    expect(service.isEncrypted('{"apiKey":"sk_test_abc"}')).toBe(false);
  });

  it('returns false for bare API key strings', () => {
    expect(service.isEncrypted('sk_test_abc123')).toBe(false);
  });

  it('returns false for null / undefined / empty string', () => {
    expect(service.isEncrypted(null)).toBe(false);
    expect(service.isEncrypted(undefined)).toBe(false);
    expect(service.isEncrypted('')).toBe(false);
  });
});
