/**
 * The internal/external partition primitive.
 *
 * Pure, framework-free, node-testable: NO fetching, NO money math. It only
 * re-buckets rows the resolver already returned (canon getCostBreakdown), so
 * it can never disturb the cost invariant — every input row lands in exactly
 * one bucket, none is dropped or folded into "Other". The Money → Users tab
 * uses this to render the first-class "Internal" bucket separately
 * from real customers.
 */

/** The two model-level facts on a customer (get-filters.ts). */
export interface InternalCustomerMeta {
  isInternal: boolean
  /** The internal user's ONE default expense GL account, or null
   * when unset. Carried through the partition so the Users tab can show it
   * without a second lookup; FALLBACK semantics are realized at the
   * journal read path, not here. */
  defaultGlCodeId: string | null
}

export interface PartitionedRows<Row> {
  /** Rows whose customer key is flagged isInternal. */
  internal: Row[]
  /** Everything else — real customers AND the null-key "no customer" row. */
  external: Row[]
}

/**
 * Index customers by id → their internal/GL facts, for the partition below.
 * Structural input (not the get-filters type) so this derivation never imports
 * a 'use server' action file (such a file may export only async functions).
 */
export function buildInternalCustomerMeta(
  customers: ReadonlyArray<{
    id: string
    isInternal: boolean
    defaultGlCodeId: string | null
  }>
): Map<string, InternalCustomerMeta> {
  const metaByCustomerId = new Map<string, InternalCustomerMeta>()
  for (const customer of customers) {
    metaByCustomerId.set(customer.id, {
      isInternal: customer.isInternal,
      defaultGlCodeId: customer.defaultGlCodeId,
    })
  }
  return metaByCustomerId
}

/**
 * Split customer-dimension breakdown rows into the Internal bucket and the
 * External (real-customer) bucket by each row's customer-id key. A null key
 * (events with no customer attached) is external by construction — "no
 * customer" is not an internal user. The two buckets partition the input
 * exactly: internal.length + external.length === rows.length, so
 * Σ(internal.cost) + Σ(external.cost) === Σ(rows.cost) — the Internal bucket
 * is never folded into "Other".
 */
export function partitionCustomerRowsByInternal<
  Row extends { key: string | null },
>(
  rows: readonly Row[],
  metaByCustomerId: ReadonlyMap<string, InternalCustomerMeta>
): PartitionedRows<Row> {
  const internal: Row[] = []
  const external: Row[] = []
  for (const row of rows) {
    const meta = row.key === null ? undefined : metaByCustomerId.get(row.key)
    if (meta?.isInternal) internal.push(row)
    else external.push(row)
  }
  return { internal, external }
}

/**
 * Total the cost of customer-breakdown rows on each side of the
 * internal/external partition. Pure — sums numbers the caller already got from
 * canon getCostBreakdown; internal + external === Σ rows[].cost (null-key row
 * is external by construction, nothing folded into "Other").
 *
 * CALLER GOTCHA: pass a COMPLETE bucket set only. A truncated page (past
 * ANALYTICS_MAX_ROWS) silently understates one side — roi-overview.ts guards
 * that and passes null instead.
 */
export function sumCostByInternalPartition(
  rows: ReadonlyArray<{ key: string | null; cost: number }>,
  metaByCustomerId: ReadonlyMap<string, InternalCustomerMeta>
): { internal: number; external: number } {
  const { internal, external } = partitionCustomerRowsByInternal(
    rows,
    metaByCustomerId
  )
  const sumCost = (partition: ReadonlyArray<{ cost: number }>): number =>
    partition.reduce((total, row) => total + row.cost, 0)
  return { internal: sumCost(internal), external: sumCost(external) }
}
