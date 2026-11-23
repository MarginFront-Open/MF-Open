/**
 * cap-ceiling-precheck.ts — the dashboard's client-facing MIRROR of the
 * server's ceiling rule. It exists so a child (team/dev) cap that
 * breaks the org ceiling shows the error BEFORE the write reaches api-nest,
 * instead of the user submitting and bouncing off a 400.
 *
 * It does NOT re-implement the rule — it imports the exact same
 * `checkCapWithinCeiling` / `resolveApplicableCeiling` from `@marginfront/db` that
 * the api-nest write path uses, so the two can never drift. api-nest remains the
 * authoritative gate; this is a pre-flight UX guard, not enforcement.
 *
 * Deliberately NOT a `'use server'` file (it exports types too, like
 * assert-money-manager.ts) and NOT imported by any client component — importing
 * `@marginfront/db` into the browser bundle drags Prisma + node:fs and crashes at
 * runtime. The tab gets its instant client-side feedback from a plain NUMBER
 * (the applicable ceiling this helper resolves), handed down by the server
 * action; the shared RULE stays on the server.
 */

import {
  checkCapWithinCeiling,
  resolveApplicableCeiling,
  type CapScope,
  type OrgCeiling,
} from '@marginfront/db'

export interface CapCeilingPrecheck {
  ok: boolean
  /** Human message when ok is false (the shared rule's own reason), else null. */
  message: string | null
}

/**
 * Pre-validate a proposed cap against the org's current ceiling set, using the
 * shared rule. An org-scope cap has nothing above it (always ok); a team/dev cap
 * must be <= its applicable ceiling (same-provider ceiling wins, else the 'all'
 * fallback — resolved inside the shared function, never re-derived here).
 */
export function preValidateCapCeiling(input: {
  scope: CapScope
  providerScope: string
  amountUsd: number
  orgCeilings: OrgCeiling[]
}): CapCeilingPrecheck {
  const result = checkCapWithinCeiling(input)
  return { ok: result.ok, message: result.ok ? null : (result.reason ?? null) }
}

/**
 * The ceiling number that constrains a child cap for a given provider, or null
 * when none applies. Handed to the client so the tab can give as-you-type
 * feedback (amount > ceiling) without importing the shared rule into the
 * browser bundle.
 */
export function resolveCeilingForProvider(
  providerScope: string,
  orgCeilings: OrgCeiling[]
): number | null {
  return resolveApplicableCeiling(providerScope, orgCeilings)
}
