'use server'

/**
 * Journal export, part of the MarginFront Finance Module.
 *
 * Rolls up AI cost (signal_events) by GL code for a period, producing
 * journal-entry rows an accountant can import into their ledger. The Chart
 * of Accounts (chart_of_accounts) maps each signal to a GL code via
 * signals.glCodeId; this action aggregates the actual spend against those
 * mappings.
 *
 * It produces a generic, ERP-agnostic shape. ERP-specific formatters
 * (QuickBooks IIF, NetSuite CSV, Xero CSV) are not included; check the
 * generic shape against your own ledger.
 *
 * Reads only. Uses the canonical-ish pattern:
 * pull the org's signals + their GL mapping (small), then aggregate events
 * (larger) against that map in memory. Thousands of events are
 * fine; at larger volumes the GROUP BY belongs in SQL.
 */

import { db } from '@/app/lib/db'
import { assertMoneyManager } from './_shared/assert-money-manager'
import { parseWindowFilter } from './_shared/parse-window-filter'
import { findLockedPeriod } from './_shared/period-lock-store'
// Imported (not defined here) because this is a 'use server' file and Next only
// allows it to export async functions — the const lives in a plain leaf module.
import { AUDIT_SOURCE_LABEL } from './_shared/audit-source-label'
// Category → default-GL fallback. When a signal is categorized but
// never got an explicit glCodeId (metered coding spend auto-tags DEVELOPMENT_RD
// at ingest but nothing fills in the GL link), book its cost to that category's
// GL account instead of dumping it in __unmapped. DEFAULT_GL_CODES is the seed a
// fresh org falls back to before it materializes its own chart of accounts.
import {
  resolveCategoryDefaultGl,
  DEFAULT_GL_CODES,
  type CategoryDefaultGl,
} from '@/features/cost-management/classification-utils'

export type JournalEntryRow = {
  /** GL code the cost is booked to. Null = signal not yet mapped to a code. */
  glCode: string | null
  /** Human-readable account name. "Unmapped: needs GL code" for null. */
  glName: string
  /** COGS | OPEX_RD | OPEX_GA | OPEX_SM, or null when unmapped. */
  accountingType: string | null
  /** Dollar amount booked to this line for the period. */
  amount: number
  /** Number of events that rolled up into this line. */
  eventCount: number
}

export type JournalExport = {
  periodStart: string // ISO
  periodEnd: string // ISO
  periodLabel: string
  rows: JournalEntryRow[]
  /** SUM of all rows. Reconciles to the Cost Management total cost for the window. */
  totalAmount: number
  /** Amount sitting in the Unmapped bucket — the "needs a GL code" signal. */
  unmappedAmount: number
  /** True when any cost is unmapped — drives the export-time warning. */
  hasUnmapped: boolean
  /**
   * Distinct signals behind the Unmapped bucket (journal semantics: a
   * categorized signal booking via its category's default GL is NOT counted).
   * Events with no signal count once as a synthetic member so this never reads
   * 0 while unmappedAmount is nonzero. OPTIONAL on purpose: a period-lock
   * snapshot without it still parses and consumers render "—" (do not bump
   * PERIOD_SNAPSHOT_VERSION for it).
   */
  unmappedSignalCount?: number
}

/**
 * Build the journal export for the active org over the given window (default
 * last 30 days). Grouped by GL code; unmapped signals collapse into a single
 * clearly-labeled bucket so no cost silently disappears from the export.
 * Returns null unless the caller holds an owner, admin or finance role.
 */
