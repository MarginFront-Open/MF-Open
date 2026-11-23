/**
 * WHAT THIS FILE DOES: the pure window + dedup rules for Customer Watch Alerts
 * — given a watch's window mode and "now", says what date range to
 * measure and which windowStart keys the dedup ledger. Dependency-free (no DB,
 * no Nest) so every caller shares one implementation, same as cap-policy.ts.
 * CONNECTS TO: apps/api-nest customer-alerts.service.ts (the evaluator), the
 * create/update DTO validation, and packages/mcp tool schemas.
 */

import { currentPeriodWindow } from "./cap-policy";

export const CUSTOMER_ALERT_METRICS = ["cost", "revenue"] as const;
export type CustomerAlertMetric = (typeof CUSTOMER_ALERT_METRICS)[number];

/// The dashboard period selector's own mode vocabulary (date-range.ts):
/// 'month' = This month (current UTC calendar month), 'rolling' = Last 30
/// days, 'custom' = a fixed range. Alert windows mirror that selector,
/// nothing else.
export const CUSTOMER_ALERT_WINDOW_MODES = [
  "month",
  "rolling",
  "custom",
] as const;
export type CustomerAlertWindowMode =
  (typeof CUSTOMER_ALERT_WINDOW_MODES)[number];

export const CUSTOMER_ALERT_ROLLING_DAYS = 30;

/// Per-org ceiling on active watches: every watch costs
/// a full canonical metrics read per evaluation, on the ingest hot path's
/// 5-minute debounce, so the count needs a fixed ceiling.
export const CUSTOMER_ALERT_MAX_PER_ORG = 100;

export function isCustomerAlertMetric(v: string): v is CustomerAlertMetric {
  return (CUSTOMER_ALERT_METRICS as readonly string[]).includes(v);
}

export function isCustomerAlertWindowMode(
  v: string,
): v is CustomerAlertWindowMode {
  return (CUSTOMER_ALERT_WINDOW_MODES as readonly string[]).includes(v);
}

export interface CustomerAlertWindowConfig {
  windowMode: string;
  customStartDate: Date | null;
  customEndDate: Date | null;
}

export type CustomerAlertEvaluationPlan =
  | {
      skip: null;
      /** The range the canonical metrics read measures. */
      window: { start: Date; end: Date };
      /** The dedup key: one ledger/notification row per (alertId, this value). */
      dedupWindowStart: Date;
    }
  | {
      /**
       * not_started: custom window is in the future — nothing to measure yet.
       * expired: past customEndDate ("expires at range end").
       * invalid: custom mode missing its dates, or an unknown mode (the DTO
       *          rejects both; this guards hand-inserted rows honestly instead
       *          of measuring a window we cannot define).
       */
      skip: "not_started" | "expired" | "invalid";
      window: null;
      dedupWindowStart: null;
    };

export function utcDayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * The one rule the evaluator calls per alert per sweep. Mode semantics:
 *
 * - month:   currentPeriodWindow('month', now) — UTC calendar-month start to
 *            now. dedupWindowStart = the month start, so a watch fires at most
 *            once per month and a new month re-arms it (cap-alert mechanics).
 * - rolling: {now − 30d, now}. Fire-once-per-crossing is the triggeredAt latch
 *            (evaluator-owned state, not window math); dedupWindowStart = UTC
 *            day-start of the fire moment, the race belt under that latch.
 * - custom:  the stored fixed range. dedupWindowStart = customStartDate, so
 *            the unique key allows exactly one fire ever. Skips before the
 *            range opens and after it closes.
 */
export function resolveCustomerAlertEvaluation(
  alert: CustomerAlertWindowConfig,
  now: Date,
): CustomerAlertEvaluationPlan {
  if (alert.windowMode === "month") {
    const window = currentPeriodWindow("month", now);
    return { skip: null, window, dedupWindowStart: window.start };
  }

  if (alert.windowMode === "rolling") {
    const start = new Date(
      now.getTime() - CUSTOMER_ALERT_ROLLING_DAYS * 24 * 60 * 60 * 1000,
    );
    return {
      skip: null,
      window: { start, end: now },
      dedupWindowStart: utcDayStart(now),
    };
  }

  if (alert.windowMode === "custom") {
    const start = alert.customStartDate;
    const end = alert.customEndDate;
    if (!start || !end || start.getTime() >= end.getTime()) {
      return { skip: "invalid", window: null, dedupWindowStart: null };
    }
    if (now.getTime() < start.getTime()) {
      return { skip: "not_started", window: null, dedupWindowStart: null };
    }
    if (now.getTime() > end.getTime()) {
      return { skip: "expired", window: null, dedupWindowStart: null };
    }
    // now is inside the range: measure range-start to now (equivalent to
    // clamping the range at now, since now <= end here).
    return {
      skip: null,
      window: { start, end: now },
      dedupWindowStart: start,
    };
  }

  return { skip: "invalid", window: null, dedupWindowStart: null };
}
