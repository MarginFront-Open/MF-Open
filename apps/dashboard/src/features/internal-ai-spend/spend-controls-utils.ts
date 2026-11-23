/**
 * Pure display + math helpers for the Spend Controls tab. These
 * carry NO React and NO `@marginfront/db` import on purpose: a `'use client'`
 * component imports this file, and value-importing `@marginfront/db` from a client
 * bundle drags its Prisma + node:fs chain into the browser and crashes at
 * runtime (the same rule canon-format.ts is pinned against). So the shared
 * ceiling RULE stays server-side (cap-ceiling-precheck.ts); this file only does
 * self-contained string + arithmetic work the tab renders, and every export is
 * unit-tested in node-env jest.
 */

import type {
  AlertRecipientsView,
  CapMode,
  CapPeriod,
  CapScope,
  ToolCoverageView,
} from '@/features/money/spend-controls-types'

/**
 * How a provider string renders in human copy. `all` is "AI" (the sentence
 * reads "Stop AI spend"); known providers get their product name. An unknown
 * provider (the set is open — a new vendor appears without a code change) falls
 * back to the raw string so we never hide a cap behind a blank label.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  all: 'AI',
  anthropic: 'Claude',
  openai: 'Codex (OpenAI)',
}

export function providerLabel(providerScope: string): string {
  return PROVIDER_LABELS[providerScope] ?? providerScope
}

export const PERIOD_LABELS: Record<CapPeriod, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
}

/** The "per ___" phrase for a cap's scope, used in the sentence. */
function scopePhrase(scope: CapScope, scopeValue: string | null): string {
  if (scope === 'org') return 'across the whole team'
  if (scope === 'team') return `per person on team "${scopeValue ?? ''}"`
  // dev
  return scopeValue ? `for ${scopeValue}` : 'per teammate'
}

/**
 * Format a dollar amount for the plain-English cap sentence: whole dollars with
 * thousands separators ("$200", "$1,500"). This is display sugar for the
 * sentence only; the authoritative money format on tiles and bars routes
 * through canon-format's formatCost, so this deliberately does NOT try to be
 * that formatter.
 */
