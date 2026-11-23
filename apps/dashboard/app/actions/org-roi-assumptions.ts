'use server'

/**
 * The org's without-AI numbers — the method the customer picked
 * for estimating what the same work would have cost without AI, and the
 * figures that method needs. We cannot measure any of it, so the ROI report's
 * "Without AI" comparison renders nothing until it is here.
 *
 * A near copy of org-billing-identity.ts, with one deliberate difference: the
 * write takes the MONEY roles rather than assertOrgManager, because this is
 * money copy behind the money page's own gate. Role checked in the caller's
 * active org and written to exactly the org the gate validated.
 */

import { headers } from 'next/headers'
import { z } from 'zod'
import { auth } from '@/app/lib/auth'
import { db, Prisma } from '@/app/lib/db'
import { assertMoneyManager } from './_shared/assert-money-manager'

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/** Mirrors RoiAssumptions in features/roi/report-derivation.ts. A 'use server'
 *  file may only export async functions, so the shape is re-declared rather
 *  than re-exported; without-ai.test.ts pins the two field lists together. */
export interface OrgRoiAssumptions {
  method?: 'perItem' | 'peopleTime' | 'periodTotal'
  unitSingular?: string
  unitPlural?: string
  costPerItem?: number
  hoursPerMonth?: number
  hourlyRate?: number
  costPerMonth?: number
  revenuePerMonth?: number
}

const UNIT_NAME_MAX = 60

const SIGNED_OUT_ON_SAVE =
  "You're signed out. Sign in again and your numbers will save."

function blankToUndefined(value: unknown): unknown {
  if (value === null) return undefined
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalUnitName(label: string) {
  return z.preprocess(
    blankToUndefined,
    z
      .string()
      .max(
        UNIT_NAME_MAX,
        `${label} is too long. Keep it under ${UNIT_NAME_MAX} characters.`
      )
      .optional()
  )
}

function optionalMoney(label: string) {
  return z.preprocess(
    (value) => (value === null || value === '' ? undefined : value),
    z
      .number({ invalid_type_error: `${label} has to be a number.` })
      .finite(`${label} has to be a number.`)
      .min(0, `${label} can't be negative.`)
      .optional()
  )
}

const roiAssumptionsSchema = z.object({
  method: z.preprocess(
    blankToUndefined,
    z.enum(['perItem', 'peopleTime', 'periodTotal']).optional()
  ),
  unitSingular: optionalUnitName('The singular name'),
  unitPlural: optionalUnitName('The name'),
  costPerItem: optionalMoney('The cost of one'),
  hoursPerMonth: optionalMoney('The hours a month'),
  hourlyRate: optionalMoney('The cost an hour'),
  costPerMonth: optionalMoney('The monthly cost'),
  revenuePerMonth: optionalMoney('The monthly revenue'),
})

/**
 * A stored row with `beforeAiCostPerUnit` and no `costPerItem` is the
 * per-unit shape: its rate becomes costPerItem with the perItem method. Its
 * per-unit revenue rate has no equivalent (revenue is monthly) and the schema
 * strips it, so this only does the rename.
 */
function mapStoredV2Keys(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  if (record.costPerItem !== undefined) return raw
  if (record.beforeAiCostPerUnit === undefined) return raw
  return {
    ...record,
    costPerItem: record.beforeAiCostPerUnit,
    method: record.method ?? 'perItem',
  }
}

function definedFieldsOnly(
  assumptions: OrgRoiAssumptions
): OrgRoiAssumptions {
  return Object.fromEntries(
    Object.entries(assumptions).filter(([, value]) => value !== undefined)
  ) as OrgRoiAssumptions
}

export async function getOrgRoiAssumptions(): Promise<
  ActionResult<{ assumptions: OrgRoiAssumptions | null }>
> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId
    const org = await db.organizations.findUnique({
      where: { id: orgId },
      select: { roiAssumptions: true },
    })
    if (!org) {
      return { success: false, error: 'Organization not found' }
    }

    // Re-validated on the way out: anything malformed is treated as "nothing
    // stored", so the report shows its empty copy instead of building a
    // comparison out of a number nobody can account for.
    const parsed = roiAssumptionsSchema.safeParse(
      mapStoredV2Keys(org.roiAssumptions ?? {})
    )
    const assumptions = parsed.success ? definedFieldsOnly(parsed.data) : {}

    return {
      success: true,
      data: {
        assumptions:
          Object.keys(assumptions).length > 0 ? assumptions : null,
      },
    }
  } catch (error) {
    console.error('[getOrgRoiAssumptions] Error:', error)
    return {
      success: false,
      error: "Couldn't load your numbers. Refresh to try again.",
    }
  }
}

export async function saveOrgRoiAssumptions(
  input: OrgRoiAssumptions
): Promise<ActionResult<{ assumptions: OrgRoiAssumptions | null }>> {
  try {
    const gate = await assertMoneyManager()
    if (!gate.ok) {
      // The panel renders this error verbatim under the form, and the gate's
      // no-session refusal is the bare string 'Not authenticated'.
      return {
        success: false,
        error:
          gate.error === 'Not authenticated' ? SIGNED_OUT_ON_SAVE : gate.error,
      }
    }

    const parsed = roiAssumptionsSchema.safeParse(input ?? {})
    if (!parsed.success) {
      return {
        success: false,
        error:
          parsed.error.issues[0]?.message ?? "Couldn't read those numbers.",
      }
    }

    const assumptions = definedFieldsOnly(parsed.data)
    const stored = Object.keys(assumptions).length > 0 ? assumptions : null

    await db.organizations.update({
      where: { id: gate.orgId },
      data: {
        roiAssumptions:
          stored === null
            ? Prisma.DbNull
            : (stored as Prisma.InputJsonValue),
      },
    })

    return { success: true, data: { assumptions: stored } }
  } catch (error) {
    console.error('[saveOrgRoiAssumptions] Error:', error)
    return {
      success: false,
      error: "Couldn't save your numbers. Try again.",
    }
  }
}
