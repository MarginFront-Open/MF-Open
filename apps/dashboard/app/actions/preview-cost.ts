'use server'

/**
 * Preview cost — server action wrapper around canonical calculateEventCost.
 *
 * Why this exists as a server action:
 *   `calculateEventCost` lives in `@marginfront/db` and uses `Prisma.Decimal`,
 *   which transitively imports `@prisma/client/runtime/library` →
 *   `node:fs`. That chain can't run in the client bundle. Wrapping the
 *   call in a 'use server' action keeps Prisma on the server and lets
 *   the MetricsWizard (a client component) stay interactive.
 *
 * Matches the pattern established by `full-command-center.ts`:
 *   'use server' + Better-Auth session check + @marginfront/db canon import.
 *
 * The canonical simulator defaults (1000 input + 500 output tokens for
 * LLM, quantity=1 for everything else) are locked here so the Metrics
 * preview, the SDK simulator, and every other "show users what one event
 * costs" surface produce the same number for the same service.
 */

import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
import { calculateEventCost } from '@marginfront/db'

const PREVIEW_INPUT_TOKENS_LLM = 1000
const PREVIEW_OUTPUT_TOKENS_LLM = 500
const PREVIEW_QUANTITY = 1

export interface PreviewService {
  inputCost: number | null
  outputCost: number | null
  costUnit: string
}

export interface PreviewMetric {
  id: string
  services: PreviewService[]
}

/**
 * Given a set of metrics (each with a list of services), return the
 * per-event preview cost for each metric keyed by id.
 *
 * The cost for a metric is the sum of the per-event costs across its
 * services — matches how a real usage event fires one record per service.
 */
export async function previewMetricCosts(
  metrics: PreviewMetric[]
): Promise<Record<string, number>> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    throw new Error('No active organization')
  }

  const result: Record<string, number> = {}

  for (const metric of metrics) {
    const total = metric.services.reduce((sum, service) => {
      const isLlm = service.costUnit === '1M tokens'
      const cost = calculateEventCost(
        isLlm ? PREVIEW_INPUT_TOKENS_LLM : 0,
        isLlm ? PREVIEW_OUTPUT_TOKENS_LLM : 0,
        PREVIEW_QUANTITY,
        {
          inputCost: service.inputCost ?? 0,
          outputCost: service.outputCost ?? 0,
          costUnit: service.costUnit,
        }
      )
      return sum + Number(cost.totalCostUsd)
    }, 0)
    result[metric.id] = total
  }

  return result
}
