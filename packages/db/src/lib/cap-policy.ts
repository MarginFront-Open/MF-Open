/**
 * cap-policy.ts: the ONE source of truth for the
 * two rules a spend cap can never get wrong, kept pure and dependency-free (no
 * Prisma, no Nest, no clock except the `now` the caller passes) so BOTH the
 * api-nest write path AND every other caller import the exact same logic
 * instead of re-deriving it and drifting apart.
 *
 * Rule 1 — the unbreakable ceiling: a team or dev cap may never exceed the org
 * ceiling for the same provider. This is the product's structural promise ("the
 * decision-maker's number is the wall"), so it lives here, in the shared path,
 * not inline in one controller where a second caller could skip it.
 *
 * Rule 2 — reset boundaries are platform-owned: the current spend window for a
 * cap's period is computed here in UTC, so every device that reads the spend
 * read-back agrees on where "this week" starts. Weeks start Monday 00:00 UTC
 * (ISO-8601); documented, not assumed.
 *
 * The closed vocabularies (scope / period / mode) also live here. providerScope
 * is deliberately NOT a closed set — it matches the free-form modelProvider
 * string ingest stores, and new providers appear without a schema change.
 */

/** Who a cap governs. Closed set. */
export const CAP_SCOPES = ["org", "team", "dev"] as const;
export type CapScope = (typeof CAP_SCOPES)[number];

/** Reset cadence. Closed set. */
export const CAP_PERIODS = ["day", "week", "month"] as const;
export type CapPeriod = (typeof CAP_PERIODS)[number];

/**
 * Enforcement posture. EXACTLY these two names, the same vocabulary credit pools
 * use, so there is one mental model across the whole product.
 * 'track' = watch + alert, blocks nothing. 'enforce' = the device hard-stops.
 */
export const CAP_MODES = ["track", "enforce"] as const;
export type CapMode = (typeof CAP_MODES)[number];

/** The provider a cap governs. 'all' or a single provider. */
export const CAP_PROVIDER_SCOPE_ALL = "all";

/**
 * The agentCode values code-cost-clarity registers its coding agents under
 * (forwarder.ts AGENT_CODE / AGENT_CODE_CODEX). Caps govern INTERNAL coding-agent spend only:
 * an org that also bills its own customers through the platform has customer
 * events in the same signal_events table, and those must never count toward a
 * cap's spend, roster, or enforcement — a cap tripping because the org's
 * CUSTOMERS were busy would be the product's trust break.
 */
export const CCC_AGENT_CODES = ["claude-code", "codex"] as const;
export type CccAgentCode = (typeof CCC_AGENT_CODES)[number];

/**
 * The signalName code-cost-clarity writes for a coding TURN, one per tool
 * (forwarder.ts SIGNAL_NAME / SIGNAL_NAME_CODEX). Only a turn can carry a cap stamp, so turns
 * decide the VERDICT — but they must not decide the DENOMINATOR. Narrowing the
 * query to turns drops a developer whose only in-window rows are tool calls, which
 * RAISES the fraction; coverage counts them and marks them `unknown` instead.
 */
export const CCC_TURN_SIGNAL_NAMES: Record<CccAgentCode, string> = {
  "claude-code": "claude-code-turn",
  codex: "codex-turn",
};

/**
 * The Prisma where-fragment scoping a query to ONE tool — the per-tool sibling of
 * cccInternalEventFilter, for reads that must not blend Claude Code and Codex into
 * a single number. agentCode ONLY: see above for why signalName stays out of it.
 */
export function cccToolFilter(agentCode: CccAgentCode) {
  return { agents: { agentCode } };
}

/**
 * The placeholder customerExternalId code-cost-clarity bills under when a
 * machine surfaced no developer email (forwarder.ts NO_IDENTITY_CUSTOMER / CODEX_NO_IDENTITY_CUSTOMER).
 * Coverage folds by customerExternalId, so every such machine in an org collapses
 * into ONE row — and one row standing for an unknown number of machines cannot
 * support "every machine we have seen has the cap check running". These ids are
 * barred from the armed bucket; they stay in the denominator and stay eligible for
 * not-armed, because a proven gap is still a proven gap.
 */
export const CCC_NO_IDENTITY_CUSTOMER_IDS: readonly string[] = [
  "claude-code-no-identity",
  "codex-no-identity",
];

