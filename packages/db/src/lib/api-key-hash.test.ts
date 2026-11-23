/**
 * api-key-hash: lookup-hash parity smoke test.
 *
 * Pure, no DB hit. Runs under tsx in <1s:
 *
 *   npx tsx packages/db/src/lib/api-key-hash.test.ts
 *
 * WHY this test is load-bearing: authentication only works if
 * the hash written at key-creation time and the hash computed at verify time
 * are the same value. This test pins hashApiKeyForLookup() to KNOWN expected
 * digests. Those expected values are the plain SHA-256 hex of the same ASCII
 * strings (what `printf '%s' <key> | shasum -a 256` prints). If anyone ever changes
 * the helper's algorithm/encoding, these assertions fail loudly instead of
 * silently logging out every API customer.
 *
 * Regenerate an expected value if you add a case:
 *   printf '%s' 'your-string' | shasum -a 256
 */

import assert from "node:assert/strict";

import { hashApiKeyForLookup } from "./api-key-hash";

// Each tuple is [rawKey, expectedHex]. expectedHex was produced with
// `printf '%s' <rawKey> | shasum -a 256` — the SQL-equivalent SHA-256 hex.
const CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "mf_sk_known_answer_test",
    "b729d50f743da58c0476057d4ab65f05a3923965f1a90f3ad851893732297e58",
  ],
  [
    "mf_pk_known_answer_test",
    "a93c2150611a333060cddf942080171224783abd3ceb2e137d24187305b5b67b",
  ],
  // Edge case: empty string still yields the canonical SHA-256 of "".
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
];

for (const [rawKey, expectedHex] of CASES) {
  const got = hashApiKeyForLookup(rawKey);
  assert.equal(
    got,
    expectedHex,
    `hashApiKeyForLookup(${JSON.stringify(rawKey)}) drifted from the known SQL value`,
  );
  // Shape: must be exactly 64 lowercase hex chars (fits the VarChar(64) column).
  assert.match(
    got,
    /^[0-9a-f]{64}$/,
    `digest for ${JSON.stringify(rawKey)} is not 64-char lowercase hex`,
  );
}

// Determinism: same input must always give the same output (the whole premise of
// using it as a WHERE lookup column).
assert.equal(
  hashApiKeyForLookup("mf_sk_determinism_check"),
  hashApiKeyForLookup("mf_sk_determinism_check"),
  "hashApiKeyForLookup is not deterministic — it cannot be used as a lookup column",
);

console.log(
  `[api-key-hash] OK — ${CASES.length} known-answer cases + determinism check passed`,
);
