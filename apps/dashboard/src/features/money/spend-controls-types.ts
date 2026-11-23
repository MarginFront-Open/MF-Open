/**
 * Client-safe cap vocabulary for the Spend Controls tab.
 *
 * The ONE source of truth for these closed sets is packages/db/src/lib/
 * cap-policy.ts (CAP_SCOPES / CAP_PERIODS / CAP_MODES). They are MIRRORED here —
 * not imported — for the same reason code-cost-clarity mirrors them: a
 * `'use client'` component that value-imports `@marginfront/db` drags its Prisma +
 * node:fs chain into the browser bundle and crashes at runtime. Keep in sync
 * with cap-policy.ts if the platform ever adds a scope/period/mode. The server
 * side (actions + api-nest) still validates against the real @marginfront/db sets,
 * so a drift here can only mis-render an option, never bypass enforcement.
 */

export const CAP_SCOPES = ['org', 'team', 'dev'] as const
export type CapScope = (typeof CAP_SCOPES)[number]

export const CAP_PERIODS = ['day', 'week', 'month'] as const
export type CapPeriod = (typeof CAP_PERIODS)[number]

export const CAP_MODES = ['track', 'enforce'] as const
export type CapMode = (typeof CAP_MODES)[number]

export const CAP_PROVIDER_SCOPE_ALL = 'all'

// ── Data contracts (shared by the server action and the client tab) ──────────
// These are types only (no runtime, no @marginfront/db), so both a 'use server'
// action — which may export ONLY async functions — and a 'use client' component
// can import them.

/** One cap as the tab renders it: the stored policy plus the spend the read
 * model can honestly total for its scope. */
export interface CapView {
  id: string
  scope: CapScope
  scopeValue: string | null
  providerScope: string
  amountUsd: number
  period: CapPeriod
  mode: CapMode
  coolOffHours: number | null
  /** Spend for this cap's scope in the current period window; null = no priced
   * usage yet (honest absence, never a coerced 0). */
  spentUsd: number | null
  /** False for team and provider-scoped caps: this read model has no team total
   * and no per-provider total, so we show the cap without a fake spend number
   * (mirrors the device, which tracks those caps without enforcing them). */
  spendComputable: boolean
  windowStartMs: number
  windowEndMs: number
}

/** Distinct developers who used THAT tool in the window, not the org roster.
 * `unknown` is a machine we could not vouch for, never counted as covered. */
export interface ToolCoverageView {
  armed: number
  notArmed: number
  unknown: number
  total: number
}

export interface CoverageView {
  /** Blended count across both tools. The tab does NOT render it: one
   * number across two tools would mislead. */
  armed: number
  /** Blended count across both tools. Not the sum of the two per-tool totals. */
  total: number
  /** Newest event time seen in the window, for the freshness label; null when
   * there's no recent activity to date. */
  asOfMs: number | null
  claudeCode: ToolCoverageView
  codex: ToolCoverageView
}

export interface OrgCeilingView {
  providerScope: string
  amountUsd: number
}

export interface CapManagePermission {
  canManage: boolean
  /** Plain line for read-only viewers, e.g. "Only an owner or finance can change caps." */
  whoCanChange: string
}

/** Where cap alert emails go — the tab's mirror of api-nest's recipient
 * chain: the billing contact when one is set, else owner/finance teammates. */
export interface AlertRecipientsView {
  billingEmail: string | null
  /** Distinct owner/finance teammates who'd hear alerts when no billing email
   * is set. */
  fallbackCount: number
}

export interface SpendControlsData {
  permission: CapManagePermission
  /** The org's name, for the install kit's admin note. */
  orgName: string
  /** Who's viewing/sending the kit — surfaced as "who set the cap" in the kit. */
  setterName: string
  caps: CapView[]
  coverage: CoverageView
  alerts: AlertRecipientsView
  /** Org ceilings by provider, handed to the client for instant ceiling feedback. */
  orgCeilings: OrgCeilingView[]
  prefill: {
    /** Org spend over the trailing 7 days — the sentence's prefilled amount hint. */
    typicalWeekUsd: number | null
    /** Distinct teammate emails seen in the window — the dev-target picker. */
    rosterEmails: string[]
  }
  asOfMs: number
}

export interface CreateCapInput {
  scope: CapScope
  scopeValue?: string
  providerScope: string
  amountUsd: number
  period: CapPeriod
  mode: CapMode
  coolOffHours?: number
}

export interface UpdateCapInput {
  amountUsd?: number
  period?: CapPeriod
  mode?: CapMode
  coolOffHours?: number
}

export type CapActionResult<T = { ok: true }> =
  | { success: true; data: T }
  | { success: false; error: string }
