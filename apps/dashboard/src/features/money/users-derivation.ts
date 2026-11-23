/**
 * Pure derivation behind the Money → Users
 * tab. Delegates the internal/external split to internal-partition.ts
 * instead of re-deriving it; uses a structural type rather than
 * importing CustomerBasic to stay framework-free and node-testable.
 */

import {
  buildInternalCustomerMeta,
  partitionCustomerRowsByInternal,
} from './internal-partition'

export interface UsersTabCustomer {
  id: string
  name: string
  email: string
  externalId: string
  status: string
  isInternal: boolean
  defaultGlCodeId: string | null
}

export type UsersTabFilter = 'all' | 'external' | 'internal'

export interface UsersTabCounts {
  all: number
  external: number
  internal: number
}

export interface PartitionedUsersTabCustomers {
  internal: UsersTabCustomer[]
  external: UsersTabCustomer[]
}

/** Splits a flat customer list into the Internal bucket and the External
 * (real-customer) bucket, reusing the shared partition primitive. Every
 * input customer lands in exactly one bucket — none dropped. */
export function partitionUsersTabCustomers(
  customers: ReadonlyArray<UsersTabCustomer>
): PartitionedUsersTabCustomers {
  const meta = buildInternalCustomerMeta(customers)
  const keyedRows = customers.map((customer) => ({
    ...customer,
    key: customer.id,
  }))
  const { internal, external } = partitionCustomerRowsByInternal(
    keyedRows,
    meta
  )
  return { internal, external }
}

/** Counts for the segmented filter's labels ("All (12)", "Customers (10)",
 * "Internal (2)") — derived from the same partition so the three numbers
 * can never disagree with what the filtered list below actually shows. */
export function countUsersTabCustomers(
  customers: ReadonlyArray<UsersTabCustomer>
): UsersTabCounts {
  const { internal, external } = partitionUsersTabCustomers(customers)
  return {
    all: customers.length,
    external: external.length,
    internal: internal.length,
  }
}

/** The rows the Users tab table actually renders for a given filter
 * selection. 'all' preserves the original (name-ascending, per getFilters)
 * order rather than re-sorting internal-then-external or vice versa. */
export function filterUsersTabCustomers(
  customers: ReadonlyArray<UsersTabCustomer>,
  filter: UsersTabFilter
): UsersTabCustomer[] {
  if (filter === 'all') return [...customers]
  const { internal, external } = partitionUsersTabCustomers(customers)
  return filter === 'internal' ? internal : external
}
