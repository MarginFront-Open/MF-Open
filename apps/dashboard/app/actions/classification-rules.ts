'use server'

/**
 * Classification rule server actions.
 *
 * The "Suggest classifications" button on the Cost Management page runs a
 * per-org editable rule list, stored in `signal_classification_rules`.
 *
 * Auth + org scoping follow the same pattern as cost-command-center.ts and
 * signal-classification.ts: org from the active session before any read or
 * write.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Classification rules drive how cost is bucketed onto the P&L, so
// editing them is a money write — gate on owner/admin/finance.
import { assertMoneyManager } from './_shared/assert-money-manager'
import {
  DEFAULT_CLASSIFICATION_RULES,
  type CostCategoryKey,
  type ClassificationRule,
} from '@/features/cost-management/classification-utils'

const RULE_CATEGORY_KEYS: ReadonlyArray<
  Exclude<CostCategoryKey, 'UNCLASSIFIED'>
> = [
  'PRODUCTION_COGS',
  'DEVELOPMENT_RD',
  'SALES_SM',
  'GENERAL_GA',
  'INTERNAL_TOOL',
]

type RuleInput = {
  pattern: string
  category: Exclude<CostCategoryKey, 'UNCLASSIFIED'>
  priority?: number
  agentId?: string | null
}

/**
 * Fetch the active org's rule list, ordered by priority ascending.
 *
 * When the org has no rules yet, returns the seed defaults as ephemeral
 * rows with synthetic IDs (`default:<pattern>`) — they show in the UI and
 * drive the Suggest button, but aren't persisted to the DB until the user
 * actually modifies them or hits "Restore defaults" / "Add rule". This
 * keeps the action read-only on first load and
 * avoids polluting the DB for orgs that never touch classification.
 */
export async function getClassificationRules(): Promise<ClassificationRule[]> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return []
  const orgId = session.session.activeOrganizationId

  const existing = await db.signal_classification_rules.findMany({
    where: { orgId },
    orderBy: { priority: 'asc' },
  })

  if (existing.length > 0) {
    return existing.map(serializeRule)
  }

  return DEFAULT_CLASSIFICATION_RULES.map((r) => ({
    id: `default:${r.pattern}`,
    pattern: r.pattern,
    category: r.category,
    priority: r.priority,
    agentId: null,
    isDefault: true,
  }))
}

/**
 * First-touch materialization: if the org has zero persisted rules, write
 * the default set. Called by every write action so the synthetic
 * `default:<pattern>` IDs returned by `getClassificationRules` resolve to
 * real DB rows on first edit/delete. Idempotent — no-op if rules already
 * exist.
 */
async function ensureDefaultsPersisted(orgId: string): Promise<void> {
  const count = await db.signal_classification_rules.count({ where: { orgId } })
  if (count > 0) return
  await db.signal_classification_rules.createMany({
    data: DEFAULT_CLASSIFICATION_RULES.map((r) => ({
      orgId,
      pattern: r.pattern,
      category: r.category,
      priority: r.priority,
      agentId: null,
      isDefault: true,
    })),
    skipDuplicates: true,
  })
}

/**
 * Resolve a possibly-synthetic rule ID (`default:<pattern>`) to a real DB
 * row ID for the active org. Materializes defaults first if needed.
 */
async function resolveRuleId(
  orgId: string,
  id: string
): Promise<string | null> {
  if (!id.startsWith('default:')) {
    const owned = await db.signal_classification_rules.findFirst({
      where: { id, orgId },
      select: { id: true },
    })
    return owned?.id ?? null
  }
  await ensureDefaultsPersisted(orgId)
  const pattern = id.slice('default:'.length)
  const row = await db.signal_classification_rules.findFirst({
    where: { orgId, pattern, agentId: null },
    select: { id: true },
  })
  return row?.id ?? null
}

/**
 * Create or update a classification rule for the active org. If `id` is
 * provided, updates; otherwise creates a new rule. Adding a rule also
 * materializes the defaults (if not already persisted) so the list the
 * user sees stays consistent.
 */
