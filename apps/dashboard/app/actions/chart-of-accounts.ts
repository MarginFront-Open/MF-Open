'use server'

/**
 * Chart of Accounts server actions.
 *
 * Each org maintains a list of GL codes that signals get mapped to. The
 * accountant's view: "AI Inference (production) → 5100 AI Inference COGS."
 * Drives the journal-entry export (QuickBooks IIF /
 * NetSuite CSV / Xero CSV) so AI cost lands on the right P&L line.
 *
 * Same first-touch-materialization pattern as classification-rules.ts:
 * empty-org reads return ephemeral defaults (synthetic `default:<glCode>`
 * IDs); first user write materializes the defaults to the DB and applies
 * the change.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/app/lib/db'
import { revalidatePath } from 'next/cache'
// Server-side Manage-MONEY role gate. Editing the chart of accounts
// moves cost onto the P&L, so it's a money write — only owner/admin/finance.
import { assertMoneyManager } from './_shared/assert-money-manager'
import {
  DEFAULT_GL_CODES,
  CATEGORY_TO_ACCOUNTING_TYPE,
  type AccountingType,
  type CostCategoryKey,
  type GlCode,
} from '@/features/cost-management/classification-utils'

const ACCOUNTING_TYPE_KEYS: ReadonlyArray<AccountingType> = [
  'COGS',
  'OPEX_RD',
  'OPEX_GA',
  'OPEX_SM',
]

const CATEGORY_KEYS_NO_UNCLASSIFIED: ReadonlyArray<
  Exclude<CostCategoryKey, 'UNCLASSIFIED'>
> = [
  'PRODUCTION_COGS',
  'DEVELOPMENT_RD',
  'SALES_SM',
  'GENERAL_GA',
  'INTERNAL_TOOL',
]

type GlCodeInput = {
  glCode: string
  glName: string
  costCategory: Exclude<CostCategoryKey, 'UNCLASSIFIED'>
  accountingType: AccountingType
  description?: string | null
}

/**
 * Fetch the active org's chart of accounts, ordered by glCode ascending.
 *
 * Returns the seed defaults as ephemeral rows (`default:<glCode>` IDs) when
 * the org has none persisted. The defaults show in the UI and let signal
 * mapping work out-of-the-box; first explicit write (add/delete/restore)
 * materializes them as real rows.
 */
export async function getChartOfAccounts(): Promise<GlCode[]> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) return []
  const orgId = session.session.activeOrganizationId

  const existing = await db.chart_of_accounts.findMany({
    where: { orgId },
    orderBy: { glCode: 'asc' },
  })

  if (existing.length > 0) {
    return existing.map(serializeGlCode)
  }

  return DEFAULT_GL_CODES.map((g) => ({
    id: `default:${g.glCode}`,
    glCode: g.glCode,
    glName: g.glName,
    costCategory: g.costCategory,
    accountingType: g.accountingType,
    isDefault: true,
    description: g.description,
  }))
}

/**
 * Materialize the default GL codes if the org has none. Idempotent.
 */
async function ensureDefaultsPersisted(orgId: string): Promise<void> {
  const count = await db.chart_of_accounts.count({ where: { orgId } })
  if (count > 0) return
  await db.chart_of_accounts.createMany({
    data: DEFAULT_GL_CODES.map((g) => ({
      orgId,
      glCode: g.glCode,
      glName: g.glName,
      costCategory: g.costCategory,
      accountingType: g.accountingType,
      description: g.description,
      isDefault: true,
    })),
    skipDuplicates: true,
  })
}

/**
 * Resolve a possibly-synthetic GL code ID (`default:<glCode>`) to a real
 * DB row ID. Materializes defaults first if needed.
 */
async function resolveGlCodeId(
  orgId: string,
  id: string
): Promise<string | null> {
  if (!id.startsWith('default:')) {
    const owned = await db.chart_of_accounts.findFirst({
      where: { id, orgId },
      select: { id: true },
    })
    return owned?.id ?? null
  }
  await ensureDefaultsPersisted(orgId)
  const glCode = id.slice('default:'.length)
  const row = await db.chart_of_accounts.findFirst({
    where: { orgId, glCode },
    select: { id: true },
  })
  return row?.id ?? null
}

/**
 * Create or update a GL code. Synthetic `default:` IDs trigger
 * materialization, then update the real row.
 */
