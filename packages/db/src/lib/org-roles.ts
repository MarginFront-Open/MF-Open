/**
 * org-roles.ts — the ONE source of truth for "who is allowed to hand out which role."
 *
 * This is a pure, dependency-free helper (no Prisma, no Nest) so BOTH the api-nest
 * backend AND the Next.js dashboard can import the exact same grant rules from
 * `@marginfront/db` instead of each re-implementing the matrix and slowly drifting apart.
 *
 * Plain-English version of the rule it encodes:
 *   - An OWNER can hand out any role, including making someone else an owner.
 *   - An ADMIN can hand out admin / finance / developer / member — but NEVER owner.
 *   - A FINANCE user can only invite finance / member (never admin, developer, or owner).
 *   - A DEVELOPER can hand out NOTHING — developers run the build/operations area, NOT
 *     the team, so they have no inviting power at all.
 *   - A LEGAL user (the matter seat) can hand out NOTHING: only an owner
 *     or admin grants legal.
 *   - A MEMBER can only invite other members.
 *
 * "Only an owner can grant the owner role" is not a separate rule to remember —
 * it falls out of the table automatically, because `owner` is the ONLY actor whose
 * allowed-set contains `'owner'`.
 *
 * NOTE on the 'developer' role: ba_member.role is a free-form text column, so
 * 'developer' persists cleanly alongside owner/admin/finance/member. Owners and
 * admins may grant it; developers grant nothing.
 */

/**
 * For each actor role, the exact set of roles that actor is allowed to GRANT —
 * whether by inviting someone, adding a member directly, or changing an existing
 * member's role. This single map governs all three of those paths.
 */
export const GRANTABLE_ROLES: Record<string, readonly string[]> = {
  owner: ["owner", "admin", "finance", "developer", "legal", "member"],
  admin: ["admin", "finance", "developer", "legal", "member"], // NEVER owner
  finance: ["finance", "member"], // the invite exception; never admin, developer, or owner
  developer: [], // developers manage the build, NOT the team — they grant no roles
  // The matter seat: only owner/admin hand it out, and it hands
  // out NOTHING — same fail-closed shape as developer.
  legal: [],
  member: ["member"], // members can only bring in other members
};

/**
 * MANAGE_MONEY_ROLES — the ONE source of truth for "who is allowed to CHANGE the
 * books." It locks every money-area WRITE: GL codes,
 * classification rules, signal classification, invoices, subscriptions, pricing
 * plans, tax settings — on BOTH the dashboard (Server Actions) and api-nest
 * (invoice controller). Imported from `@marginfront/db` on both surfaces so the two
 * can never drift apart.
 *
 * Plain-English: only an OWNER, an ADMIN, or a FINANCE user may edit anything
 * that moves money or feeds a customer's bill. A plain MEMBER can look but not
 * touch.
 *
 * This is DELIBERATELY DISTINCT from ORG_MANAGE_ROLES (= owner/admin only), which
 * lives in api-nest's org-role.guard.ts and governs "manage my org" config —
 * API keys, payout-provider connect/disconnect, dashboard mode. Finance belongs
 * in MANAGE_MONEY (the books) but NOT in ORG_MANAGE (org config): that gap is the
 * entire reason the finance seat exists, so do not collapse the two sets.
 */
export const MANAGE_MONEY_ROLES = ["owner", "admin", "finance"] as const;

/**
 * MANAGE_BUILD_ROLES — the ONE source of truth for "who is allowed to CHANGE the
 * BUILD area." It locks every build/operations WRITE:
 * agents, customers, API keys, and signal DEFINITIONS (the meters) — plus the
 * operational signal-event data (which MODEL an event used, a meter's service
 * makeup). On BOTH the dashboard (Server Actions) and api-nest. Imported from
 * `@marginfront/db` on both surfaces so the two can never drift apart.
 *
 * Plain-English: the BUILD area is the technical/integration plumbing that
 * PRODUCES a cost — the meters, the model an agent runs on, the API keys, the
 * customer records. The DEVELOPERS own this. It is DELIBERATELY DISTINCT from:
 *   - ORG_MANAGE_ROLES (owner/admin — TRUE org management: invite/remove members,
 *     delete the org, flip dashboard-mode), and
 *   - MANAGE_MONEY_ROLES (owner/admin/finance — the BOOKS: GL codes, invoices,
 *     pricing, tax, cost CLASSIFICATION).
 *
 * The line that must NOT blur: a meter / event / model-mapping is OPERATIONS =
 * BUILD; the accounting TREATMENT of that cost (a classification category, an
 * invoice, a price) is NUMBERS = MONEY. Finance does not touch operations;
 * developers do not touch the numbers.
 *
 * owner/admin/developer. The 'developer' role is the dedicated
 * build/operations seat: every build-management write (agents/customers/signals
 * CRUD, api-key create/rotate/revoke) gates on this one set, so membership here
 * grants all of them. The ONE exception is the
 * PAYOUT connectors (stripe/payment-providers): redirecting where revenue
 * lands is owner/admin-only, so those gates use ORG_MANAGE_ROLES, not
 * MANAGE_BUILD. Developer therefore gets "build minus payout".
 */
