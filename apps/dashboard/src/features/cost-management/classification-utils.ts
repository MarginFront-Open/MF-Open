/**
 * Pure (non-server) classification helpers for the Cost Management UI.
 *
 * Lives outside the `'use server'` files in `app/actions/` because Next.js
 * App Router requires every export from a server-actions module to be an
 * async function. This is the synchronous evaluator the panel uses to
 * preview a suggested COGS/R&D/Internal bucket from a signal's name.
 *
 * Keep this file free of imports from `auth`, `db`, `headers`, or anything
 * else that pulls in server-only code.
 */

export type CostCategoryKey =
  | 'PRODUCTION_COGS'
  | 'DEVELOPMENT_RD'
  | 'SALES_SM'
  | 'GENERAL_GA'
  | 'INTERNAL_TOOL'
  | 'UNCLASSIFIED'

/**
 * GAAP-aligned accounting type for a GL code. Drives which line of the P&L
 * the cost shows up on:
 *   - COGS    — Cost of Goods Sold (above gross margin)
 *   - OPEX_RD — Research & Development (below gross margin)
 *   - OPEX_GA — General & Administrative (below gross margin)
 *   - OPEX_SM — Sales & Marketing (below gross margin)
 */
export type AccountingType = 'COGS' | 'OPEX_RD' | 'OPEX_GA' | 'OPEX_SM'

/**
 * A single chart-of-accounts entry. Sourced from `chart_of_accounts` table
 * per org. Signals are mapped to a GL code via `signals.glCodeId`. The
 * accountant maintains this list; defaults are seeded from a standard
 * framework.
 */
export type GlCode = {
  id: string
  glCode: string
  glName: string
  costCategory: Exclude<CostCategoryKey, 'UNCLASSIFIED'>
  accountingType: AccountingType
  isDefault: boolean
  description: string | null
}

/**
 * The seed GL code set used to initialize a new org's chart of accounts.
 * Numbers + names follow a standard AI-cost framework:
 *   - 5xxx series = COGS (above gross margin)
 *   - 6xxx series = R&D (below gross margin, OpEx)
 *   - 7xxx series = G&A / internal tooling (below gross margin, OpEx)
 *   - 8xxx series = Sales & Marketing (below gross margin, OpEx)
 */
export const DEFAULT_GL_CODES: ReadonlyArray<{
  glCode: string
  glName: string
  costCategory: Exclude<CostCategoryKey, 'UNCLASSIFIED'>
  accountingType: AccountingType
  description: string
}> = [
  {
    glCode: '5100',
    glName: 'AI Inference: Production COGS',
    costCategory: 'PRODUCTION_COGS',
    accountingType: 'COGS',
    description:
      'LLM and other AI inference costs for production traffic serving paying customers. The primary AI COGS bucket.',
  },
  {
    glCode: '5110',
    glName: 'AI Infrastructure: Vector DBs & Orchestration',
    costCategory: 'PRODUCTION_COGS',
    accountingType: 'COGS',
    description:
      'Vector database queries, orchestration platforms, retrieval infrastructure: anything in the AI request path for production.',
  },
  {
    glCode: '5120',
    glName: 'AI Monitoring & Observability',
    costCategory: 'PRODUCTION_COGS',
    accountingType: 'COGS',
    description:
      'AI-specific observability tools (LangSmith, Helicone, etc.) used to monitor production AI behavior.',
  },
  {
    glCode: '6800',
    glName: 'AI R&D: Experiments & Model Development',
    costCategory: 'DEVELOPMENT_RD',
    accountingType: 'OPEX_RD',
    description:
      'AI usage for development, evaluation, and model experiments. Lives below gross margin per ASC 730.',
  },
  {
    glCode: '7100',
    glName: 'Internal AI Tooling',
    costCategory: 'INTERNAL_TOOL',
    accountingType: 'OPEX_GA',
    description:
      'AI usage by internal teams (support, ops) for productivity. Not customer-facing; not R&D. G&A OpEx.',
  },
  {
    glCode: '7200',
    glName: 'AI: General & Administrative',
    costCategory: 'GENERAL_GA',
    accountingType: 'OPEX_GA',
    description:
      'AI usage by G&A functions (finance, legal, HR, exec). Below gross margin, G&A OpEx.',
  },
  {
    glCode: '8000',
    glName: 'AI: Sales & Marketing',
    costCategory: 'SALES_SM',
    accountingType: 'OPEX_SM',
    description:
      'AI usage driving sales & marketing (sales agents, outbound, CRM enrichment, content generation). Below gross margin, S&M OpEx.',
  },
]

