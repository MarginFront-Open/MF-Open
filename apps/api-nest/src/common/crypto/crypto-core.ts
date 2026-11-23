/**
 * AES-256-GCM core — pure functions, no framework deps.
 *
 * Wrapped by CryptoService (the NestJS injectable) for application code.
 *
 * Envelope format: `v1:<base64-iv>:<base64-ciphertext>:<base64-authTag>`
 *
 * Why this shape:
 *   - `v1:` prefix lets us add v2 (key rotation, algorithm change) later without breaking
 *     existing rows. Decrypt path version-checks before touching the ciphertext.
 *   - GCM (auth tag) detects tampering: flip a single bit in the ciphertext or auth tag and
 *     decrypt throws. Prevents an attacker with DB write access from forging valid plaintext.
 *   - Random 12-byte IV per encrypt (NIST recommendation for GCM). Never reuse an IV with
 *     the same key — that catastrophically breaks GCM.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const VERSION_PREFIX = 'v1:';

/**
 * Decode a base64-encoded 32-byte key. Throws if the env value isn't 32 bytes after decode,
 * which is the only key size AES-256 supports.
 */
export function loadKey(base64Key: string | undefined): Buffer {
  if (!base64Key) {
    throw new Error(
      'ENCRYPTION_KEY env var missing or empty. Generate with: openssl rand -base64 32',
    );
  }
  const keyBuf = Buffer.from(base64Key, 'base64');
  if (keyBuf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256). Got ${keyBuf.length} bytes from the provided base64. Generate a new one with: openssl rand -base64 32`,
    );
  }
  return keyBuf;
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION_PREFIX}${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
}

export function decrypt(key: Buffer, envelope: string): string {
  if (!envelope.startsWith(VERSION_PREFIX)) {
    throw new Error('Encryption envelope has unsupported version (expected v1)');
  }
  const parts = envelope.slice(VERSION_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error(
      'Malformed encryption envelope — expected v1:<base64-iv>:<base64-ciphertext>:<base64-authTag>',
    );
  }
  const [ivB64, ciphertextB64, authTagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // .final() throws on auth tag mismatch — that's how we detect tampering.
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * True if the given value looks like a v1 encrypted envelope. The factory's read path
 * refuses anything that is not one.
 */
export function isEncryptedEnvelope(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(VERSION_PREFIX);
}
