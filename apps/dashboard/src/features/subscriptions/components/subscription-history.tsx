'use client'

/**
 * The reader of subscription_change_logs on the subscription detail page.
 * updateSubscription and cancelSubscription (app/actions/subscriptions.ts)
 * write to this table. Read-only: fetches through getSubscriptionChangeLogs,
 * no write path.
 */

import { useEffect, useState } from 'react'
import {
  getSubscriptionChangeLogs,
  type SubscriptionChangeLogEntry,
} from '@/app/actions/subscriptions'
import { formatDisplayDate } from '@/lib/canon-date'
import {
  deriveChangeLogFieldDiffs,
  formatChangeLogValue,
} from '../lib/change-log-diff'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function SubscriptionHistorySection({
  subscriptionId,
}: {
  subscriptionId: string
}) {
  const [logs, setLogs] = useState<SubscriptionChangeLogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!subscriptionId) return
    let cancelled = false
    getSubscriptionChangeLogs(subscriptionId).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setLogs(result.data)
      } else {
        setError(result.error ?? 'Failed to load history')
      }
    })
    return () => {
      cancelled = true
    }
  }, [subscriptionId])

  return (
    <Card className='mb-6 shadow-sm transition-all duration-200 hover:shadow-md'>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className='text-sm text-destructive'>{error}</p>
        ) : logs === null ? (
          <p className='text-sm text-muted-foreground'>Loading history…</p>
        ) : logs.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            No changes recorded yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const diffs = deriveChangeLogFieldDiffs(
                  log.previousValues,
                  log.newValues
                )
                return (
                  <TableRow key={log.id}>
                    <TableCell className='whitespace-nowrap text-sm'>
                      {formatDisplayDate(log.createdAt)}
                    </TableCell>
                    <TableCell className='text-sm'>
                      {diffs.length > 0 ? (
                        <div className='space-y-0.5'>
                          {diffs.map((diff) => (
                            <div key={diff.field}>
                              <span className='font-medium'>{diff.field}</span>:{' '}
                              {formatChangeLogValue(diff.oldValue)} →{' '}
                              {formatChangeLogValue(diff.newValue)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className='text-muted-foreground'>
                          {log.changeType}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {log.changeReason || '—'}
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {log.actor?.name ?? '—'}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
