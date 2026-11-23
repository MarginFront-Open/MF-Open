'use client'

/**
 * The Credit Pools section on Money → Plans: one row per customer
 * on a credit-pool plan, with the countdown and the two resolutions.
 *
 * NOT to be confused with the Internal AI Spend page (/internal-ai-spend):
 * that one is your OWN coding spend. This one is what your
 * CUSTOMERS have left.
 *
 * Numbers come from the shared credit-balance canon through
 * getCreditBalancesAction, the same path GET /v1/credit-balances reads, so a
 * number here and a number from the API cannot drift.
 */

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { TileFrame } from '@/features/dashboard-shell/tiles/tile-frame'
import type { TileState } from '@/features/dashboard-shell/tiles/tile-frame'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import { getCreditBalancesAction } from '@/app/actions/credit-pools'
import {
  type CreditPoolBalanceView,
  type CreditPoolPermission,
} from '../credit-pool-types'
import { CreditPoolResolveDialog } from './credit-pool-resolve-dialog'

function units(value: number): string {
  return Math.round(value).toLocaleString()
}

function periodLabel(pool: CreditPoolBalanceView): string {
  if (pool.periodStartMs === null || pool.periodEndMs === null) {
    return 'No billing period yet'
  }
  const format = (ms: number) =>
    new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${format(pool.periodStartMs)} to ${format(pool.periodEndMs)}`
}

export function CreditPoolsSection() {
  const [pools, setPools] = useState<CreditPoolBalanceView[]>([])
  const [permission, setPermission] = useState<CreditPoolPermission>({
    canManage: false,
    whoCanChange: '',
  })
  const [loadState, setLoadState] = useState<TileState>('loading')
  // Hold the ID, not the row. `load()` replaces `pools` after every
  // write, so deriving the open pool from the fresh list keeps EVERY number in
  // the dialog current. A held row object would freeze at click time.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected =
    pools.find((pool) => pool.subscriptionId === selectedId) ?? null

  const load = useCallback(async () => {
    const result = await getCreditBalancesAction()
    if (result.success) {
      setPools(result.data.balances)
      setPermission(result.data.permission)
      setLoadState('ready')
    } else {
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    getCreditBalancesAction().then((result) => {
      if (cancelled) return
      if (result.success) {
        setPools(result.data.balances)
        setPermission(result.data.permission)
        setLoadState('ready')
      } else {
        setLoadState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Nothing to say when no plan sells a credit pool — an empty table would
  // read as a broken feature rather than an unused one.
  if (loadState === 'ready' && pools.length === 0) return null

  if (loadState === 'loading') {
    return (
      <TileFrame state='loading' className='min-h-[140px]' loadingLines={3}>
        {null}
      </TileFrame>
    )
  }

  if (loadState === 'error') {
    return (
      <TileFrame
        state='error'
        className='min-h-[140px]'
        errorMessage="Couldn't load credit pools. Refresh the page to try again."
      >
        {null}
      </TileFrame>
    )
  }

  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-1.5 px-1'>
        <h3 className='text-[12.5px] font-semibold text-mf-tx'>Credit pools</h3>
        <InfoTooltip {...tooltipDefinitions.creditPools} />
      </div>

      <TileFrame state='ready' className='overflow-hidden'>
        <table className='w-full border-collapse'>
          <thead>
            <tr className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
              <th className='px-[17px] pb-2 pt-[14px] text-left font-semibold'>
                Customer
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Plan
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-right font-semibold'>
                Pool size
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-right font-semibold'>
                <span className='inline-flex items-center gap-1'>
                  Used
                  <InfoTooltip {...tooltipDefinitions.creditPoolUsed} />
                </span>
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-right font-semibold'>
                <span className='inline-flex items-center gap-1'>
                  Left
                  <InfoTooltip {...tooltipDefinitions.creditPoolRemaining} />
                </span>
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-right font-semibold'>
                <span className='inline-flex items-center gap-1'>
                  Overage
                  <InfoTooltip {...tooltipDefinitions.creditPoolOverage} />
                </span>
              </th>
              <th className='px-[10px] pb-2 pt-[14px] text-left font-semibold'>
                Period
              </th>
              <th className='px-[17px] pb-2 pt-[14px] text-right font-semibold'>
                <span className='inline-flex items-center gap-1'>
                  Actions
                  <InfoTooltip {...tooltipDefinitions.creditPoolActions} />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pools.map((pool) => (
              <tr key={pool.subscriptionId} className='border-t border-mf-bd2'>
                <td className='px-[17px] py-[11px] text-[12.5px] font-medium'>
                  {pool.customerName ?? 'Unnamed customer'}
                  <p className='mt-0.5 text-[11px] font-normal text-mf-tx3'>
                    {pool.subscriptionName}
                  </p>
                </td>
                <td className='px-[10px] py-[11px] text-[12px] text-mf-tx2'>
                  {pool.planName ?? '—'}
                </td>
                <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
                  {units(pool.poolSizeUnits)}
                </td>
                <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
                  {pool.noActivePeriod ? '—' : units(pool.consumedUnits)}
                </td>
                <td
                  className={`px-[10px] py-[11px] text-right text-[12px] font-medium ${
                    !pool.noActivePeriod && pool.remainingUnits <= 0
                      ? 'text-destructive'
                      : 'text-mf-tx'
                  }`}
                >
                  {/* A pool with no billing period has not started counting
                      down. Rendering its numbers would read as a drained pool. */}
                  {pool.noActivePeriod ? '—' : units(pool.remainingUnits)}
                </td>
                <td className='px-[10px] py-[11px] text-right text-[12px] text-mf-tx2'>
                  {!pool.noActivePeriod && pool.overageInProgressUnits > 0
                    ? units(pool.overageInProgressUnits)
                    : '—'}
                </td>
                <td className='px-[10px] py-[11px] text-[11px] text-mf-tx3'>
                  {periodLabel(pool)}
                  {pool.alertsPaused && (
                    <span className='ml-1.5 inline-flex align-middle'>
                      <Badge variant='outline'>Alerts paused</Badge>
                    </span>
                  )}
                </td>
                <td className='px-[17px] py-[11px] text-right'>
                  <Button
                    variant='outline'
                    size='sm'
                    className='h-7 text-[11.5px]'
                    onClick={() => setSelectedId(pool.subscriptionId)}
                  >
                    Top up or pause
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TileFrame>

      <CreditPoolResolveDialog
        pool={selected}
        permission={permission}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
        onResolved={load}
      />
    </div>
  )
}