/**
 * The Prisma where-fragment every cap-related signal_events query must spread
 * in: scopes the query to internal coding-agent events via the agents relation.
 * Lives here so api-nest spend sums and dashboard roster/spend queries share
 * one definition and cannot drift.
 */
export function cccInternalEventFilter() {
  return { agents: { agentCode: { in: [...CCC_AGENT_CODES] } } };
}

export function isCapScope(v: unknown): v is CapScope {
  return typeof v === "string" && (CAP_SCOPES as readonly string[]).includes(v);
}

export function isCapPeriod(v: unknown): v is CapPeriod {
  return (
    typeof v === "string" && (CAP_PERIODS as readonly string[]).includes(v)
  );
}

export function isCapMode(v: unknown): v is CapMode {
  return typeof v === "string" && (CAP_MODES as readonly string[]).includes(v);
}

/** An existing org-ceiling cap, reduced to just what the ceiling rule needs. */
export interface OrgCeiling {
  providerScope: string;
  amountUsd: number;
}

export interface CapCeilingCheckInput {
  scope: CapScope;
  providerScope: string;
  amountUsd: number;
  /** Every org-scope cap already stored for this org (any provider). */
  orgCeilings: OrgCeiling[];
}

export interface CapCeilingCheckResult {
  ok: boolean;
  /** The ceiling that applied (for the caller's error message), or null when none did. */
  ceilingUsd: number | null;
  reason?: string;
}

/**
 * The ceiling that constrains a child (team/dev) cap for a given provider:
 * a same-provider org ceiling wins; otherwise the org's 'all'-provider ceiling
 * applies to a provider-specific child; otherwise there is no ceiling.
 *
 * Exported because org-side WRITES need the same resolution: changing or
 * removing an org ceiling must re-check every child against the ceiling set as
 * it would look AFTER the change — including children that only fall back to
 * the 'all' ceiling. Re-deriving this fallback anywhere else is how the two
 * paths drift.
 */
export function resolveApplicableCeiling(
  providerScope: string,
  orgCeilings: OrgCeiling[],
): number | null {
  const exact = orgCeilings.find((c) => c.providerScope === providerScope);
  if (exact) return exact.amountUsd;
  if (providerScope !== CAP_PROVIDER_SCOPE_ALL) {
    const all = orgCeilings.find(
      (c) => c.providerScope === CAP_PROVIDER_SCOPE_ALL,
    );
    if (all) return all.amountUsd;
  }
  return null;
}

/**
 * Rule 1. An org cap has nothing above it. A team/dev cap must be <= the
 * applicable org ceiling; with no applicable ceiling there is nothing to
 * violate (child caps are allowed to exist before a ceiling is set).
 */
export function checkCapWithinCeiling(
  input: CapCeilingCheckInput,
): CapCeilingCheckResult {
  if (input.scope === "org") {
    return { ok: true, ceilingUsd: null };
  }
  const ceiling = resolveApplicableCeiling(
    input.providerScope,
    input.orgCeilings,
  );
  if (ceiling === null) {
    return { ok: true, ceilingUsd: null };
  }
  if (input.amountUsd > ceiling) {
    return {
      ok: false,
      ceilingUsd: ceiling,
      reason:
        `A ${input.scope} cap of $${input.amountUsd} exceeds the org ceiling of ` +
        `$${ceiling} for provider "${input.providerScope}". A team or dev cap can ` +
        `never be higher than the org ceiling it sits under.`,
    };
  }
  return { ok: true, ceilingUsd: ceiling };
}

/**
 * Rule 2. The current spend window for a cap period, in UTC. `end` is `now`
 * (spend-so-far); `start` is the period boundary. Weeks start Monday 00:00 UTC.
 */
export function currentPeriodWindow(
  period: CapPeriod,
  now: Date,
): { start: Date; end: Date } {
  const start = startOfPeriodUtc(period, now);
  return { start, end: now };
}

function startOfPeriodUtc(period: CapPeriod, now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === "day") {
    return new Date(Date.UTC(y, m, d));
  }
  if (period === "month") {
    return new Date(Date.UTC(y, m, 1));
  }
  // week: back up to the most recent Monday. getUTCDay() is 0 (Sun)..6 (Sat);
  // Monday is 1, so Sunday (0) is 6 days into the week, not the start.
  const dow = now.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  return new Date(Date.UTC(y, m, d - daysSinceMonday));
}