export const MANAGE_BUILD_ROLES = ["owner", "admin", "developer"] as const;

/**
 * ORG_MANAGE_ROLES — the ONE source of truth for "who is allowed to run the
 * COMPANY ACCOUNT itself." It locks every org-settings
 * WRITE: branding/theme colors, the company logo, onboarding state, the setup-method
 * flow, the dashboard mode, plus the api-nest "manage my
 * org" routes: API keys, payout-provider connect/disconnect, org update/delete,
 * dashboard-mode, and the team re-role/remove/invite endpoints. Imported from
 * `@marginfront/db` on BOTH surfaces (dashboard Server Actions + the api-nest guard) so
 * the two can never drift apart.
 *
 * Plain-English: org BRANDING, the LOGO, the ONBOARDING flow, the SETUP wizard are
 * ORG-ADMINISTRATION — they are NOT numbers (so this is NOT the finance set) and NOT
 * metering plumbing (so this is NOT the developer/build set). They are OWNER/ADMIN
 * ONLY. This set is DELIBERATELY THE TIGHTEST of the three and must STAY that way:
 *   - MANAGE_MONEY_ROLES adds 'finance' (the books) — org settings get NO finance.
 *   - MANAGE_BUILD_ROLES includes 'developer' (the meters): org settings get NO
 *     developer either.
 * Do NOT collapse these together: the finance and developer seats exist so they
 * can touch their own area WITHOUT being handed the keys to the company account.
 *
 * owner/admin only for this set.
 */
export const ORG_MANAGE_ROLES = ["owner", "admin"] as const;

/**
 * LAW_MANAGE_ROLES — the ONE source of truth for "who may touch the Law tab"
 * (matters). Gates the /law route, the matters /
 * routing-rule / manual-assignment WRITES, and the per-matter audit export.
 *
 * owner/admin/finance/legal. This is MANAGE_MONEY_ROLES plus the dedicated
 * 'legal' seat: a billing manager (finance) runs matters until a firm grants
 * 'legal'. 'legal' appears ONLY here:
 * it is deliberately absent from MANAGE_MONEY / MANAGE_BUILD / ORG_MANAGE /
 * CAP_MANAGE / MINT_KEY and every PRIV_READ set, so the legal seat sees the
 * Law tab and nothing else that carries a gate. Do NOT fold this into
 * MANAGE_MONEY_ROLES: that would hand
 * 'legal' every money write on the platform.
 */
export const LAW_MANAGE_ROLES = ["owner", "admin", "finance", "legal"] as const;

/**
 * CAP_MANAGE_ROLES: the ONE source of truth for "who may write a spend cap".
 * Only an OWNER or a FINANCE user. The api-nest cap-write routes gate on it.
 *
 * This is DELIBERATELY NARROWER than MANAGE_MONEY_ROLES (owner/admin/finance):
 * it EXCLUDES admin, and that exclusion is the point. A cap is the decision-maker's
 * governor on developer spend; 'admin' is the build/operations seat (see
 * MANAGE_BUILD_ROLES), which is the party often closest to the developers being
 * capped. Letting the governed loosen their own governor would hollow out the
 * product's core trust claim ("the cap that actually caps"). So caps sit with the
 * money owner (owner) and the money seat (finance) only, never the build seat.
 *
 * Do NOT collapse it into MANAGE_MONEY_ROLES to "reuse": that would silently
 * re-admit admin and break the trust model.
 */
export const CAP_MANAGE_ROLES = ["owner", "finance"] as const;

/**
 * MINT_KEY_ROLES — the ROUTE gate for "who may reach the API-key mint/revoke
 * endpoints at all" (role-mirrored API keys). This is DELIBERATELY
 * WIDER than MANAGE_BUILD_ROLES: it adds 'finance' so a finance user can mint a
 * finance-scoped key for their accountant's billing script — a strictly narrower
 * act than granting a human a finance SEAT, which finance can already do
 * (GRANTABLE_ROLES.finance = ['finance','member']).
 *
 * IMPORTANT: this gate ONLY decides "may you open the mint door." It does NOT
 * decide WHICH role you may stamp on the key — that ceiling is mintableKeyRoles()
 * below, enforced in the mint service. Keeping the two separate is the whole
 * separation-of-duties story: finance reaches the door but can only mint
 * {finance, member, ingest}; a developer reaches the door but can never mint a
 * money key. Do NOT fold finance into MANAGE_BUILD_ROLES to "simplify" this —
 * that set gates agent/customer/signal BUILD writes, and finance must never gain
 * those. Finance mints {finance, member, ingest}.
 */
export const MINT_KEY_ROLES = [
  "owner",
  "admin",
  "developer",
  "finance",
] as const;