export function sentenceMoney(amountUsd: number): string {
  return `$${Number(amountUsd).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}

export interface CapSentenceParts {
  providerScope: string
  amountUsd: number
  scope: CapScope
  scopeValue: string | null
  period: CapPeriod
}

/**
 * The labeled bet: the cap as one sentence. Example output:
 *   "Stop Claude spend at $200 for alice@acme.example per week"
 *   "Stop AI spend at $5,000 across the whole team per month"
 */
export function buildCapSentence(parts: CapSentenceParts): string {
  return (
    `Stop ${providerLabel(parts.providerScope)} spend at ` +
    `${sentenceMoney(parts.amountUsd)} ` +
    `${scopePhrase(parts.scope, parts.scopeValue)} ` +
    `per ${PERIOD_LABELS[parts.period]}`
  )
}

// ── Coverage, one line per tool ─────────────────────────────────

export type CoverageToolName = 'Claude Code' | 'Codex'

/** Shown instead of the two tool lines when neither tool saw anyone. */
export const COVERAGE_NO_ACTIVITY_LINE =
  "The meter hasn't seen anyone coding in the last 7 days."

/** Coverage folds by git email, so several machines under one email are ONE entry
 * at the least protected machine. A reader who thinks the counts are padded by
 * extra machines discounts a real gap. */
export const COVERAGE_ROSTER_NOTE =
  'This is who the meter has seen coding in the last 7 days, not your Users list and not your seat count. We tell people apart by the email their code is signed with. Someone using two of those emails counts as two people here. Someone using two machines under one email counts once, and we show them at their least protected machine.'

export const COVERAGE_SEPARATE_COUNTS_NOTE =
  "The two lines count separately. Someone who uses both tools shows up in both, so the numbers won't add up to your team size."

/** Arming is a hook receipt: true with zero caps configured, and true for a cap
 * set to watch only. The caps sit on a different subtab, so without this nothing
 * on screen corrects a reader who takes the headline as "spend is capped". */
export const COVERAGE_CHECK_SCOPE_NOTE =
  "These lines count the check itself, not your caps. A machine can have the check running when you haven't set a cap at all, or when the cap you set only watches and warns."

/** The sentence that stops a clean-looking number reading as a promise. Tool-neutral
 * on purpose: a teammate with no coding-turn record is unknown for either tool, so
 * naming Codex alone would let a reader dismiss a real Claude gap as a blind spot. */
export const COVERAGE_UNKNOWN_NOTE =
  "We can't always tell. It happens when a machine is running an older version of the meter, when Codex didn't answer us about that machine, or when we've seen someone's activity but nothing that tells us how their machine is set up. We count none of those as protected."

/** Codex resolves hooks per working directory and the meter asks about one: the
 * machine's main setup. Saying so beats implying per-project coverage we cannot see
 * (CODEX_TRUST_SCOPE_CWD in code-cost-clarity's forwarder). */
export const COVERAGE_CODEX_SCOPE_NOTE =
  "For Codex we read each machine's main setup. If one project on that machine turns the check off for itself, we won't see it."

// ── Caps we can't draw a bar for yet ─────────────────────────────────────────
// Constants, not inline JSX, so the copy style gate (copy-style-gate.test.ts)
// reads them.

export const CAP_NO_BAR_TEAM =
  "We don't total team spend yet, so there's no bar for this cap. It's saved and tracked."

export const CAP_NO_BAR_PROVIDER =
  "We don't break spend out per provider yet, so there's no bar for this cap. It's saved and tracked."

/**
 * Keeps the three buckets from over-filling the denominator, so a late stamp can
 * never read "18 of 17".
 *
 * Unknown is clamped FIRST and armed takes what's left. That order matters: this
 * function only runs on numbers we already distrust, and whichever bucket is
 * clamped second is the one that gets shrunk. Shrinking armed leaves a reader
 * with "we can't tell", which is the safe way to be wrong. Shrinking unknown
 * deletes the caveat and leaves a bare "5 of 5 covered", which is the exact
 * overstatement this whole feature exists to kill.
 */
export function clampToolCoverage(c: ToolCoverageView): ToolCoverageView {
  const total = Math.max(0, Math.trunc(c.total))
  const unknown = Math.min(Math.max(0, Math.trunc(c.unknown)), total)
  const armed = Math.min(Math.max(0, Math.trunc(c.armed)), total - unknown)
  return { armed, notArmed: total - armed - unknown, unknown, total }
}

/**
 * One tool, one plain sentence. Two wording rules earn their keep:
 * - "the CAP CHECK running", not "the cap running". An org with zero caps would
 *   otherwise read "5 of 5 have the cap running" here and "No caps yet." next door.
 * - "1 of those 5", not "1 of them". After a sentence naming two numbers, "them"
 *   attaches to either, and the readings differ on how many people are uncovered.
 */
export function toolCoverageLine(
  toolName: CoverageToolName,
  counts: ToolCoverageView
): string {
  const { armed, unknown, total } = clampToolCoverage(counts)
  if (total === 0) {
    return `${toolName}: nobody's used it in the last 7 days.`
  }
  const teammateWord = total === 1 ? 'teammate' : 'teammates'
  if (unknown === total) {
    const whom = total === 1 ? 'for them' : 'for any of them'
    return (
      `${toolName}: ${total} ${teammateWord} used it in the last 7 days, ` +
      `and we can't tell whether the cap check is running ${whom}.`
    )
  }
  const verb = armed === 1 ? 'has' : 'have'
  const head =
    `${toolName}: ${armed} of ${total} ${teammateWord} who used it ` +
    `in the last 7 days ${verb} the cap check running on every machine we've seen.`
  if (unknown === 0) return head
  return `${head} We can't tell for ${unknown} of those ${total}.`
}

// ── Where alerts go ─────────────────────────────────────────────────────

/**
 * One line naming who gets the cap alert emails, from the same recipient chain
 * api-nest's evaluator resolves (billing contact, else owner/finance members) —
 * so the tab never implies a warning reaches someone it can't.
 */
export function alertRecipientsLine(alerts: AlertRecipientsView): string {
  if (alerts.billingEmail) return `Alerts go to ${alerts.billingEmail}.`
  if (alerts.fallbackCount > 0) {
    return 'Alerts go to your owner and finance teammates. Set a billing email in Settings to change this.'
  }
  return "Alerts can't reach anyone yet. Add a billing email in Settings so someone gets them."
}

// ── Pace (a hedged linear projection) ────────────────────────────────────────

export type PaceStatus = 'reached' | 'projected' | 'under-pace' | 'unknown'

export interface PaceResult {
  status: PaceStatus
  /** UTC weekday name when status === 'projected' (e.g. "Thursday"), else null. */
  weekday: string | null
}

const UTC_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/**
 * Linear projection of when spend crosses the cap, from window-elapsed vs
 * spend-so-far. Deliberately an ESTIMATE and labeled as one by the caller
 * ("on track to hit the cap ~Thursday"), never a promise.
 *
 * - Already at/over the cap -> 'reached'.
 * - No priced spend yet, or no elapsed time -> 'unknown' (honest: we can't
 *   project from nothing; the caller renders "not enough data to project").
 * - Projected crossing lands after the window ends -> 'under-pace' (won't hit
 *   the cap this period at the current rate).
 * - Otherwise -> 'projected' with the UTC weekday it's on track to cross.
 */
