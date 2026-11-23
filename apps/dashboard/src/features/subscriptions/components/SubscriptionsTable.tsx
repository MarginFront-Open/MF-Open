'use client'

// @ts-nocheck
import { useState, useEffect } from 'react'
import { formatDisplayDate } from '@/lib/canon-date'
import {
  getSubscriptions as getSubscriptionsAction,
  Subscription,
} from '@/app/actions/subscriptions'
import { Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/canon-format'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export interface SubscriptionsTableProps {
  status?: 'pending' | 'active' | 'canceled' | 'expired'
  planId?: string
  agentId?: string
  startDate?: string
  endDate?: string
  billingCycle?: 'monthly' | 'yearly' | 'custom'
  customerId?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  limit?: number
  page?: number
  includeDetails?: boolean
  title?: string
  showCard?: boolean
  className?: string
  onRowClick?: (subscriptionId: string) => void
}

export const SubscriptionsTable = ({
  status,
  planId,
  agentId,
  startDate,
  endDate,
  billingCycle,
  customerId,
  sortBy = 'createdAt',
  sortOrder = 'desc',
  limit = 10,
  page = 1,
  includeDetails = true,
  title = 'Subscriptions',
  showCard = true,
  className = '',
  onRowClick,
}: SubscriptionsTableProps) => {
  const router = useRouter()
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchSubscriptions = async () => {
      try {
        setLoading(true)
        setError(null)

        const result = await getSubscriptionsAction({
          status,
          planId,
          agentId,
          startDate,
          endDate,
          billingCycle,
          customerId,
          sortBy,
          sortOrder,
          limit,
          page,
          includeDetails,
        })

        if (result.success && result.data) {
          setSubscriptions(result.data.results)
          setTotalCount(result.data.total)
        } else {
          setError(
            result.error || 'Failed to load subscriptions. Please try again.'
          )
        }
      } catch (err) {
        console.error('Failed to fetch subscriptions:', err)
        setError('Failed to load subscriptions. Please try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchSubscriptions()
  }, [
    status,
    planId,
    agentId,
    startDate,
    endDate,
    billingCycle,
    customerId,
    sortBy,
    sortOrder,
    limit,
    page,
    includeDetails,
  ])

  const handleRowClick = (subscriptionId: string) => {
    if (onRowClick) {
      onRowClick(subscriptionId)
    } else {
      router.push(`/subscriptions/${subscriptionId}`)
    }
  }

  const getStatusBadgeColors = (status: string) => {
    switch (status.toLowerCase()) {
      case 'active':
        return 'bg-theme-accent-100 text-theme-accent-700 hover:bg-theme-accent-100'
      case 'canceled':
        return 'bg-red-100 text-red-800 hover:bg-red-100'
      case 'expired':
        return 'bg-gray-100 text-gray-800 hover:bg-gray-100'
      case 'pending':
        return 'bg-yellow-100 text-yellow-800 hover:bg-yellow-100'
      default:
        return 'bg-blue-100 text-blue-800 hover:bg-blue-100'
    }
  }

  const tableContent = (
    <>
      {loading ? (
        <div className='flex h-40 items-center justify-center'>
          <Loader2 className='h-6 w-6 animate-spin' />
        </div>
      ) : error ? (
        <div className='p-4 text-red-500'>{error}</div>
      ) : (
        <div className='overflow-x-auto'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Start Date</TableHead>
                <TableHead>Billing Cycle</TableHead>
                <TableHead className='text-right'>Price</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.length > 0 ? (
                subscriptions.map((subscription) => (
                  <TableRow
                    key={subscription.id}
                    className='cursor-pointer hover:bg-muted/50'
                    onClick={() => handleRowClick(subscription.id)}
                  >
                    <TableCell className='font-medium'>
                      {subscription.name}
                    </TableCell>
                    <TableCell>
                      {(subscription as any).customer?.name ||
                        'Unknown Customer'}
                    </TableCell>
                    <TableCell>
                      {formatDisplayDate(subscription.startDate, 'dd MMM yyyy')}
                    </TableCell>
                    <TableCell className='capitalize'>
                      {subscription.billingCycle}
                    </TableCell>
                    <TableCell className='text-right'>
                      {(subscription as any).price
                        ? formatCurrency(
                            parseFloat((subscription as any).price)
                          )
                        : 'Variable'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={getStatusBadgeColors(subscription.status)}
                      >
                        {subscription.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className='py-6 text-center text-muted-foreground'
                  >
                    No subscriptions found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {subscriptions.length > 0 && (
            <div className='mt-2 text-xs text-muted-foreground'>
              Showing {subscriptions.length} of {totalCount} subscriptions
            </div>
          )}
        </div>
      )}
    </>
  )

  if (!showCard) {
    return <div className={className}>{tableContent}</div>
  }

  return (
    <Card className={className}>
      {title && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent>{tableContent}</CardContent>
    </Card>
  )
}
