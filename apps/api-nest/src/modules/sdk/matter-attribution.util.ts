/**
 * WHAT THIS FILE DOES: Resolves which legal matter a usage record bills to,
 * at ingest time. Pure functions: the
 * service loads the org's matter lookup + routing rules ONCE per batch and
 * calls resolveMatterAttribution per record, so the ingest hot path adds zero
 * per-record queries.
 *
 * WHY IT EXISTS: bar rules (ABA Op. 512, FL 24-1, OR 2025-205) let a firm
 * bill AI work only at ACTUAL per-matter cost. Stamping every event with its
 * matter — and HOW it got there — at the moment it's recorded is what makes
 * that record exist. Materialized at ingest on purpose: an audit export must
 * be a stable historical record, so past exports can't change when rules do.
 *
 * CONNECTS TO: sdk.service.ts recordUsage (the only caller),
 * signal-event.utils.ts (carries matterId/matterSource onto the parent row),
 * apps/dashboard/app/actions/matter-rules.ts (applies the SAME rule shape
 * retroactively to unassigned events via "Apply rules").
 */

/** One matter_routing_rules row, narrowed to what matching needs. */
export interface MatterRoutingRuleLite {
  matterId: string;
  priority: number;
  agentCode: string | null;
  customerExternalId: string | null;
  signalPattern: string | null;
}

export interface MatterAttributionContext {
  /** matters.matterNumber -> matters.id for every tag seen in the batch. */
  matterIdByNumber: ReadonlyMap<string, string>;
  /**
   * The org's routing rules, ALREADY sorted by the loader's ORDER BY
   * (priority asc, createdAt asc, id asc). resolveMatterAttribution trusts
   * this order — the tie-break keys are what make two same-priority rules
   * resolve the same way on every run (same-priority is the default state:
   * every rule defaults to 100).
   */
  rules: readonly MatterRoutingRuleLite[];
}

export interface MatterAttribution {
  matterId: string | null;
  matterSource: 'tag' | 'rule' | null;
}

/** The context used when the org has no matters/rules (or the tables don't
 * exist yet mid-deploy) — every record resolves to Unassigned. */
export const EMPTY_MATTER_CONTEXT: MatterAttributionContext = {
  matterIdByNumber: new Map(),
  rules: [],
};

/**
 * The documented tagging convention: `metadata.matterId` carries the firm's
 * own matter NUMBER as a string. Trimmed; empty or non-string values are no
 * tag at all (a number sent by mistake is ignored rather than coerced, so a
 * junk value can never accidentally match a matter).
 */
export function extractMatterTag(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const raw = metadata?.matterId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Distinct tags across a batch — the exact `IN (...)` list for the one
 * matters lookup. Empty result = the matters query is skipped entirely. */
export function collectMatterTags(
  records: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>,
): string[] {
  const tags = new Set<string>();
  for (const record of records) {
    const tag = extractMatterTag(record.metadata);
    if (tag) tags.add(tag);
  }
  return [...tags];
}

/**
 * Attribution precedence (the contract):
 *   1. A tag matching an existing matter wins outright — a direct tag always
 *      beats a rule.
 *   2. An UNKNOWN tag is never dropped and never auto-creates a matter; the
 *      record falls through to the rules, and with no matching rule it lands
 *      in the visible Unassigned bucket (matterId null).
 *   3. Rules evaluate in the order the context provides them (the loader's
 *      priority asc / createdAt asc / id asc); the first rule whose EVERY set
 *      matcher matches wins (agentCode exact, customerExternalId exact,
 *      signalPattern case-insensitive substring). A rule with no matchers set
 *      matches nothing — fails closed, mirroring canGrantRole.
 *      Lockstep edge with "Apply rules" (matter-rules.ts): ingest matches
 *      signalPattern against the DTO's signalName string, the retroactive
 *      sweep matches through the signals relation — an event stored with a
 *      null signalId can never be swept by a signalPattern rule that would
 *      have matched it here. Fails safe (stays visibly Unassigned).
 *   4. 'manual' never originates here; it is an operator action on the
 *      dashboard and outranks both of these on re-assignment.
 */
export function resolveMatterAttribution(
  record: {
    metadata?: Record<string, unknown> | null;
    agentCode: string;
    customerExternalId: string;
    signalName: string;
  },
  ctx: MatterAttributionContext,
): MatterAttribution {
  const tag = extractMatterTag(record.metadata);
  if (tag) {
    const taggedMatterId = ctx.matterIdByNumber.get(tag);
    if (taggedMatterId) {
      return { matterId: taggedMatterId, matterSource: 'tag' };
    }
  }

  const signalNameLower = record.signalName.toLowerCase();
  for (const rule of ctx.rules) {
    if (!rule.agentCode && !rule.customerExternalId && !rule.signalPattern) {
      continue;
    }
    if (rule.agentCode && rule.agentCode !== record.agentCode) continue;
    if (rule.customerExternalId && rule.customerExternalId !== record.customerExternalId) {
      continue;
    }
    if (rule.signalPattern && !signalNameLower.includes(rule.signalPattern.toLowerCase())) {
      continue;
    }
    return { matterId: rule.matterId, matterSource: 'rule' };
  }

  return { matterId: null, matterSource: null };
}
