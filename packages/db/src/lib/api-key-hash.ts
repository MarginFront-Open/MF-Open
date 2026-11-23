/**
 * api-key-hash.ts — the ONE source of truth for "how do we turn a raw API key
 * (mf_sk_... / mf_pk_...) into the value we store in api_keys.apiKeyLookupHash
 * and the value we match against when a request comes in."
 *
 * This is a pure, dependency-free helper (node:crypto only — no Prisma, no Nest)
 * so BOTH the api-nest backend AND the Next.js dashboard import the EXACT same
 * function from `@marginfront/db`. Mirrors the shared-lib pattern in org-roles.ts.
 * If write-time and verify-time ever computed the hash differently, every key
 * minted on one side would fail to authenticate on the other — so they MUST be
 * the same function. That is the entire reason this file exists.
 *
 * WHY a plain, unkeyed SHA-256:
 *   - DETERMINISTIC: sha256(rawKey) is a pure function — the same input always
 *     yields the same 64-char lowercase hex. That is what lets it be a database
 *     `WHERE apiKeyLookupHash = ?` lookup column. bcrypt (the hash on
 *     api_keys.apiKeyHash) is SALTED, so it produces a different string every
 *     time and can NEVER be used for a WHERE match.
 *   - SAFE without a server secret: API keys are 192 bits of CSPRNG entropy
 *     (crypto.randomBytes(24)). Brute-forcing a 192-bit-random preimage from a
 *     leaked hash is infeasible, so HMAC's keyed-secret benefit buys little here
 *     while costing a shared secret that would have to be present and identical
 *     in api-nest AND in the dashboard. Unkeyed SHA-256 can also be computed
 *     in SQL (encode(digest(text,'sha256'),'hex')), which is byte-identical.
 *
 * IMPORTANT — keep it byte-identical to that SQL expression. Both compute the
 * lowercase hex SHA-256 of the UTF-8 bytes of the same string.
 * API keys are ASCII (base64url), so there is no UTF-8 encoding ambiguity.
 */

import { createHash } from "node:crypto";

/**
 * Compute the deterministic lookup hash for a raw API key.
 *
 * @param rawKey the full plaintext key as the client sends it (e.g.
 *   "mf_sk_AbC123..."). Hash the EXACT string the request presents — do not
 *   trim, lowercase, or strip a "Bearer " prefix here; the caller has already
 *   extracted the bare key, and the stored hash was computed from that same
 *   string, so hashing anything else never matches.
 * @returns the 64-character lowercase hex SHA-256 digest, the value stored in
 *   and matched against api_keys.apiKeyLookupHash.
 */
export function hashApiKeyForLookup(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}