export async function upsertGlCode(
  input: GlCodeInput & { id?: string }
): Promise<{ success: boolean; glCode?: GlCode; error?: string }> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  const glCodeTrim = input.glCode.trim()
  const glNameTrim = input.glName.trim()
  if (!glCodeTrim) return { success: false, error: 'GL code is required' }
  if (!glNameTrim) return { success: false, error: 'GL name is required' }
  if (glCodeTrim.length > 50) {
    return { success: false, error: 'GL code must be ≤ 50 characters' }
  }
  if (glNameTrim.length > 255) {
    return { success: false, error: 'GL name must be ≤ 255 characters' }
  }
  if (!CATEGORY_KEYS_NO_UNCLASSIFIED.includes(input.costCategory)) {
    return {
      success: false,
      error: `Invalid cost category: ${input.costCategory}`,
    }
  }
  if (!ACCOUNTING_TYPE_KEYS.includes(input.accountingType)) {
    return {
      success: false,
      error: `Invalid accounting type: ${input.accountingType}`,
    }
  }

  // The cost category and accounting type must agree. Each category
  // has exactly one valid accounting type (CATEGORY_TO_ACCOUNTING_TYPE), and
  // the exported journal/P&L line keys on accountingType while the dashboard
  // charts key on costCategory — so a mismatched pair silently moves cost to
  // the wrong side of the gross-margin line and inflates reported margin with
  // nothing flagging it. This is the load-bearing gate: it protects the create
  // path, the update path, AND any direct API caller, not just the UI dropdown.
  const expectedAccountingType = CATEGORY_TO_ACCOUNTING_TYPE[input.costCategory]
  if (input.accountingType !== expectedAccountingType) {
    return {
      success: false,
      error: `Cost category ${input.costCategory} must use accounting type ${expectedAccountingType}. Accounting type is authoritative for the exported P&L.`,
    }
  }

  try {
    if (input.id) {
      const resolvedId = await resolveGlCodeId(orgId, input.id)
      if (!resolvedId) return { success: false, error: 'GL code not found' }
      const updated = await db.chart_of_accounts.update({
        where: { id: resolvedId },
        data: {
          glCode: glCodeTrim,
          glName: glNameTrim,
          costCategory: input.costCategory,
          accountingType: input.accountingType,
          description: input.description?.trim() || null,
          isDefault: false,
        },
      })
      revalidatePath('/cost-management')
      return { success: true, glCode: serializeGlCode(updated) }
    }

    // Materialize defaults before adding a new code so the list stays stable.
    await ensureDefaultsPersisted(orgId)
    const created = await db.chart_of_accounts.create({
      data: {
        orgId,
        glCode: glCodeTrim,
        glName: glNameTrim,
        costCategory: input.costCategory,
        accountingType: input.accountingType,
        description: input.description?.trim() || null,
        isDefault: false,
      },
    })
    revalidatePath('/cost-management')
    return { success: true, glCode: serializeGlCode(created) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.includes('Unique constraint')) {
      return {
        success: false,
        error: 'A GL code with that number already exists in this org.',
      }
    }
    return { success: false, error: msg }
  }
}

/**
 * Delete a single GL code. Synthetic `default:` IDs materialize first so
 * the delete sticks. Signals mapped to the deleted GL code have their
 * `glCodeId` set to null (cascade is SetNull on the FK).
 *
 * Returns `orphanedSignalCount` — how many signals were un-mapped
 * by this delete — so the caller can tell the operator (success toast) and so
 * the deletion is never silent. The count is measured BEFORE the delete, while
 * the FK still points at the GL code.
 */
export async function deleteGlCode(id: string): Promise<{
  success: boolean
  error?: string
  orphanedSignalCount?: number
}> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  const resolvedId = await resolveGlCodeId(orgId, id)
  if (!resolvedId) return { success: false, error: 'GL code not found' }

  // Count what this delete will un-map, BEFORE the SetNull cascade fires.
  // Org-scoped so we never count another org's signals.
  const orphanedSignalCount = await db.signals.count({
    where: { glCodeId: resolvedId, orgId, deletedAt: null },
  })

  await db.chart_of_accounts.delete({ where: { id: resolvedId } })
  revalidatePath('/cost-management')
  return { success: true, orphanedSignalCount }
}

/**
 * Count how many of the active org's signals are currently mapped
 * to a GL code. Powers the delete-confirmation dialog ("this will un-map N
 * signals") so the operator sees the blast radius BEFORE committing.
 *
 * Pure read — unlike `deleteGlCode` it deliberately does NOT materialize the
 * synthetic defaults: a `default:<glCode>` that hasn't been persisted yet has
 * no real row for any signal to point at, so its orphan count is, by
 * definition, 0. Materializing on a read (dialog open) would be a surprising
 * write side-effect. Org-scoped.
 */