export async function getJournalExport(params?: {
  startDate?: string
  endDate?: string
}): Promise<JournalExport | null> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return null
  const orgId = gate.orgId

  const { windowStart, windowEnd } = parseWindowFilter(params)

  // PERIOD LOCK: if this exact window is a CLOSED period,
  // return the frozen journal snapshot instead of recomputing from live signal
  // state. Without this, reclassifying a signal (or remapping its GL code) would
  // silently rewrite a journal CSV the accountant already posted.
  const locked = await findLockedPeriod(orgId, windowStart, windowEnd)
  // The store types snapshot payloads as `unknown` to break a server-action
  // import cycle (see period-lock-store.ts); cast back to this fn's return type.
  if (locked) return locked.snapshot.journal as JournalExport

  // Signals are few (tens at most) — pull them with their GL mapping so we can
  // attribute each event to a GL code without an N+1. costCategory comes along
  // for the fallback below (a categorized-but-unmapped signal routes
  // to its category's GL account instead of __unmapped).
  const signals = await db.signals.findMany({
    where: { orgId, deletedAt: null },
    select: {
      id: true,
      glCodeId: true,
      costCategory: true,
      chart_of_accounts: {
        select: { glCode: true, glName: true, accountingType: true },
      },
    },
  })
  const signalToGl = new Map(
    signals.map((s) => {
      const gl = (
        s as unknown as {
          chart_of_accounts?: {
            glCode: string
            glName: string
            accountingType: string
          } | null
        }
      ).chart_of_accounts
      return [s.id, gl ?? null]
    })
  )
  // signal → its cost category, for the fallback. Defaults to UNCLASSIFIED,
  // which never falls back (see categoryToGl build below).
  const signalToCategory = new Map(
    signals.map((s) => [
      s.id,
      ((s as { costCategory?: string }).costCategory ??
        'UNCLASSIFIED') as string,
    ])
  )

  // Category fallback map: costCategory → the GL account that category books
  // to. Built from the org's own chart of accounts. A new org has NO
  // persisted chart_of_accounts rows (they're ephemeral `default:<glCode>` until
  // the first operator write — see getChartOfAccounts in chart-of-accounts.ts),
  // so mirror that here and fall back to the seed, otherwise 6800 wouldn't
  // resolve for a brand-new org. Org-scoped query (IDOR belt, same as every
  // other read in this function).
  const chartOfAccounts = await db.chart_of_accounts.findMany({
    where: { orgId },
  })
  const glCandidates =
    chartOfAccounts.length > 0 ? chartOfAccounts : DEFAULT_GL_CODES
  const categoryToGl = new Map<string, CategoryDefaultGl>()
  for (const category of new Set(glCandidates.map((g) => g.costCategory))) {
    const resolved = resolveCategoryDefaultGl(category, glCandidates)
    if (resolved) categoryToGl.set(category, resolved)
  }

  // Events in window. Select only what we need (signalId + usageCost) to keep
  // the payload small even at thousands of rows.
  const events = await db.signal_events.findMany({
    where: {
      organizationId: orgId,
      usageDate: { gte: windowStart, lte: windowEnd },
    },
    select: { signalId: true, usageCost: true },
  })

  // Aggregate by GL code. Key on glCode string (or '__unmapped' sentinel).
  const buckets = new Map<
    string,
    {
      glCode: string | null
      glName: string
      accountingType: string | null
      amount: number
      eventCount: number
    }
  >()

  const unmappedSignalIds = new Set<string>()
  let unmappedNullSignalSeen = false

  for (const ev of events) {
    // Direct operator mapping (signals.glCodeId) ALWAYS wins. Only when a signal
    // has no GL code do we fall back to its category's default GL —
    // so DEVELOPMENT_RD coding spend books to 6800 instead of __unmapped, while
    // never overriding a code an operator chose. UNCLASSIFIED has no entry in
    // categoryToGl, so it correctly stays __unmapped.
    const directGl = ev.signalId ? signalToGl.get(ev.signalId) : null
    const category = ev.signalId
      ? (signalToCategory.get(ev.signalId) ?? null)
      : null
    const gl =
      directGl ?? (category ? (categoryToGl.get(category) ?? null) : null)
    const key = gl ? gl.glCode : '__unmapped'
    if (key === '__unmapped') {
      if (ev.signalId) unmappedSignalIds.add(ev.signalId)
      else unmappedNullSignalSeen = true
    }
    const cost = ev.usageCost ? Number(ev.usageCost) : 0
    const existing = buckets.get(key)
    if (existing) {
      existing.amount += cost
      existing.eventCount += 1
    } else {
      buckets.set(key, {
        glCode: gl ? gl.glCode : null,
        glName: gl ? gl.glName : 'Unmapped: needs GL code',
        accountingType: gl ? gl.accountingType : null,
        amount: cost,
        eventCount: 1,
      })
    }
  }

  // Sort: mapped GL codes first (by code), unmapped last.
  const rows: JournalEntryRow[] = Array.from(buckets.values()).sort((a, b) => {
    if (a.glCode === null) return 1
    if (b.glCode === null) return -1
    return a.glCode.localeCompare(b.glCode)
  })

  const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0)
  const unmappedAmount = rows
    .filter((r) => r.glCode === null)
    .reduce((sum, r) => sum + r.amount, 0)

  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  return {
    periodStart: windowStart.toISOString(),
    periodEnd: windowEnd.toISOString(),
    periodLabel: `${fmt(windowStart)} → ${fmt(windowEnd)}`,
    rows,
    totalAmount,
    unmappedAmount,
    hasUnmapped: unmappedAmount > 0,
    unmappedSignalCount:
      unmappedSignalIds.size + (unmappedNullSignalSeen ? 1 : 0),
  }
}

