import type { SignalEventService } from '@/app/actions/signal-events'

// Source shape (usageCostData, written at ingest): keys are "<model>/input",
// "<model>/output", and — only when the event carried prompt-cache tokens —
// "<model>/cache_read" and "<model>/cache_write", each { cost, units,
// costPerUnit }.
export interface CostBreakdownRow {
  key: string
  cost: number
  units: number | null
}

const DIRECTION_SUFFIXES = [
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const

// sdk.service.ts writes input/output keys for every service, LLM or not, so
// request-priced services get a row with no `units`. Stripping the direction
// suffix recovers the model, which is how those rows find their `quantity`.
function modelFromCostBreakdownKey(key: string): string {
  for (const suffix of DIRECTION_SUFFIXES) {
    if (key.endsWith(`/${suffix}`)) {
      return key.slice(0, key.length - suffix.length - 1)
    }
  }
  return key
}

/**
 * A numeric `cost` is the only requirement to render, so historical
 * quantity-priced rows — which have no `units` field at all — are never
 * dropped. Units resolve in order: the row's own `units`, the matching
 * service's `quantity`, then null (the caller renders '—').
 */
export function buildCostBreakdownRows(
  usageCostData: Record<string, unknown> | null | undefined,
  services: Pick<SignalEventService, 'model' | 'quantity'>[]
): CostBreakdownRow[] {
  if (!usageCostData) return []

  return Object.entries(usageCostData).flatMap(([key, value]) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('cost' in value) ||
      typeof (value as { cost: unknown }).cost !== 'number'
    ) {
      return []
    }

    const cost = (value as { cost: number }).cost
    const rawUnits = (value as { units?: unknown }).units
    let units: number | null = typeof rawUnits === 'number' ? rawUnits : null

    if (units === null) {
      const model = modelFromCostBreakdownKey(key)
      const matchingService = services.find((s) => s.model === model)
      if (matchingService && typeof matchingService.quantity === 'number') {
        units = matchingService.quantity
      }
    }

    return [{ key, cost, units }]
  })
}