export function projectPace(input: {
  spentUsd: number | null
  amountUsd: number
  windowStartMs: number
  windowEndMs: number
  nowMs: number
}): PaceResult {
  const { spentUsd, amountUsd, windowStartMs, windowEndMs, nowMs } = input
  if (spentUsd !== null && spentUsd >= amountUsd) {
    return { status: 'reached', weekday: null }
  }
  const elapsedMs = nowMs - windowStartMs
  if (spentUsd === null || spentUsd <= 0 || elapsedMs <= 0 || amountUsd <= 0) {
    return { status: 'unknown', weekday: null }
  }
  const ratePerMs = spentUsd / elapsedMs
  const msToHit = amountUsd / ratePerMs
  const hitMs = windowStartMs + msToHit
  if (hitMs > windowEndMs) {
    return { status: 'under-pace', weekday: null }
  }
  const weekday = UTC_WEEKDAYS[new Date(hitMs).getUTCDay()]
  return { status: 'projected', weekday }
}

/** The one place pace status becomes a hedged sentence. */
export function paceCopy(pace: PaceResult): string {
  switch (pace.status) {
    case 'reached':
      return 'The cap is reached for this period.'
    case 'projected':
      return `On track to hit the cap ~${pace.weekday} (estimate).`
    case 'under-pace':
      return 'Under pace. Not projected to hit the cap this period (estimate).'
    case 'unknown':
      return 'Not enough spend yet to project a pace.'
  }
}

// ── Ceiling pre-check (instant, client-side) ─────────────────────────────────

export interface CeilingCheck {
  ok: boolean
  message: string | null
}

/**
 * Instant client-side feedback that a child (team/dev) cap sits within the org
 * ceiling. The WHICH-ceiling-applies rule (same-provider wins, else the 'all'
 * fallback) is resolved SERVER-side by the shared @marginfront/db rule and handed
 * here as a plain number, so this file never forks that logic — it only does
 * the trivial `> ceiling` comparison for as-you-type feedback. The server
 * action re-runs the full shared rule before any write, and api-nest is the
 * authoritative gate.
 */
/**
 * Which org ceiling applies to a child cap for a given provider, for INSTANT
 * client feedback: a same-provider ceiling wins, else the 'all'-provider
 * ceiling, else none. This is a deliberate minimal mirror of @marginfront/db's
 * resolveApplicableCeiling (which can't be imported into the client bundle) —
 * the server action and api-nest re-resolve with the real shared rule before any
 * write, so a drift here can only soften a hint, never bypass the ceiling.
 */
export function pickApplicableCeiling(
  providerScope: string,
  orgCeilings: ReadonlyArray<{ providerScope: string; amountUsd: number }>
): number | null {
  const exact = orgCeilings.find((c) => c.providerScope === providerScope)
  if (exact) return exact.amountUsd
  if (providerScope !== 'all') {
    const all = orgCeilings.find((c) => c.providerScope === 'all')
    if (all) return all.amountUsd
  }
  return null
}

export function checkAmountAgainstCeiling(
  amountUsd: number,
  applicableCeilingUsd: number | null
): CeilingCheck {
  if (applicableCeilingUsd === null) return { ok: true, message: null }
  if (amountUsd > applicableCeilingUsd) {
    return {
      ok: false,
      message:
        `That's above your ${sentenceMoney(applicableCeilingUsd)} org ceiling. ` +
        `A teammate cap can't be higher than the org ceiling it sits under.`,
    }
  }
  return { ok: true, message: null }
}

// ── Mode copy (track vs enforce — never blur alert and block) ─────────────────

export interface ModeCopy {
  label: string
  tagline: string
  /** What the 100%-reached line says for this mode. */
  atCap: string
}

/**
 * Track vs enforce copy. The product's core trust claim is "the cap that
 * actually caps", so track-mode copy NEVER claims it stops or blocks anything —
 * a test asserts the literal strings to keep it that way.
 */
export const MODE_COPY: Record<CapMode, ModeCopy> = {
  track: {
    label: 'Track',
    tagline: 'Watch and warn only. Work always keeps going.',
    atCap:
      'Heads up: this cap is reached. This is a notification, not enforcement. Work keeps going.',
  },
  enforce: {
    label: 'Enforce',
    tagline:
      'A real stop. Armed machines pause Claude Code and Codex once the cap is reached.',
    atCap:
      'Cap reached. New Claude Code and Codex tool calls are stopped on machines where this cap is armed.',
  },
}

export function modeCopy(mode: CapMode): ModeCopy {
  return MODE_COPY[mode]
}

// ── Freshness ────────────────────────────────────────────────────────────────

/**
 * "as of 12 minutes ago" — the freshness label that rides every number on this
 * tab so nothing reads as fake-realtime. Null asOf -> honest "freshness
 * unknown" rather than a made-up time.
 */
export function freshnessLabel(asOfMs: number | null, nowMs: number): string {
  if (asOfMs === null) return 'freshness unknown'
  const deltaSec = Math.max(0, Math.round((nowMs - asOfMs) / 1000))
  if (deltaSec < 60) return 'as of moments ago'
  const mins = Math.round(deltaSec / 60)
  if (mins < 60) return `as of ${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `as of ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `as of ${days} day${days === 1 ? '' : 's'} ago`
}