/* -------------------------------------------------------------------------- */
/* Drillable audit trail                                          */
/* -------------------------------------------------------------------------- */

/**
 * WHAT THIS FILE DOES (this section): builds the *drillable* version of the
 * journal export. The rollup above (getJournalExport) gives an accountant one
 * row per GL code — good for posting, useless for an audit. A first-year
 * accountant who is asked "prove this $123 line" needs to click it and trace
 * it down to the actual usage events, the signal that produced them, and how
 * that signal was classified. This function returns exactly that chain:
 *
 *     GL code  →  the signals booked to it  →  each signal's usage events
 *                                           +  that signal's classification provenance
 *
 * HONESTY NOTE: provider invoices are not linked, so "source" here means the
 * INTERNAL source chain only: GL code ← signal ← usage events, plus the
 * classification history. We never fabricate a provider-invoice reference.
 * The UI/CSV label this honestly.
 *
 * CONNECTS TO: getJournalExport (above — the per-GL amounts MUST reconcile to
 * its rows, so it re-uses the same signal→GL map and the same event-cost
 * sum), the detail CSV
 * (app/api/export/journal/csv.ts → toDetailCsv), and the drill-through Sheet
 * in features/month-end-close/index.tsx.
 */

/** One usage event under a signal — the leaf of the audit trail. */
export type AuditEvent = {
  eventId: string
  /** ISO date the usage was recorded. */
  usageDate: string
  /** Dollar cost of this single event (canon C1: signal_events.usageCost). */
  usageCost: number
  /** production | staging | development | testing | null (untagged). */
  environment: string | null
  /** How many units of usage this event represents. */
  quantity: number
}

/**
 * The classification provenance for a signal. Null means the signal was never
 * manually overridden — it carries whatever the default/rule classification
 * gave it. We do NOT replay a rule engine; the signal's current costCategory
 * plus its override history is the truthful provenance.
 */
export type AuditClassification = {
  /** Where the override came from: inline_dropdown | bulk_suggest_button | api_patch. */
  source: string
  /** The category the operator chose at override time. */
  chosenCategory: string
  /** ISO timestamp the override was recorded. */
  classifiedAt: string
  /** Same value as `source` — a friendly alias the UI reads. */
  via: string
}

/** One contributing signal under a GL line, with its events + provenance. */
export type AuditSignal = {
  signalId: string
  signalName: string
  agentId: string
  /** Current cost category on the signal (PRODUCTION_COGS, etc.). */
  costCategory: string
  /** Latest manual override, or null = "default / not manually overridden". */
  classification: AuditClassification | null
  events: AuditEvent[]
}

/** One GL line with every signal + event that rolled up into it. */
export type AuditGlLine = {
  /** GL code, or null for the unmapped bucket. */
  glCode: string | null
  glName: string
  /** P&L line type (COGS / OPEX_RD / OPEX_GA / OPEX_SM), or null when unmapped. */
  accountingType: string | null
  /** Total dollars booked to this line — reconciles to getJournalExport. */
  amount: number
  /** Number of events that rolled up into this line. */
  eventCount: number
  signals: AuditSignal[]
}

export type JournalAuditDetail = {
  periodStart: string // ISO
  periodEnd: string // ISO
  periodLabel: string
  glLines: AuditGlLine[]
  /** SUM of all GL lines — reconciles to getJournalExport.totalAmount. */
  totalAmount: number
  /**
   * Honest provenance label. Provider invoices are not linked, so it says so
   * plainly. UI + CSV surface this verbatim so nobody mistakes the internal
   * chain for a vendor bill.
   */
  sourceLabel: string
}