/**
 * THE canonical Category → Accounting-Type mapping.
 *
 * WHY THIS EXISTS: a GL code carries two fields that have to agree —
 *   `costCategory` (what the dashboard charts bucket on) and `accountingType`
 *   (what the exported journal / P&L line keys on). If they were set
 *   independently, you could pair "Production COGS" with an "R&D" type. When
 *   they disagree, real production cost slides below the
 *   gross-margin line on the export while the charts still show it as COGS —
 *   reported margin looks better than it is, with nothing flagging the
 *   contradiction. This map makes the relationship a single deterministic
 *   function so the two can never silently drift.
 *
 * AUTHORITATIVE FOR THE P&L: when the two ever conflict, `accountingType` is
 *   the source of truth for the exported journal/P&L (journal-export.ts keys
 *   on it); the dashboard charts key on `costCategory`. This map is what keeps
 *   them consistent — the UI derives the type from the category, and the
 *   `upsertGlCode` server action rejects any pair that violates it.
 *
 * ONE-WAY ONLY (Category → Type): the inverse is NOT a function — OPEX_GA maps
 *   from BOTH General & Admin and Internal tooling — so never derive a Category
 *   from a Type. The pairs here MUST stay consistent with `DEFAULT_GL_CODES`
 *   above; a unit test asserts that (chart-of-accounts-validation.test.ts).
 */
export const CATEGORY_TO_ACCOUNTING_TYPE: Record<
  Exclude<CostCategoryKey, 'UNCLASSIFIED'>,
  AccountingType
> = {
  PRODUCTION_COGS: 'COGS',
  DEVELOPMENT_RD: 'OPEX_RD',
  SALES_SM: 'OPEX_SM',
  GENERAL_GA: 'OPEX_GA',
  INTERNAL_TOOL: 'OPEX_GA',
}

/**
 * Display labels for the cost categories, the canonical copy. Two private
 * copies exist (cost-command-center.ts, which can't export it ('use server'),
 * and the finops-settings editors); new callers import THIS one.
 */
export const COST_CATEGORY_LABELS: Record<CostCategoryKey, string> = {
  PRODUCTION_COGS: 'Production COGS',
  DEVELOPMENT_RD: 'Development / R&D',
  SALES_SM: 'Sales & Marketing',
  GENERAL_GA: 'General & Admin',
  INTERNAL_TOOL: 'Internal tooling',
  UNCLASSIFIED: 'Unclassified',
}

/**
 * A single classification rule. Sourced from the
 * `signal_classification_rules` table per org. Lower `priority` = matched
 * first. `agentId === null` means org-wide; otherwise the rule only applies
 * to signals on that agent (lets different agents reuse the same signal
 * name with different classifications).
 */
export type ClassificationRule = {
  id: string
  pattern: string
  category: Exclude<CostCategoryKey, 'UNCLASSIFIED'>
  priority: number
  agentId: string | null
  isDefault: boolean
}

/**
 * The seed rule list used to initialize a new org. Mirrors
 * suggestCostCategoryForSignalName: R&D keywords are checked first, so
 * INTERNAL_TOOL rules sort below the DEVELOPMENT_RD rules. With explicit
 * priorities the operator can re-order via the dashboard.
 *
 * Example: a signal name containing both "dev" and "internal" matches "dev"
 * first → DEVELOPMENT_RD.
 */
export const DEFAULT_CLASSIFICATION_RULES: ReadonlyArray<{
  pattern: string
  category: Exclude<CostCategoryKey, 'UNCLASSIFIED'>
  priority: number
}> = [
  { pattern: 'test', category: 'DEVELOPMENT_RD', priority: 10 },
  { pattern: 'dev', category: 'DEVELOPMENT_RD', priority: 20 },
  { pattern: 'debug', category: 'DEVELOPMENT_RD', priority: 30 },
  { pattern: 'staging', category: 'DEVELOPMENT_RD', priority: 40 },
  { pattern: 'sandbox', category: 'DEVELOPMENT_RD', priority: 50 },
  { pattern: 'internal', category: 'INTERNAL_TOOL', priority: 60 },
  { pattern: 'admin', category: 'INTERNAL_TOOL', priority: 70 },
  { pattern: 'ops', category: 'INTERNAL_TOOL', priority: 80 },
  { pattern: 'sales', category: 'SALES_SM', priority: 90 },
  { pattern: 'crm', category: 'SALES_SM', priority: 100 },
  { pattern: 'outbound', category: 'SALES_SM', priority: 110 },
  { pattern: 'marketing', category: 'SALES_SM', priority: 120 },
  { pattern: 'finance', category: 'GENERAL_GA', priority: 130 },
  { pattern: 'legal', category: 'GENERAL_GA', priority: 140 },
  { pattern: 'billing', category: 'GENERAL_GA', priority: 150 },
]

/**
 * Evaluate a signal name against an ordered rule list. Returns the first
 * matching rule's category, or `null` if no rule matches.
 *
 * Match semantics:
 *  - Case-insensitive substring (`signal.name.toLowerCase().includes(...)`)
 *  - Rule.agentId === null applies to every signal in the org
 *  - Rule.agentId === signal.agentId applies only to that agent's signals
 *  - Rules are evaluated in `priority` ascending order
 *
 * Returning `null` (rather than `PRODUCTION_COGS`) lets callers decide
 * the fallback. The Suggest button defaults `null` → `PRODUCTION_COGS`.
 */
