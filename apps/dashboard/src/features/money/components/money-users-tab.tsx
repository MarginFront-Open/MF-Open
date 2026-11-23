'use client'

/**
 * Money → Users tab: one filterable list of
 * real customers and internal seats (isInternal).
 *
 * Reuses getFilters() rather than a second query.
 *
 * A customer row links to the existing /customers/[id] detail page; an
 * internal row opens InternalUserDetailDialog instead. Status edits reuse
 * updateCustomer, which is BUILD-gated (owner/admin) even though this tab
 * lives on the finance-gated Money page — a Finance-role viewer can see
 * status but gets a clean permission error editing it (canon: a customer
 * record is BUILD plumbing, not a Finance write).
 *
 * The Type column is editable the same way — a per-row select
 * flips a record customer ↔ internal through updateCustomer (same BUILD
 * gate). The flag is live, so a flipped row re-partitions immediately:
 * the filter counts, bucket membership, and the name cell's link-vs-dialog
 * routing all key off isInternal. This tab is the one surface that reaches
 * BOTH directions — internal rows never reach /customers/[id].
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { getFilters, type CustomerBasic } from '@/app/actions/get-filters'
import { updateCustomer } from '@/app/actions/customers'
import { getChartOfAccounts } from '@/app/actions/chart-of-accounts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import {
  countUsersTabCustomers,
  filterUsersTabCustomers,
  type UsersTabCustomer,
  type UsersTabFilter,
} from '../users-derivation'
import {
  InternalUserDetailDialog,
  type GlAccountLabel,
} from './internal-user-detail-dialog'

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'suspended', label: 'Suspended' },
]

const TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'customer', label: 'Customer' },
  { value: 'internal', label: 'Internal' },
]

const FILTER_OPTIONS: ReadonlyArray<{ id: UsersTabFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'external', label: 'Customers' },
  { id: 'internal', label: 'Internal' },
]

export function MoneyUsersTab() {
  const [customers, setCustomers] = useState<CustomerBasic[] | null>(null)
  const [loadState, setLoadState] = useState<TileState>('loading')
  const [glAccountsById, setGlAccountsById] = useState<
    Map<string, GlAccountLabel>
  >(new Map())
  const [filter, setFilter] = useState<UsersTabFilter>('all')
  const [detailCustomerId, setDetailCustomerId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getFilters(),
      // GL lookup failing should never block the user list itself from
      // loading; worst case an internal user's detail shows "No GL
      // account assigned" instead of the real one.
      getChartOfAccounts().catch(() => []),
    ]).then(([filtersResult, glCodes]) => {
      if (cancelled) return
      if (filtersResult.success && filtersResult.data) {
        setCustomers(filtersResult.data.customers)
        setLoadState('ready')
      } else {
        setLoadState('error')
      }
      setGlAccountsById(
        new Map(
          glCodes.map((gl) => [gl.id, { glCode: gl.glCode, glName: gl.glName }])
        )
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleStatusChange = useCallback(
    async (customerId: string, status: string) => {
      const result = await updateCustomer(customerId, { status })
      if (result.success) {
        setCustomers((current) =>
          current
            ? current.map((c) => (c.id === customerId ? { ...c, status } : c))
            : current
        )
      } else {
        toast({
          variant: 'destructive',
          title: "Couldn't update status",
          description:
            result.error ?? 'Something went wrong. Please try again.',
        })
      }
    },
    []
  )

  const handleTypeChange = useCallback(
    async (customerId: string, isInternal: boolean) => {
      const result = await updateCustomer(customerId, { isInternal })
      if (result.success) {
        setCustomers((current) =>
          current
            ? current.map((c) =>
                c.id === customerId ? { ...c, isInternal } : c
              )
            : current
        )
      } else {
        toast({
          variant: 'destructive',
          title: "Couldn't update type",
          description:
            result.error ?? 'Something went wrong. Please try again.',
        })
      }
    },
    []
  )

  if (loadState === 'loading' || customers === null) {
    return (
      <TileFrame state='loading' className='min-h-[280px]' loadingLines={6}>
        {null}
      </TileFrame>
    )
  }

  if (loadState === 'error') {
    return (
      <TileFrame
        state='error'
        className='min-h-[280px]'
        errorMessage="Couldn't load users. Refresh the page to try again."
      >
        {null}
      </TileFrame>
    )
  }

  const counts = countUsersTabCustomers(customers)
  const rows: UsersTabCustomer[] = filterUsersTabCustomers(customers, filter)
  const detailCustomer =
    detailCustomerId !== null
      ? (customers.find((c) => c.id === detailCustomerId) ?? null)
      : null

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center justify-end'>
        <Link
          href='/customers'
          className='text-[11.5px] font-medium text-mf-tx3 hover:text-mf-accent'
        >
          Manage all customers →
        </Link>
      </div>
      <div
        role='group'
        aria-label='Filter users'
        className='flex w-fit gap-0.5 rounded-mf-seg bg-mf-card2 p-0.5'
      >
        {FILTER_OPTIONS.map((option) => (
          <button
            key={option.id}
            type='button'
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
            className={cn(
              'h-6 rounded-mf-seg-item px-2.5 text-[11.5px] font-medium',
              filter === option.id
                ? 'bg-mf-accent2 text-mf-accent'
                : 'text-mf-tx2 hover:text-mf-tx'
            )}
          >
            {option.label} ({counts[option.id]})
          </button>
        ))}
      </div>

      <TileFrame state='ready' className='overflow-hidden'>
        <table className='w-full border-collapse'>
          <thead>
            <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Name
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Email
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Type
              </th>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className='border-t border-mf-bd2'>
                <td className='px-[17px] py-[11px] text-[12.5px] font-medium'>
                  {row.isInternal ? (
                    <button
                      type='button'
                      onClick={() => setDetailCustomerId(row.id)}
                      className='text-left text-mf-tx hover:text-mf-accent'
                    >
                      {row.name}
                    </button>
                  ) : (
                    <Link
                      href={`/customers/${row.id}`}
                      className='text-mf-tx hover:text-mf-accent'
                    >
                      {row.name}
                    </Link>
                  )}
                </td>
                <td className='px-[10px] py-[11px] text-[12px] text-mf-tx2'>
                  {row.email || '—'}
                </td>
                <td className='px-[10px] py-[11px]'>
                  <Select
                    value={row.isInternal ? 'internal' : 'customer'}
                    onValueChange={(value) =>
                      handleTypeChange(row.id, value === 'internal')
                    }
                  >
                    <SelectTrigger
                      aria-label={`Type for ${row.name}`}
                      className='h-7 w-[112px] text-[12px]'
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className='px-[17px] py-[11px]'>
                  <Select
                    value={row.status}
                    onValueChange={(value) => handleStatusChange(row.id, value)}
                  >
                    <SelectTrigger
                      aria-label={`Status for ${row.name}`}
                      className='h-7 w-[112px] text-[12px]'
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className='px-[17px] py-6 text-center text-[12px] text-mf-tx3'
                >
                  No users in this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TileFrame>

      {detailCustomer && (
        <InternalUserDetailDialog
          customer={detailCustomer}
          glAccount={
            detailCustomer.defaultGlCodeId
              ? (glAccountsById.get(detailCustomer.defaultGlCodeId) ?? null)
              : null
          }
          open={detailCustomerId !== null}
          onOpenChange={(open) => {
            if (!open) setDetailCustomerId(null)
          }}
        />
      )}
    </div>
  )
}
