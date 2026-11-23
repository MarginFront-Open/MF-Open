/**
 * WHAT THIS FILE DOES: Locks reproducible pricing on the dashboard
 *   backfill — `mapModelAndBackfill` must re-read each event's stored
 *   `metadata.cacheWriteTtl` and get it to the pricing call. Without this, a
 *   5m-priced event silently re-prices back at the 2× ceiling the first time
 *   an admin remaps its model.
 *
 *   The action calls `resolveEventPrice`, which applies the TTL re-base
 *   internally and additionally REFUSES to price a cache-bearing event
 *   against a row with no cache rate. So the assertions below check that the
 *   action reaches the canonical resolver with the hint and provider.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST: same reason as its sibling
 *   (signal-events-cache-backfill.test.ts) — mapModelAndBackfill runs Prisma +
 *   auth inside a $transaction; the rate math itself is locked in
 *   packages/db/scripts/__tests__/apply-cache-write-ttl.test.ts (including a
 *   divergence proof that fails without the re-base).
 *
 * NOT COVERED HERE: `fillMissingVolume` also reaches resolveEventPrice with
 *   the child's cache tokens and TTL hint; its cache pricing is covered by
 *   fill-missing-volume-cache-cost.test.ts.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const actionSource = readFileSync(
  join(__dirname, '../signal-events.ts'),
  'utf8'
)
const dbShimSource = readFileSync(join(__dirname, '../../lib/db.ts'), 'utf8')

describe('model-mapping backfill re-derives the cache-write TTL rate', () => {
  it('selects the parent metadata (the stored TTL hint) with the child rows', () => {
    expect(actionSource).toContain(
      'signal_events: { select: { metadata: true } }'
    )
  })

  it('reads the stored hint off the parent event, per child', () => {
    expect(actionSource).toContain('child.signal_events?.metadata')
    expect(actionSource).toContain('.cacheWriteTtl')
  })

  it('hands the stored hint and the event provider to the canonical resolver', () => {
    // applyCacheWriteTtl runs INSIDE resolveEventPrice, so the backfill
    // doesn't invoke the helper by name. The requirement asserted here: the
    // hint and the provider must both reach the pricing call, or a 5m event re-prices at the
    // 2x ceiling. The re-basing itself is locked in
    // packages/db/scripts/__tests__/apply-cache-write-ttl.test.ts and
    // resolve-event-price.test.ts.
    expect(actionSource).toContain('resolveEventPrice({')
    expect(actionSource).toContain('cacheWriteTtl,')
    // Provider comes from the child (falling back to the normalized input) so
    // the resolver's Anthropic guard sees the event's real provider.
    expect(actionSource).toContain('child.modelProvider ?? normalizedProvider')
  })

  it('imports the resolver through the same db shim the action already uses', () => {
    expect(actionSource).toMatch(/resolveEventPrice,?\n/)
    expect(dbShimSource).toContain('resolveEventPrice,')
    expect(dbShimSource).toContain("} from '@marginfront/db'")
  })

  it('does not price cache through the unguarded multiplier on this path', () => {
    // A repair door must not be able to hand cache tokens to the pure
    // multiplier, where a NULL rate silently becomes $0.
    const backfillBody = actionSource.slice(
      actionSource.indexOf('export async function mapModelAndBackfill'),
      actionSource.indexOf('export async function getServicePricingEntries')
    )
    expect(backfillBody).toContain('resolveEventPrice({')
    expect(backfillBody).not.toContain('calculateEventCost(')
  })
})