// AUDIT_SOURCE_LABEL (the provenance one-liner) is imported from
// ./_shared/audit-source-label — it cannot be defined+exported here because a
// 'use server' file may only export async functions.

/**
 * Build the full drillable audit trail for the active org over the window
 * (default last 30 days), grouped by GL code.
 *
 * ORG SCOPING (IDOR — load-bearing): org is resolved exactly like
 * getJournalExport (money-role gate → the org it validated), and
 * EVERY Prisma query below filters by that org. We never query by signalId
 * alone. A leaked signal/event id from another org can't widen the result.
 */
export async function getJournalAuditDetail(params?: {
  startDate?: string
  endDate?: string
}): Promise<JournalAuditDetail | null> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return null
  const orgId = gate.orgId

  const { windowStart, windowEnd } = parseWindowFilter(params)

  // PERIOD LOCK: a closed period serves its frozen audit
  // trail, so the drill-through + detail CSV can't drift from the journal CSV
  // that was posted at close. Same guard as getJournalExport.
  const locked = await findLockedPeriod(orgId, windowStart, windowEnd)
  // Cast back from the store's `unknown` (cycle-break) to this fn's return type.
  if (locked) return locked.snapshot.audit as JournalAuditDetail

  // Signals for THIS org only, with their GL mapping + display fields. Same
  // signal→GL relation getJournalExport reads, so amounts reconcile.
  const signals = await db.signals.findMany({
    where: { orgId, deletedAt: null },
    select: {
      id: true,
      name: true,
      agentId: true,
      costCategory: true,
      glCodeId: true,
      chart_of_accounts: {
        select: { glCode: true, glName: true, accountingType: true },
      },
    },
  })

  // signal → its GL mapping. Duplicated from getJournalExport ON PURPOSE: with
  // 2 call sites, an exact copy keeps the two in lockstep without a shared
  // helper.
  const signalToGl = new Map(
    signals.map((s) => {
      const gl = (
        s as unknown as {
          chart_of_accounts?: {
            glCode: string
            glName: string
            accountingType: string
          } | null
        }
      ).chart_of_accounts
      return [s.id, gl ?? null]
    })
  )

  // signal → its display + classification fields, for building the per-signal
  // audit nodes. Keyed by signal id.
  const signalInfo = new Map(
    signals.map((s) => [
      s.id,
      {
        name: s.name,
        agentId: s.agentId,
        costCategory: ((s as { costCategory?: string }).costCategory ??
          'UNCLASSIFIED') as string,
      },
    ])
  )

  // Category fallback map: costCategory → its default GL account. Built
  // IDENTICALLY to getJournalExport (org-scoped chart of accounts, seed fallback
  // for a fresh org) so the two functions bucket the same events the same way
  // and their per-GL totals keep reconciling. Kept in lockstep with the rollup
  // on purpose, like signalToGl above.
  const chartOfAccounts = await db.chart_of_accounts.findMany({
    where: { orgId },
  })
  const glCandidates =
    chartOfAccounts.length > 0 ? chartOfAccounts : DEFAULT_GL_CODES
  const categoryToGl = new Map<string, CategoryDefaultGl>()
  for (const category of new Set(glCandidates.map((g) => g.costCategory))) {
    const resolved = resolveCategoryDefaultGl(category, glCandidates)
    if (resolved) categoryToGl.set(category, resolved)
  }

  // Events in window, THIS org only. We need more columns than the rollup
  // (eventId/date/env/quantity) because each event is a leaf in the trail.
  const events = await db.signal_events.findMany({
    where: {
      organizationId: orgId,
      usageDate: { gte: windowStart, lte: windowEnd },
    },
    select: {
      id: true,
      signalId: true,
      usageDate: true,
      usageCost: true,
      environment: true,
      quantity: true,
    },
  })

  // Latest manual override per signal, THIS org only. orderBy createdAt desc so
  // the first row we see for a signal is its most recent override. A signal
  // with no row = never manually overridden (classification stays null).
  const overrides = await db.signal_classification_overrides.findMany({
    where: { orgId },
    select: {
      signalId: true,
      source: true,
      chosenCategory: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  const latestOverride = new Map<string, AuditClassification>()
  for (const o of overrides) {
    if (latestOverride.has(o.signalId)) continue // desc order → first wins
    latestOverride.set(o.signalId, {
      source: String(o.source),
      chosenCategory: String(o.chosenCategory),
      classifiedAt: o.createdAt.toISOString(),
      via: String(o.source),
    })
  }

  // Group events: GL code → signal → events. Use the SAME bucketing rule as
  // getJournalExport (glCode string, or '__unmapped' sentinel) so totals match.
  type GlAccum = {
    glCode: string | null
    glName: string
    accountingType: string | null
    amount: number
    eventCount: number
    // signalId → its accumulating audit node
    signals: Map<string, AuditSignal>
  }
  const glBuckets = new Map<string, GlAccum>()

  for (const ev of events) {
    // Same fallback rule as getJournalExport: explicit glCodeId wins; a
    // categorized-but-unmapped signal routes to its category's default GL
    //SignalInfo already carries costCategory, so reuse it.
    const directGl = ev.signalId ? signalToGl.get(ev.signalId) : null
    const category = ev.signalId
      ? (signalInfo.get(ev.signalId)?.costCategory ?? null)
      : null
    const gl =
      directGl ?? (category ? (categoryToGl.get(category) ?? null) : null)
    const glKey = gl ? gl.glCode : '__unmapped'
    const cost = ev.usageCost ? Number(ev.usageCost) : 0

    let glBucket = glBuckets.get(glKey)
    if (!glBucket) {
      glBucket = {
        glCode: gl ? gl.glCode : null,
        glName: gl ? gl.glName : 'Unmapped: needs GL code',
        accountingType: gl ? gl.accountingType : null,
        amount: 0,
        eventCount: 0,
        signals: new Map(),
      }
      glBuckets.set(glKey, glBucket)
    }
    glBucket.amount += cost
    glBucket.eventCount += 1

    // Signal node. Events with no signalId roll into a synthetic
    // "__unsignaled" node so they're still visible in the trail, not dropped.
    const signalKey = ev.signalId ?? '__unsignaled'
    let signalNode = glBucket.signals.get(signalKey)
    if (!signalNode) {
      const info = ev.signalId ? signalInfo.get(ev.signalId) : undefined
      signalNode = {
        signalId: signalKey,
        signalName: info?.name ?? 'Unattributed usage (no signal)',
        agentId: info?.agentId ?? '',
        costCategory: info?.costCategory ?? 'UNCLASSIFIED',
        classification: ev.signalId
          ? (latestOverride.get(ev.signalId) ?? null)
          : null,
        events: [],
      }
      glBucket.signals.set(signalKey, signalNode)
    }
    signalNode.events.push({
      eventId: ev.id,
      usageDate: ev.usageDate.toISOString(),
      usageCost: cost,
      environment: ev.environment ? String(ev.environment) : null,
      quantity: ev.quantity ? Number(ev.quantity) : 0,
    })
  }

  // Sort: mapped GL codes first (by code), unmapped last — same order as the
  // rollup so the drill-through visually matches the table it expands from.
  const glLines: AuditGlLine[] = Array.from(glBuckets.values())
    .map((b) => ({
      glCode: b.glCode,
      glName: b.glName,
      accountingType: b.accountingType,
      amount: b.amount,
      eventCount: b.eventCount,
      signals: Array.from(b.signals.values()).sort((a, b) =>
        a.signalName.localeCompare(b.signalName)
      ),
    }))
    .sort((a, b) => {
      if (a.glCode === null) return 1
      if (b.glCode === null) return -1
      return a.glCode.localeCompare(b.glCode)
    })

  const totalAmount = glLines.reduce((sum, l) => sum + l.amount, 0)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  return {
    periodStart: windowStart.toISOString(),
    periodEnd: windowEnd.toISOString(),
    periodLabel: `${fmt(windowStart)} → ${fmt(windowEnd)}`,
    glLines,
    totalAmount,
    sourceLabel: AUDIT_SOURCE_LABEL,
  }
}