export async function getGlCodeSignalCount(
  id: string
): Promise<{ success: boolean; count: number; error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return { success: false, count: 0, error: 'Not authenticated' }
  }
  const orgId = session.session.activeOrganizationId

  let resolvedId: string | null = null
  if (id.startsWith('default:')) {
    const glCode = id.slice('default:'.length)
    const row = await db.chart_of_accounts.findFirst({
      where: { orgId, glCode },
      select: { id: true },
    })
    resolvedId = row?.id ?? null
  } else {
    const owned = await db.chart_of_accounts.findFirst({
      where: { id, orgId },
      select: { id: true },
    })
    resolvedId = owned?.id ?? null
  }
  if (!resolvedId) return { success: true, count: 0 }

  const count = await db.signals.count({
    where: { glCodeId: resolvedId, orgId, deletedAt: null },
  })
  return { success: true, count }
}

/**
 * Count signals whose cost bucket disagrees with their mapped GL
 * code's accounting type: rows the `upsertGlCode` cross-check never saw, such
 * as ones written through a direct API call.
 *
 * The dashboard charts trust `signals.costCategory`; the exported P&L trusts
 * `chart_of_accounts.accountingType`. When the two disagree, real cost lands on
 * the wrong side of the gross-margin line on the export while the charts say
 * otherwise — a silent margin distortion. The editor renders a banner when
 * this count is > 0 so the operator can find and fix the offenders.
 *
 * We can't express the cross-column comparison in a Prisma `where`, so we pull
 * the (small, org-scoped) set of mapped+categorized signals with their joined
 * accountingType and compare in app code against the canonical map. Org-scoped.
 */
export async function getMismatchedSignalCount(): Promise<{
  success: boolean
  count: number
  error?: string
}> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return { success: false, count: 0, error: 'Not authenticated' }
  }
  const orgId = session.session.activeOrganizationId

  const mapped = await db.signals.findMany({
    where: {
      orgId,
      deletedAt: null,
      glCodeId: { not: null },
      costCategory: { not: 'UNCLASSIFIED' },
    },
    select: {
      costCategory: true,
      chart_of_accounts: { select: { accountingType: true } },
    },
  })

  const count = mapped.reduce((running, signal) => {
    const actualType = signal.chart_of_accounts?.accountingType
    if (!actualType) return running
    const expectedType =
      CATEGORY_TO_ACCOUNTING_TYPE[
        signal.costCategory as Exclude<CostCategoryKey, 'UNCLASSIFIED'>
      ]
    return actualType !== expectedType ? running + 1 : running
  }, 0)

  return { success: true, count }
}

/**
 * Restore the seed GL code set. Deletes only `isDefault = true` rows,
 * re-inserts the canonical defaults. User-added codes are preserved.
 */
export async function restoreDefaultGlCodes(): Promise<{
  success: boolean
  count: number
  error?: string
}> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, count: 0, error: gate.error }
  const orgId = gate.orgId

  await db.$transaction([
    db.chart_of_accounts.deleteMany({ where: { orgId, isDefault: true } }),
    db.chart_of_accounts.createMany({
      data: DEFAULT_GL_CODES.map((g) => ({
        orgId,
        glCode: g.glCode,
        glName: g.glName,
        costCategory: g.costCategory,
        accountingType: g.accountingType,
        description: g.description,
        isDefault: true,
      })),
      skipDuplicates: true,
    }),
  ])

  revalidatePath('/cost-management')
  return { success: true, count: DEFAULT_GL_CODES.length }
}

/**
 * Map a signal to a GL code. Passing `glCodeId = null` clears the mapping.
 * Synthetic `default:` IDs trigger materialization first.
 */
export async function assignSignalToGlCode(
  signalId: string,
  glCodeId: string | null
): Promise<{ success: boolean; error?: string }> {
  const gate = await assertMoneyManager()
  if (!gate.ok) return { success: false, error: gate.error }
  const orgId = gate.orgId

  const signal = await db.signals.findFirst({
    where: { id: signalId, orgId, deletedAt: null },
    select: { id: true },
  })
  if (!signal) return { success: false, error: 'Signal not found' }

  let resolvedGlCodeId: string | null = null
  if (glCodeId) {
    resolvedGlCodeId = await resolveGlCodeId(orgId, glCodeId)
    if (!resolvedGlCodeId) {
      return { success: false, error: 'GL code not found in this org' }
    }
  }

  await db.signals.update({
    where: { id: signalId },
    data: { glCodeId: resolvedGlCodeId, updatedAt: new Date() } as never,
  })

  revalidatePath('/cost-management')
  return { success: true }
}

function serializeGlCode(r: {
  id: string
  glCode: string
  glName: string
  costCategory: string
  accountingType: string
  isDefault: boolean
  description: string | null
}): GlCode {
  return {
    id: r.id,
    glCode: r.glCode,
    glName: r.glName,
    costCategory: r.costCategory as Exclude<CostCategoryKey, 'UNCLASSIFIED'>,
    accountingType: r.accountingType as AccountingType,
    isDefault: r.isDefault,
    description: r.description,
  }
}
