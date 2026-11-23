/**
 * mintable-key-roles: locked mint-ceiling matrix test.
 *
 * Pure, no DB hit. Runs under tsx in <1s:
 *
 *   npx tsx packages/db/src/lib/mintable-key-roles.test.ts
 *
 * WHY this test is load-bearing: mintableKeyRoles() is the separation-of-duties ceiling the
 * mint service enforces on EVERY key mint — a key can never be more powerful than its minter.
 * This pins the whole matrix cell-by-cell (like grant-roles.spec pins canGrantRole) so any
 * edit that lets finance mint a build key, or a developer mint a money key, fails loudly here.
 */

import assert from "node:assert/strict";

import { MINT_KEY_ROLES, mintableKeyRoles } from "./org-roles";

// Every key role a mint can stamp, floor to ceiling.
const KEY_ROLES = [
  "ingest",
  "member",
  "developer",
  "finance",
  "legal",
  "admin",
  "owner",
] as const;

// The locked ceiling, written as a truth table so the test reads like the spec.
// true = a minter with role <row> may stamp key role <column>.
const EXPECTED: Record<string, Record<string, boolean>> = {
  owner: {
    ingest: true,
    member: true,
    developer: true,
    finance: true,
    legal: true,
    admin: true,
    owner: true,
  },
  admin: {
    ingest: true,
    member: true,
    developer: true,
    finance: true,
    legal: true,
    admin: true,
    owner: false,
  },
  developer: {
    ingest: true,
    member: true,
    developer: true,
    finance: false, // build lane — never money
    legal: false, // ...and never the law lane
    admin: false,
    owner: false,
  },
  finance: {
    ingest: true,
    member: true,
    developer: false, // money lane — never build
    finance: true,
    legal: false, // may RUN matters, may not hand out legal credentials
    admin: false,
    owner: false,
  },
  member: {
    ingest: false,
    member: false,
    developer: false,
    finance: false,
    legal: false,
    admin: false,
    owner: false,
  },
};

let checks = 0;

// 1. Full cell-by-cell truth table.
for (const minter of Object.keys(EXPECTED)) {
  const set = mintableKeyRoles(minter);
  for (const target of KEY_ROLES) {
    const expected = EXPECTED[minter][target];
    assert.equal(
      set.includes(target),
      expected,
      `mintableKeyRoles(${minter}) ${expected ? "should" : "should NOT"} include ${target}`,
    );
    checks++;
  }
}

// 2. Fail-closed: an unknown, empty, or below-member minter role mints NOTHING.
// 'legal' belongs here as a MINTER: the legal seat is absent from MINT_KEY_ROLES
// (it never reaches the mint door) and has no ceiling row — owner/admin mint FOR it.
for (const bogus of ["ingest", "", "root", "superuser", "DEVELOPER", "legal"]) {
  assert.deepEqual(
    [...mintableKeyRoles(bogus)],
    [],
    `mintableKeyRoles(${JSON.stringify(bogus)}) must fail closed to []`,
  );
  checks++;
}

// 3. Separation of duties, stated directly.
assert.ok(
  !mintableKeyRoles("finance").includes("developer"),
  "a finance minter must NOT be able to mint a build (developer) key",
);
assert.ok(
  !mintableKeyRoles("developer").includes("finance"),
  "a developer minter must NOT be able to mint a money (finance) key",
);
assert.ok(
  !mintableKeyRoles("finance").includes("admin") &&
    !mintableKeyRoles("finance").includes("owner"),
  "a finance minter must NOT be able to escalate to admin/owner",
);
assert.ok(
  !mintableKeyRoles("developer").includes("admin") &&
    !mintableKeyRoles("developer").includes("owner"),
  "a developer minter must NOT be able to escalate to admin/owner",
);
assert.ok(
  !mintableKeyRoles("admin").includes("owner"),
  "an admin minter must NOT be able to mint an owner key",
);
assert.ok(
  !mintableKeyRoles("finance").includes("legal") &&
    !mintableKeyRoles("developer").includes("legal"),
  "only owner/admin may mint a legal key",
);

// 4. The route gate MINT_KEY_ROLES is exactly build-roles + finance, and never a floor role.
assert.deepEqual(
  [...MINT_KEY_ROLES],
  ["owner", "admin", "developer", "finance"],
  "MINT_KEY_ROLES must be owner/admin/developer/finance",
);
for (const floor of ["member", "ingest"]) {
  assert.ok(
    !(MINT_KEY_ROLES as readonly string[]).includes(floor),
    `${floor} must never be able to reach the mint route`,
  );
}

console.log(
  `[mintable-key-roles] OK — ${checks} matrix/fail-closed cases + SoD + MINT_KEY_ROLES gate passed`,
);
