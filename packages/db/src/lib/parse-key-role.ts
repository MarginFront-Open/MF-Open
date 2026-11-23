/**
 * parse-key-role.ts — the ONE function that turns an api_keys.permissions blob
 * into the dashboard role a key carries (role-mirrored keys).
 *
 * This is a pure, dependency-free helper (no Prisma, no Nest) so BOTH the api-nest
 * backend AND the Next.js dashboard can read the exact same role off a key's
 * `permissions` column via `@marginfront/db`. Mirrors the shared-lib pattern in
 * org-roles.ts and api-key-hash.ts.
 *
 * FAILS CLOSED ON PURPOSE: `permissions` is a Prisma `Json? @default("[]")`
 * column, so it can arrive as `null`, `[]`, `{}`, a stray string, a JSON blob
 * someone hand-edited, or a future role this function has never heard of. Every
 * one of those shapes floors to `'ingest'` — the lowest-privilege role, below
 * `member` — never to anything more powerful. This function must NEVER throw
 * and must NEVER escalate on malformed input: it sits directly upstream of
 * `req.user.role`, and the ingest-is-sacred guarantee depends on a corrupt
 * blob failing safe here, not crashing or over-granting.
 */

const KEY_ROLES = [
  "ingest",
  "member",
  "developer",
  "finance",
  "legal",
  "admin",
  "owner",
] as const;

export type KeyRole = (typeof KEY_ROLES)[number];

/**
 * Read the dashboard role a key carries out of its `permissions` JSON blob.
 *
 * @param permissions the raw value of an api_keys row's `permissions` column
 *   (already JSON-parsed by Prisma — this never does string parsing itself)
 * @returns the role string if `permissions` is a plain object with a
 *   recognized `role` field; otherwise the `'ingest'` floor
 */
export function parseKeyRole(permissions: unknown): KeyRole {
  if (
    permissions === null ||
    typeof permissions !== "object" ||
    Array.isArray(permissions)
  ) {
    return "ingest";
  }

  const role = (permissions as { role?: unknown }).role;
  if (
    typeof role === "string" &&
    (KEY_ROLES as readonly string[]).includes(role)
  ) {
    return role as KeyRole;
  }

  return "ingest";
}
