/**
 * Client-safe credit-pool contracts.
 *
 * Types only — no runtime, no `@marginfront/db` (a `'use client'` component that
 * value-imports that package drags its Prisma chain into the browser bundle).
 * Both a `'use server'` action, which may export ONLY async functions, and a
 * client component can import from here.
 */

/** Under this much of the pool left, a pool is worth a human's attention. */
export const NEAR_EMPTY_PERCENT = 20

/** One credit pool as the dashboard renders it. Dates arrive as epoch ms so a
 * server action can hand them to a client component without a Date round-trip. */
export interface CreditPoolBalanceView {
  subscriptionId: string
  subscriptionName: string
  customerId: string
  customerName: string | null
  customerExternalId: string | null
  agentId: string
  planId: string
  planName: string | null
  /** The pool the plan sells, in usage units. */
  poolSizeUnits: number
  /** Units drawn inside the current period. Top-up blind. */
  consumedUnits: number
  /** Units left, top-ups included. Negative once the pool is overdrawn. */
  remainingUnits: number
  /**
   * Units already billing as overage this period — the invoice's own math
   * (usage past the pool size, top-up blind). Deliberately NOT derived from
   * remainingUnits: a topped-up pool has units left AND overage on the bill.
   */
  overageInProgressUnits: number
  /** remainingUnits as a percent of poolSizeUnits. Negative once overdrawn. */
  remainingPercent: number
  /** Per-unit overage price, or null when the plan's tiers can't say. */
  overageRatePerUnit: number | null
  /** Null when the subscription has no billing period yet — honest absence. */
  periodStartMs: number | null
  periodEndMs: number | null
  alertsPaused: boolean
  noActivePeriod: boolean
  implicitFullPool: boolean
}

export interface CreditPoolPermission {
  canManage: boolean
  /** Who may add credits or change alerts, in plain English. */
  whoCanChange: string
}

export interface CreditPoolsData {
  permission: CreditPoolPermission
  balances: CreditPoolBalanceView[]
  asOfMs: number
}

/** The needs-attention third section's payload. Paused pools are LISTED and
 * labeled, never hidden: pausing changes emails, not the number. */
export interface ExhaustedCreditPoolsData {
  permission: CreditPoolPermission
  pools: CreditPoolBalanceView[]
  /** Pools at or past zero. */
  exhaustedCount: number
  /** Pools under NEAR_EMPTY_PERCENT but not yet at zero. */
  nearEmptyCount: number
}

export type CreditPoolActionResult<T = { ok: true }> =
  | { success: true; data: T }
  | { success: false; error: string }

/** True when a pool is at or past zero. Nothing is blocked; the overage bills. */
export function isPoolExhausted(pool: CreditPoolBalanceView): boolean {
  return pool.remainingUnits <= 0
}

/** True when a pool still has units but is inside the near-empty band. */
export function isPoolNearEmpty(pool: CreditPoolBalanceView): boolean {
  return pool.remainingUnits > 0 && pool.remainingPercent < NEAR_EMPTY_PERCENT
}