/**
 * The mint CEILING: for a minter with role X, the exact set of key roles X is
 * allowed to stamp on a new key. A key can never be
 * more powerful than whoever minted it.
 *
 * Plain-English separation of duties this table encodes:
 *   - owner/admin can mint across both lanes (build AND money), plus the LAW lane.
 *   - a DEVELOPER mints only the BUILD lane {ingest, member, developer} — never a
 *     money (finance) or admin/owner key.
 *   - a FINANCE user mints only the MONEY lane {ingest, member, finance} — never a
 *     build (developer) or admin/owner key.
 *   - a MEMBER (and any unknown/ingest role) mints NOTHING.
 *   - 'legal' keys (the Law lane) come from OWNER/ADMIN only: mirrors
 *     GRANTABLE_ROLES, where only owner/admin grant the legal SEAT. Finance may RUN
 *     matters with its own finance key (LAW_MANAGE_ROLES includes finance) but does
 *     not hand out legal credentials; the legal seat itself is absent from
 *     MINT_KEY_ROLES, so owner/admin mint FOR a firm's agents.
 *
 * WHY THIS IS A SEPARATE MAP AND NOT A REUSE OF GRANTABLE_ROLES (the subtle trap):
 * GRANTABLE_ROLES.developer = [] — a developer grants no TEAM seats. But a developer
 * key MUST be able to mint BUILD keys; that is the entire point of the developer seat.
 * So the two matrices genuinely differ and must stay separate.
 *
 * FAILS CLOSED: an unknown, empty, or below-member minter role (e.g. 'ingest') maps
 * to [] — mints nothing — so a malformed or future role can never mint by accident.
 */
const MINTABLE_KEY_ROLES: Record<string, readonly string[]> = {
  owner: [
    "ingest",
    "member",
    "developer",
    "finance",
    "legal",
    "admin",
    "owner",
  ],
  admin: ["ingest", "member", "developer", "finance", "legal", "admin"],
  developer: ["ingest", "member", "developer"], // build lane, no money, no law
  finance: ["ingest", "member", "finance"], // money lane, no build, no law
  member: [], // members mint nothing
};

/**
 * The set of key roles a minter with role `minterRole` may stamp on a new key.
 *
 * Fails CLOSED on purpose (mirrors canGrantRole): an unknown/empty/below-member
 * minter role gets an empty set, so it can mint nothing.
 *
 * @param minterRole the signed-in minter's ba_member.role. Always a human: a
 *   key can't mint keys, and api_keys.createdById couldn't store one anyway.
 * @returns the exact key roles that minter may choose; [] if the minter may mint none.
 */
export function mintableKeyRoles(minterRole: string): readonly string[] {
  return MINTABLE_KEY_ROLES[minterRole] ?? [];
}

/**
 * PRIV_READ_KEYS / PRIV_READ_PAYOUT / PRIV_READ_WEBHOOK — the three PRIVILEGED-READ
 * role sets. Without them a plain MEMBER, or any org-scoped key, could read API-key
 * material, payout routing, and payment-provider/webhook config it has no business
 * seeing. A member session has no API-key read.
 *
 * Because `@OrgRoles` gates BOTH the human/session path and the api-key path in
 * org-role.guard.ts, these sets apply on the SESSION path too. A MEMBER session skips the guard's
 * no-DB-hit member fast-path on these routes and falls through to a real ba_member role check and
 * gets a clean 403.
 */

/** API-key material / key-list reads. Developer has this: MANAGE_BUILD already
 * includes enumerating your own org's keys; MEMBER does not get it (the read half of the
 * plaintext-key-leak surface). */
export const PRIV_READ_KEYS = [
  "owner",
  "admin",
  "developer",
  "finance",
] as const;

/** Payout / payment-provider CONNECT status reads — where revenue lands. Developer is
 * walled from money here even though it holds MANAGE_BUILD elsewhere; MEMBER excluded. */
export const PRIV_READ_PAYOUT = ["owner", "admin", "finance"] as const;

/** Payment-provider / webhook config reads (BUILD plumbing, not money-routing) — the
 * mirror image of PRIV_READ_PAYOUT: developer has it, finance does not. The webhook
 * SECRET VALUE itself is never returned to any role or key regardless of this set —
 * payment-providers.service.ts always strips `encrypted_secrets` before responding;
 * this set only governs the non-secret provider config rows. */
export const PRIV_READ_WEBHOOK = ["owner", "admin", "developer"] as const;

/**
 * Can an actor with role `actorRole` grant the role `targetRole`?
 *
 * Fails CLOSED on purpose: if `actorRole` is unknown, empty, or a role we've never
 * heard of, its allowed-set is empty and this returns false — so a malformed or
 * future role can never accidentally hand out privileges it wasn't explicitly given.
 *
 * @param actorRole  the role of the person doing the granting (read from ba_member)
 * @param targetRole the role they are trying to assign to someone
 * @returns true only if `targetRole` is explicitly in `actorRole`'s allowed-set
 */
export function canGrantRole(actorRole: string, targetRole: string): boolean {
  return (GRANTABLE_ROLES[actorRole] ?? []).includes(targetRole);
}
