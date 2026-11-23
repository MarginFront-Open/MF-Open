/**
 * WHAT THIS FILE DOES: Locks that the model-mapping backfill
 *   (`mapModelAndBackfill`) re-prices prompt-cache tokens. Cache tokens are
 *   captured on the child row at ingest; a recompute that selects only
 *   input/output/quantity and calls calculateEventCost with no cache args
 *   would drop a remapped cache-heavy event's cache cost (CANON V3 on the
 *   backfill path).
 *
 * WHY IT IS A SOURCE-ASSERTION TEST: `mapModelAndBackfill` hits Prisma + auth
 *   inside a $transaction and won't run in the node-only jest environment
 *   without heavy mocking, and the sidebar is a React component. Same guardrail
 *   style as the source tests in this directory: assert the behaviour at
 *   the source level. The dollar math itself is proven separately in api-nest's
 *   model-pricing.service.spec.ts (the $0.303383 reconciliation).
 *
 * CONNECTS TO: ../signal-events.ts (mapModelAndBackfill) and
 *   cost-breakdown-rows.ts (the sidebar's per-event cost breakdown
 *   row-building logic, in its own testable module).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const actionSource = readFileSync(
  join(__dirname, '../signal-events.ts'),
  'utf8'
)
const costBreakdownRowsSource = readFileSync(
  join(
    __dirname,
    '../../../src/features/signal-events/lib/cost-breakdown-rows.ts'
  ),
  'utf8'
)

describe('model-mapping backfill re-prices cache tokens', () => {
  it('selects the stored cache token columns from the child rows', () => {
    expect(actionSource).toContain('cacheReadTokens: true')
    expect(actionSource).toContain('cacheWriteTokens: true')
  })

  it('pulls the cache rates from the target pricing row into costEntry', () => {
    expect(actionSource).toContain('target.cacheReadCost')
    expect(actionSource).toContain('target.cacheWriteCost')
  })

  it('passes the stored cache tokens into calculateEventCost', () => {
    expect(actionSource).toContain(
      'const cacheReadTokens = Number(child.cacheReadTokens ?? 0)'
    )
    expect(actionSource).toContain(
      'const cacheWriteTokens = Number(child.cacheWriteTokens ?? 0)'
    )
  })

  it('emits cache_read/cache_write lines in the recomputed usageCostData', () => {
    expect(actionSource).toContain('${modelKey}/cache_read')
    expect(actionSource).toContain('${modelKey}/cache_write')
    expect(actionSource).toContain('costResult.cacheReadCostUsd.toNumber()')
    expect(actionSource).toContain('costResult.cacheWriteCostUsd.toNumber()')
  })
})

describe('cost-breakdown-rows comment documents cache keys', () => {
  it('lists cache_read/cache_write in the Expected shape comment', () => {
    expect(costBreakdownRowsSource).toContain('<model>/cache_read')
    expect(costBreakdownRowsSource).toContain('<model>/cache_write')
  })
})