export async function upsertClassificationRule(
  input: RuleInput & { id?: string }
): Promise<{ success: boolean; rule?: ClassificationRule; error?: string }> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  const trimmed = input.pattern.trim()
  if (!trimmed) {
    return { success: false, error: 'Pattern cannot be empty' }
  }
  if (trimmed.length > 255) {
    return { success: false, error: 'Pattern must be ≤ 255 characters' }
  }
  if (!RULE_CATEGORY_KEYS.includes(input.category)) {
    return {
      success: false,
      error: `Invalid category: ${input.category} (must be one of ${RULE_CATEGORY_KEYS.join(', ')})`,
    }
  }

  // If agentId is provided, verify it belongs to this org. Cross-org leak
  // would let an attacker bind a rule to another tenant's agent.
  if (input.agentId) {
    const agent = await db.agents.findFirst({
      where: { id: input.agentId, orgId, deletedAt: null },
      select: { id: true },
    })
    if (!agent) {
      return { success: false, error: 'Agent not found in this organization' }
    }
  }

  const priority = input.priority ?? 100

  try {
    if (input.id) {
      // Resolve synthetic `default:` IDs to real DB rows; materializes
      // defaults if needed. Returns null if the id can't be found.
      const resolvedId = await resolveRuleId(orgId, input.id)
      if (!resolvedId) {
        return { success: false, error: 'Rule not found' }
      }
      const updated = await db.signal_classification_rules.update({
        where: { id: resolvedId },
        data: {
          pattern: trimmed,
          category: input.category,
          priority,
          agentId: input.agentId ?? null,
          isDefault: false,
        },
      })
      revalidatePath('/cost-management')
      return { success: true, rule: serializeRule(updated) }
    }

    // For new-rule creates, materialize defaults first so the list the
    // user sees stays stable (the ephemeral defaults don't disappear
    // when the user adds their first custom rule).
    await ensureDefaultsPersisted(orgId)
    const created = await db.signal_classification_rules.create({
      data: {
        orgId,
        pattern: trimmed,
        category: input.category,
        priority,
        agentId: input.agentId ?? null,
        isDefault: false,
      },
    })
    revalidatePath('/cost-management')
    return { success: true, rule: serializeRule(created) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.includes('Unique constraint')) {
      return {
        success: false,
        error: 'A rule with this pattern + agent scope already exists.',
      }
    }
    return { success: false, error: msg }
  }
}

/**
 * Delete a single rule. Synthetic `default:<pattern>` IDs trigger
 * materialization first (so the delete actually sticks instead of the
 * ephemeral default reappearing on next read). No-op if the rule doesn't
 * belong to the active org.
 */
export async function deleteClassificationRule(
  id: string
): Promise<{ success: boolean; error?: string }> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  const resolvedId = await resolveRuleId(orgId, id)
  if (!resolvedId) {
    return { success: false, error: 'Rule not found' }
  }

  await db.signal_classification_rules.delete({ where: { id: resolvedId } })
  revalidatePath('/cost-management')
  return { success: true }
}

/**
 * Restore the seed rule set: deletes only the rules currently marked
 * `isDefault = true`, then re-inserts the canonical defaults. User-added
 * rules are preserved. Used by the "Restore defaults" affordance.
 */
export async function restoreDefaultClassificationRules(): Promise<{
  success: boolean
  count: number
  error?: string
}> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, count: 0, error: gate.error }
  const orgId = gate.orgId

  await db.$transaction([
    db.signal_classification_rules.deleteMany({
      where: { orgId, isDefault: true },
    }),
    db.signal_classification_rules.createMany({
      data: DEFAULT_CLASSIFICATION_RULES.map((r) => ({
        orgId,
        pattern: r.pattern,
        category: r.category,
        priority: r.priority,
        agentId: null,
        isDefault: true,
      })),
      skipDuplicates: true,
    }),
  ])

  revalidatePath('/cost-management')
  return { success: true, count: DEFAULT_CLASSIFICATION_RULES.length }
}

function serializeRule(r: {
  id: string
  pattern: string
  category: string
  priority: number
  agentId: string | null
  isDefault: boolean
}): ClassificationRule {
  return {
    id: r.id,
    pattern: r.pattern,
    category: r.category as Exclude<CostCategoryKey, 'UNCLASSIFIED'>,
    priority: r.priority,
    agentId: r.agentId,
    isDefault: r.isDefault,
  }
}