export function evaluateRulesForSignal(
  signalName: string,
  signalAgentId: string,
  rules: ReadonlyArray<ClassificationRule>
): CostCategoryKey | null {
  const lower = signalName.toLowerCase()
  const applicable = rules
    .filter((r) => r.agentId === null || r.agentId === signalAgentId)
    .slice()
    .sort((a, b) => a.priority - b.priority)
  for (const rule of applicable) {
    if (lower.includes(rule.pattern.toLowerCase())) {
      return rule.category
    }
  }
  return null
}

/**
 * The minimum shape `resolveCategoryDefaultGl` needs from a chart-of-accounts
 * entry. Deliberately structural so BOTH a materialized `chart_of_accounts`
 * Prisma row AND a `DEFAULT_GL_CODES` seed entry satisfy it — the seed has no
 * `isDefault` field, so it's optional here and a missing value reads as "not
 * the default".
 */
export type CategoryGlCandidate = {
  glCode: string
  glName: string
  costCategory: string
  accountingType: string
  isDefault?: boolean
}

/**
 * The slice of a GL account the journal needs to book a fallback-routed event:
 * which code, its display name, and its P&L line type. (No `id` — the journal
 * keys/labels rows by these three; it never persists this resolution.)
 */
export type CategoryDefaultGl = {
  glCode: string
  glName: string
  accountingType: string
}

/**
 * WHAT THIS DOES: given a cost category (e.g. DEVELOPMENT_RD) and an
 * org's chart of accounts, return the GL account that category should book to
 * (e.g. 6800 "AI R&D") — or null if there's no GL account for it.
 *
 * WHY IT EXISTS: a signal can be categorized at ingest (metered coding spend
 * auto-tags as DEVELOPMENT_RD) yet never get an explicit `glCodeId` — nothing
 * auto-fills that link. The exported journal keys its P&L lines on `glCodeId`,
 * so those dollars land in the "Unmapped" pile even though we already know
 * which line they belong on. This function is the read-side bridge: it lets the
 * journal fall back from "no GL code on the signal" to "the GL account this
 * category maps to" without ever writing to the signal (so an operator's manual
 * mapping, and the "needs a GL code" coverage signal, are both preserved).
 *
 * DETERMINISTIC PICK within a category, so the same chart always resolves the
 * same way regardless of row order:
 *   1. An operator-flagged default (`isDefault === true`) wins.
 *   2. Otherwise the lowest GL code number (ascending) wins — so DEVELOPMENT_RD
 *      → 6800 (its only seeded account) and PRODUCTION_COGS → 5100 (not the
 *      5110/5120 sub-accounts).
 *
 * UNCLASSIFIED is never a real GL category (a signal with no category shouldn't
 * be auto-booked anywhere), so it always returns null.
 *
 * CONNECTS TO: app/actions/journal-export.ts (getJournalExport +
 * getJournalAuditDetail both call this for their fallback) and DEFAULT_GL_CODES
 * above (the seed an org falls back to before it materializes its own chart).
 */
export function resolveCategoryDefaultGl(
  category: string,
  glCodes: ReadonlyArray<CategoryGlCandidate>
): CategoryDefaultGl | null {
  if (!category || category === 'UNCLASSIFIED') return null

  const matches = glCodes.filter((g) => g.costCategory === category)
  if (matches.length === 0) return null

  const best = matches.slice().sort((a, b) => {
    // isDefault first (0 sorts before 1), then GL code ascending. GL codes are
    // fixed-width numeric strings, so localeCompare == numeric order here and
    // matches the sort getJournalExport already uses for its rows.
    const aDefault = a.isDefault === true ? 0 : 1
    const bDefault = b.isDefault === true ? 0 : 1
    if (aDefault !== bDefault) return aDefault - bDefault
    return a.glCode.localeCompare(b.glCode)
  })[0]

  return {
    glCode: best.glCode,
    glName: best.glName,
    accountingType: best.accountingType,
  }
}

/**
 * Heuristic suggestion used when no rule matches a signal. Conservative
 * on purpose — we'd rather mark something COGS and have the operator
 * downgrade it than the other way around.
 *
 * Prefer `evaluateRulesForSignal` for new code; this is the fallback.
 */
export function suggestCostCategoryForSignalName(
  name: string
): CostCategoryKey {
  const lower = name.toLowerCase()
  if (
    lower.includes('test') ||
    lower.includes('dev') ||
    lower.includes('debug') ||
    lower.includes('staging') ||
    lower.includes('sandbox')
  ) {
    return 'DEVELOPMENT_RD'
  }
  if (
    lower.includes('internal') ||
    lower.includes('admin') ||
    lower.includes('ops')
  ) {
    return 'INTERNAL_TOOL'
  }
  if (
    lower.includes('sales') ||
    lower.includes('crm') ||
    lower.includes('outbound') ||
    lower.includes('marketing')
  ) {
    return 'SALES_SM'
  }
  if (
    lower.includes('finance') ||
    lower.includes('legal') ||
    lower.includes('billing')
  ) {
    return 'GENERAL_GA'
  }
  return 'PRODUCTION_COGS'
}
