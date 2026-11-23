/**
 * parse-key-role: fail-closed matrix test.
 *
 * Pure, no DB hit. Runs under tsx in <1s:
 *
 *   npx tsx packages/db/src/lib/parse-key-role.test.ts
 *
 * WHY this test is load-bearing: parseKeyRole sits directly upstream of
 * req.user.role, and OrgRoleGuard's whole ingest-is-sacred guarantee assumes it
 * NEVER throws and NEVER returns a role above the `ingest` floor for
 * malformed/unrecognized input. This pins that contract against every shape
 * `api_keys.permissions` (a Prisma `Json?`) can realistically hold.
 */

import assert from "node:assert/strict";

import { parseKeyRole } from "./parse-key-role";

// Each tuple is [label, input, expectedRole].
const CASES: ReadonlyArray<readonly [string, unknown, string]> = [
  ["null", null, "ingest"],
  ["empty array", [], "ingest"],
  ["empty object", {}, "ingest"],
  ["unrecognized role string", { role: "root" }, "ingest"],
  ["bare string (not an object)", "admin", "ingest"],
  ["number", 42, "ingest"],
  ["boolean", true, "ingest"],
  ["undefined", undefined, "ingest"],
  ["role field is not a string", { role: 123 }, "ingest"],
  ["role field is an object", { role: { nested: "admin" } }, "ingest"],
  ["array of role-shaped objects", [{ role: "admin" }], "ingest"],
  ["known role: finance", { role: "finance" }, "finance"],
  ["known role: admin", { role: "admin" }, "admin"],
  ["known role: developer", { role: "developer" }, "developer"],
  ["known role: member", { role: "member" }, "member"],
  ["known role: legal", { role: "legal" }, "legal"],
  ["known role: owner", { role: "owner" }, "owner"],
  ["known role: ingest (explicit)", { role: "ingest" }, "ingest"],
  // Realistic shape: mint-time provenance fields alongside role.
  [
    "role plus extra provenance fields",
    { role: "finance", legacy: true, minterUserId: "u1" },
    "finance",
  ],
];

for (const [label, input, expected] of CASES) {
  const got = parseKeyRole(input);
  assert.equal(
    got,
    expected,
    `parseKeyRole(${label}) → expected "${expected}", got "${got}"`,
  );
}

// Never throws, for any of the above inputs.
for (const [label, input] of CASES) {
  assert.doesNotThrow(
    () => parseKeyRole(input),
    `parseKeyRole(${label}) threw`,
  );
}

// Never returns a role above the ingest floor for malformed/unrecognized input —
// only the exact known-role cases above are allowed to escape "ingest".
const MALFORMED_INPUTS: unknown[] = [
  null,
  [],
  {},
  { role: "root" },
  "admin",
  42,
  true,
  undefined,
  { role: 123 },
  { role: {} },
  [{ role: "admin" }],
];
for (const input of MALFORMED_INPUTS) {
  assert.equal(
    parseKeyRole(input),
    "ingest",
    `parseKeyRole(${JSON.stringify(input)}) escalated above the ingest floor`,
  );
}

console.log(
  `[parse-key-role] OK — ${CASES.length} cases + malformed-input floor check passed`,
);
