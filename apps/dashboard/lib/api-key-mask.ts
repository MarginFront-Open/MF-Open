/**
 * Masking primitives for API keys.
 *
 * A key is a FIXED prefix followed by base64url(randomBytes(24)) — see
 * KEY_PREFIXES in apps/api-nest/src/modules/api-keys/api-keys.service.ts.
 * base64url's alphabet INCLUDES '_', so any mask that cuts at the last
 * underscore spills random characters into the visible output, and spills the
 * whole key when the random part happens to end in '_'. Cut at the fixed
 * prefix instead — that is the only part of a key that carries no entropy.
 */

const KEY_PREFIXES = ['mf_sk_', 'mf_pk_', 'prtl_'] as const

/** The safe-to-show prefix, or '' when this isn't a recognized key. */
export function keyPrefix(plaintext: string): string {
  return KEY_PREFIXES.find((p) => plaintext.startsWith(p)) ?? ''
}

/**
 * What the SDK snippet shows in place of a pasted key: the prefix and a fixed
 * run of asterisks. An unrecognized string masks to asterisks alone rather
 * than leaking a guessed prefix.
 */
export function maskKeyForPreview(plaintext: string): string {
  return `${keyPrefix(plaintext)}********`
}
