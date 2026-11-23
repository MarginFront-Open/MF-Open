'use server'

/**
 * WHAT THIS FILE DOES: Server actions for matter routing rules —
 * the org-defined, priority-ordered sweeps that assign UNTAGGED usage events
 * to a matter, plus the explicit "Apply rules to unassigned" pass.
 *
 * WHY IT EXISTS: a firm whose agents don't tag every call still needs the
 * per-matter record; rules on agentCode / customerExternalId / signal-name
 * substring catch the bulk, and only what no rule matches stays visibly
 * Unassigned.
 *
 * CONNECTS TO: _shared/assert-law-manager.ts (the gate on every action),
 * matters.ts (manual assignment outranks rules), api-nest
 * matter-attribution.util.ts (the SAME matcher semantics at ingest — keep
 * the two in lockstep or an ingest-attributed event and an Apply-swept event
 * would disagree).
 */

import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
import { assertLawManager } from './_shared/assert-law-manager'

export type MatterRuleRow = {
  id: string
  matterId: string
  matterNumber: string
  matterName: string
  priority: number
  agentCode: string | null
  customerExternalId: string | null
  signalPattern: string | null
}

export type MatterRuleInput = {
  id?: string
  matterId: string
  priority?: number
  agentCode?: string | null
  customerExternalId?: string | null
  signalPattern?: string | null
}

/** The org's rules in EVALUATION order: priority asc, ties broken by
 * createdAt then id — the same ORDER BY the ingest loader and the Apply
 * sweep use, so the list on screen is the order that actually runs. */
export async function getMatterRules(): Promise<MatterRuleRow[]> {
  const gate = await assertLawManager()
  if (!gate.ok) return []
  const orgId = gate.orgId

  const rules = await db.matter_routing_rules.findMany({
    where: { orgId },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    include: { matters: { select: { matterNumber: true, name: true } } },
  })

  return rules.map((r) => ({
    id: r.id,
    matterId: r.matterId,
    matterNumber: r.matters.matterNumber,
    matterName: r.matters.name,
    priority: r.priority,
    agentCode: r.agentCode,
    customerExternalId: r.customerExternalId,
    signalPattern: r.signalPattern,
  }))
}

/** Trim to null so an all-whitespace matcher can never match everything. */
function normalizeMatcher(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export async function upsertMatterRule(
  input: MatterRuleInput
): Promise<{ success: boolean; ruleId?: string; error?: string }> {
  const gate = await assertLawManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  const agentCode = normalizeMatcher(input.agentCode)
  const customerExternalId = normalizeMatcher(input.customerExternalId)
  const signalPattern = normalizeMatcher(input.signalPattern)

  if (!agentCode && !customerExternalId && !signalPattern) {
    return {
      success: false,
      error:
        'A rule needs at least one matcher: an agent code, a customer ID, or a signal name pattern.',
    }
  }
  for (const [label, value] of [
    ['Agent code', agentCode],
    ['Customer ID', customerExternalId],
    ['Signal pattern', signalPattern],
  ] as const) {
    if (value && value.length > 255) {
      return {
        success: false,
        error: `${label} must be 255 characters or fewer.`,
      }
    }
  }

  // The target matter must live in this org — a cross-org matterId would let
  // one tenant route its events onto another tenant's matter record.
  const matter = await db.matters.findFirst({
    where: { id: input.matterId, orgId },
    select: { id: true },
  })
  if (!matter) {
    return { success: false, error: 'Matter not found in this organization.' }
  }

  const data = {
    matterId: input.matterId,
    priority: input.priority ?? 100,
    agentCode,
    customerExternalId,
    signalPattern,
  }

  try {
    if (input.id) {
      const updated = await db.matter_routing_rules.updateMany({
        where: { id: input.id, orgId },
        data,
      })
      if (updated.count === 0) {
        return { success: false, error: 'Rule not found in this organization.' }
      }
      revalidatePath('/law')
      return { success: true, ruleId: input.id }
    }

    const created = await db.matter_routing_rules.create({
      data: { orgId, ...data },
    })
    revalidatePath('/law')
    return { success: true, ruleId: created.id }
  } catch (err) {
    console.error('[upsertMatterRule] Error:', err)
    return {
      success: false,
      error: "Couldn't save the rule. Try again.",
    }
  }
}

export async function deleteMatterRule(
  id: string
): Promise<{ success: boolean; error?: string }> {
  const gate = await assertLawManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  try {
    const deleted = await db.matter_routing_rules.deleteMany({
      where: { id, orgId },
    })
    if (deleted.count === 0) {
      return { success: false, error: 'Rule not found in this organization.' }
    }
  } catch (err) {
    console.error('[deleteMatterRule] Error:', err)
    return {
      success: false,
      error: "Couldn't delete the rule. Try again.",
    }
  }

  revalidatePath('/law')
  return { success: true }
}

/**
 * The explicit retroactive pass: sweep events that have NO matter and NO
 * attribution history onto matters, rule by rule in priority order.
 *
 * Scope is (matterId IS NULL AND matterSource IS NULL) on purpose:
 *   - never overrides a tag, a rule, or a manual assignment (they have a
 *     matterId), and
 *   - never re-sweeps an event an operator manually UNASSIGNED (matterId
 *     null but matterSource 'manual' — see assignEventToMatter).
 * Priority order holds across rules because an earlier rule's updateMany
 * takes its matches out of the null set before the next rule runs.
 *
 * Lockstep edge with ingest (matter-attribution.util.ts): this sweep matches
 * signalPattern through the signals RELATION, ingest matches the DTO's
 * signalName STRING — an event stored with a null signalId can never be
 * swept by a signalPattern rule here even though the same rule would have
 * matched it at ingest. Fails safe: it stays visibly Unassigned.
 */
export async function applyMatterRulesToUnassigned(): Promise<{
  success: boolean
  assigned: number
  error?: string
}> {
  const gate = await assertLawManager()
  if (!gate.ok) return { success: false, assigned: 0, error: gate.error }
  const orgId = gate.orgId

  let assigned = 0
  try {
    const rules = await db.matter_routing_rules.findMany({
      where: { orgId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    })

    for (const rule of rules) {
      if (!rule.agentCode && !rule.customerExternalId && !rule.signalPattern) {
        continue
      }
      const result = await db.signal_events.updateMany({
        where: {
          organizationId: orgId,
          matterId: null,
          matterSource: null,
          ...(rule.agentCode ? { agents: { agentCode: rule.agentCode } } : {}),
          ...(rule.customerExternalId
            ? { customerExternalId: rule.customerExternalId }
            : {}),
          ...(rule.signalPattern
            ? {
                signals: {
                  name: { contains: rule.signalPattern, mode: 'insensitive' },
                },
              }
            : {}),
        },
        data: { matterId: rule.matterId, matterSource: 'rule' },
      })
      assigned += result.count
    }
  } catch (err) {
    console.error('[applyMatterRulesToUnassigned] Error:', err)
    // Earlier rules' updateMany calls already committed, so the counts on
    // screen are stale — revalidate even though the action failed.
    if (assigned > 0) revalidatePath('/law')
    return {
      success: false,
      assigned,
      error:
        assigned > 0
          ? `Stopped partway: ${assigned} events were assigned before the error. Run it again to finish the rest.`
          : "Couldn't apply the rules. Nothing changed. Try again.",
    }
  }

  revalidatePath('/law')
  return { success: true, assigned }
}
