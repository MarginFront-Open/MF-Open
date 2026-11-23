'use server'

/**
 * The 'use server' bridge for the Money
 * Simulator. Canon pricing math (calcRouted + the tier engine) lives in
 * @marginfront/db, which pulls Prisma and so cannot bundle into the browser; this
 * action is the only way the client reaches it. It runs the projection on
 * every (debounced) input change — that is the "no Run button", real-time
 * recompute.
 *
 * DRY-RUN, PROVABLY: this action performs ZERO database work. It never
 * imports `db`, never calls a query, never writes an event or invoice. Its
 * whole job is to run caller-supplied numbers through the pure projection
 * engine and hand the result back. It is entirely separate from the SDK
 * Simulator (recordSdkUsage), which fires REAL billed events.
 */

import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { projectPlanRevenue } from './_shared/pricing-projection'
import type {
  PlanProjection,
  ProjectionPlanInput,
  SimActivity,
} from '@/features/money/simulator-derivation'

export interface ProjectPricingInput {
  /** One plan for single mode; two for plan-vs-plan. Both are projected
   * against the SAME activity so a comparison is apples-to-apples. */
  plans: ProjectionPlanInput[]
  activity: SimActivity
  /** Real infra cost of the input volume when a customer's actual volume was
   * pulled; null for manual input. Drives margin, never fabricated. */
  actualCost: number | null
}

export async function projectPricing(
  input: ProjectPricingInput
): Promise<{ success: boolean; data?: PlanProjection[]; error?: string }> {
  // A projection exposes no org data (it is pure math on numbers the caller
  // already holds), but it still sits behind the session like every other
  // action — no anonymous compute endpoint. The Money route itself is
  // finance-gated (requireRouteRoles); this is defense in depth.
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return {
      success: false,
      error: 'Your session expired. Refresh the page and sign in again.',
    }
  }

  const data = input.plans.map((plan) =>
    projectPlanRevenue(plan, input.activity, input.actualCost)
  )
  return { success: true, data }
}
