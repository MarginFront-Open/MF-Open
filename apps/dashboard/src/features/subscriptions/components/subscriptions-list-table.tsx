'use client'

// @ts-nocheck
/**
 * SubscriptionsListTable: the subscriptions list: search, filter,
 * paginate, create/edit/delete. Both the standalone `/subscriptions` route
 * (src/features/subscriptions/index.tsx, a thin `Page` wrapper around this)
 * and Money's Subscriptions tab embed this SAME table, so the two surfaces
 * never fork. Chrome-free by
 * design — callers decide what wraps it (`Page` for the standalone route,
 * nothing for the Money tab).
 */
import { useState } from 'react'
import { getCanonicalSubscriptionMetrics } from '@/app/actions/analytics'
import { cancelSubscription } from '@/app/actions/subscriptions'
import { formatDisplayDate } from '@/lib/canon-date'
import { formatCurrency } from '@/lib/canon-format'
import { useFilters } from '@/services/filters-service'
import { Agent, CustomerBasic } from '@/services/filters-service'
import {
  useSubscriptions,
  useDeleteSubscription,
} from '@/services/subscriptions-service'
import { PlusIcon, TrashIcon, Eye, Pencil } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { SubscriptionQueryParams } from '@/lib/api/subscriptions'
import { toast } from '@/hooks/use-toast'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DataTable, ColumnDef, FilterDef } from '@/features/datatable'
import { CancelSubscriptionDialog } from './cancel-subscription-dialog'
import { CreateSubscriptionForm } from './create-subscription-form'

// Mirrors SubscriptionStatus in app/actions/subscriptions.ts.
type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'expired'
  | 'pending'
  | 'upcoming'
  | 'trial'
  | 'paused'
  | 'ended'

type SubscriptionBillingCycle = 'monthly' | 'yearly' | 'custom'

interface Subscription {
  id: string
  name: string
  customerId: string
  customer?: CustomerBasic
  planId: string
  plan?: {
    id: string
    name: string
  }
  startDate?: string | null
  endDate?: string | null
  status: SubscriptionStatus
  billingCycle: SubscriptionBillingCycle
  agentId?: string
  agent?: {
    id: string
    name: string
  }
  subscriptionNumber?: string
  isForever?: boolean
  billingModel?: 'subscription' | 'usage' | 'hybrid'
  netTerms?: number
  billingDay?: number
  customCycleDays?: number
  timezone?: string
  organizationId?: string
  createdAt?: string
  updatedAt?: string
  metadata?: Record<string, unknown> | null
  renewalDate?: string
  canceledAt?: string
  billingAmount?: number
}

export function SubscriptionsListTable() {
  const [queryParams, setQueryParams] = useState<SubscriptionQueryParams>({
    limit: 10,
    page: 1,
    sortBy: 'createdAt',
    sortOrder: 'desc',
    search: '',
    includeDetails: true,
  })
  const [deleteTarget, setDeleteTarget] = useState<Subscription | null>(null)
  const [deleteTargetEarned, setDeleteTargetEarned] = useState<{
    id: string
    amount: number
  } | null>(null)
  const [isDeleteAlertOpen, setIsDeleteAlertOpen] = useState(false)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [isCanceling, setIsCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [_deleteReason] = useState('Requested by user')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editSubscription, setEditSubscription] = useState<Subscription | null>(
    null
  )
  const [showEditForm, setShowEditForm] = useState(false)

  const router = useRouter()

  const {
    data: subscriptionsData,
    isLoading,
    refetch,
  } = useSubscriptions(queryParams)
  const { mutate: deleteSubscription, isPending: isDeleting } =
    useDeleteSubscription()
  const { data: filtersData } = useFilters()

  const subscriptions = subscriptionsData?.results || []
  const totalResults = subscriptionsData?.totalResults || 0
  const agents = filtersData?.agents || []
  const customers = filtersData?.customers || []

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return 'N/A'
    return formatDisplayDate(dateString, 'MMM dd, yyyy')
  }

  const handleDelete = async () => {
    if (!deleteTarget) return

    try {
      deleteSubscription(deleteTarget.id, {
        onSuccess: () => {
          toast({
            title: 'Success',
            description: 'Subscription deleted successfully',
          })
          setIsDeleteAlertOpen(false)
          setDeleteTarget(null)
          refetch()
        },
        onError: (error) => {
          console.error('Error deleting subscription:', error)
          toast({
            variant: 'destructive',
            title: 'Error',
            description: 'Failed to delete subscription',
          })
        },
        onSettled: () => {
          setIsDeleteAlertOpen(false)
        },
      })
    } catch (error) {
      console.error('Error deleting subscription:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to delete subscription',
      })
      setIsDeleteAlertOpen(false)
    }
  }

  const confirmDelete = (subscription: Subscription) => {
    setDeleteTarget(subscription)
    setIsDeleteAlertOpen(true)
    // Fire-and-forget: the warning copy stands on its own if this fails or
    // is still in flight; the {id, amount} pair keeps a slow response for
    // one subscription from labeling another's dialog.
    getCanonicalSubscriptionMetrics(subscription.id, {
      startDate: new Date(0).toISOString(),
    })
      .then((result) => {
        if (result.success && result.data) {
          setDeleteTargetEarned({
            id: subscription.id,
            amount: result.data.revenue,
          })
        }
      })
      .catch(() => {})
  }

  const canCancelTarget =
    deleteTarget !== null &&
    !['canceled', 'ended', 'expired'].includes(deleteTarget.status)

  const earnedForTarget =
    deleteTarget !== null && deleteTargetEarned?.id === deleteTarget.id
      ? deleteTargetEarned.amount
      : null

  const openCancelInstead = () => {
    setIsDeleteAlertOpen(false)
    setCancelError(null)
    setShowCancelDialog(true)
  }

  const handleCancelSubscription = async (reason: string) => {
    if (!deleteTarget) return
    setIsCanceling(true)
    setCancelError(null)
    try {
      const result = await cancelSubscription(deleteTarget.id, reason)
      if (!result.success) {
        setCancelError(result.error || 'Failed to cancel subscription')
        return
      }
      toast({
        title: 'Subscription canceled',
        description:
          'Billing stops going forward. Past invoices and revenue stay untouched.',
      })
      setShowCancelDialog(false)
      setDeleteTarget(null)
      refetch()
    } catch (error) {
      console.error('Error canceling subscription:', error)
      setCancelError('Failed to cancel subscription. Please try again.')
    } finally {
      setIsCanceling(false)
    }
  }

  const handleCreateSuccess = () => {
    setShowCreateForm(false)
    refetch()
  }

  const columns: ColumnDef<Subscription>[] = [
    {
      id: 'name',
      header: 'Subscription Name',
      accessorKey: 'name',
      enableSorting: true,
      cell: (subscription) => (
        <Link
          href={`/subscriptions/${subscription.id}`}
          className='font-medium text-primary hover:text-primary/80 hover:underline'
        >
          {subscription.name}
        </Link>
      ),
    },
    {
      id: 'customer',
      header: 'Customer',
      cell: (subscription) => subscription.customer?.name || 'N/A',
    },
    {
      id: 'plan',
      header: 'Plan',
      cell: (subscription) =>
        (subscription as any).pricingPlan?.name ||
        subscription.plan?.name ||
        'N/A',
    },
    {
      id: 'agent',
      header: 'Agent',
      cell: (subscription) => subscription.agent?.name || 'N/A',
    },
    {
      id: 'startDate',
      header: 'Start Date',
      accessorKey: 'startDate',
      enableSorting: true,
      cell: (subscription) => formatDate(subscription.startDate),
    },
    {
      id: 'endDate',
      header: 'End Date',
      accessorKey: 'endDate',
      cell: (subscription) => formatDate(subscription.endDate),
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      enableSorting: true,
      cell: (subscription) => <StatusBadge status={subscription.status} />,
    },
    {
      id: 'billingCycle',
      header: 'Billing Cycle',
      accessorKey: 'billingCycle',
      cell: (subscription) => (
        <span className='capitalize'>{subscription.billingCycle}</span>
      ),
    },
    {
      id: 'actions',
      header: (
        <div className='flex h-full w-full items-center justify-end'>
          Actions
        </div>
      ),
      enableSorting: false,
      cell: (subscription) => (
        <div
          className='flex w-full items-center justify-end gap-2'
          onClick={(e) => e.stopPropagation()}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-foreground'
                  onClick={(e) => {
                    e.stopPropagation()
                    router.push(`/subscriptions/${subscription.id}`)
                  }}
                >
                  <Eye className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>View Details</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-foreground'
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditSubscription(subscription)
                    setShowEditForm(true)
                  }}
                >
                  <Pencil className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-destructive'
                  onClick={(e) => {
                    e.stopPropagation()
                    confirmDelete(subscription)
                  }}
                >
                  <TrashIcon className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ),
    },
  ]

  const filters: FilterDef<Subscription>[] = [
    {
      id: 'agentId',
      label: 'Agent',
      type: 'autocomplete',
      onSearchBar: true,
      options: agents.map((agent: Agent) => ({
        label: agent.name,
        value: agent.id,
      })),
      clearValue: '',
    },
    {
      id: 'customerId',
      label: 'Customer',
      type: 'autocomplete',
      onSearchBar: false,
      options: customers.map((customer: CustomerBasic) => ({
        label: customer.name,
        value: customer.id,
      })),
      clearValue: '',
    },
    {
      id: 'status',
      label: 'Status',
      type: 'select',
      onSearchBar: false,
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Canceled', value: 'canceled' },
        { label: 'Expired', value: 'expired' },
        { label: 'Pending', value: 'pending' },
      ],
      clearValue: '',
    },
    {
      id: 'billingCycle',
      label: 'Billing Cycle',
      type: 'select',
      onSearchBar: false,
      options: [
        { label: 'Monthly', value: 'monthly' },
        { label: 'Yearly', value: 'yearly' },
        { label: 'Custom', value: 'custom' },
      ],
      clearValue: '',
    },
  ]

  return (
    <>
      <DataTable
        data={subscriptions}
        columns={columns}
        filters={filters}
        searchConfig={{
          placeholder: 'Search subscriptions...',
          paramKey: 'search',
          debounceTime: 300,
        }}
        paginationConfig={{
          pageParamKey: 'page',
          limitParamKey: 'limit',
          defaultPageSize: 10,
        }}
        onRowClick={(subscription) =>
          router.push(`/subscriptions/${subscription.id}`)
        }
        isLoading={isLoading}
        onRefresh={refetch}
        totalResults={totalResults}
        queryParams={queryParams}
        setQueryParams={setQueryParams}
        actionButton={
          <Button size='sm' onClick={() => setShowCreateForm(true)}>
            <PlusIcon className='mr-2 size-4' />
            New Subscription
          </Button>
        }
      />

      <AlertDialog open={isDeleteAlertOpen} onOpenChange={setIsDeleteAlertOpen}>
        <AlertDialogContent className='max-w-md'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete this subscription permanently?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`This cannot be undone. Deleting erases this subscription and its recognized revenue${
                earnedForTarget !== null
                  ? ` (about ${formatCurrency(earnedForTarget)})`
                  : ''
              } from every revenue report, past periods included. To stop future billing while keeping history intact, cancel it instead.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className='gap-2 sm:space-x-0'>
            <Button
              variant='outline'
              onClick={() => setIsDeleteAlertOpen(false)}
              disabled={isDeleting}
            >
              Keep subscription
            </Button>
            {canCancelTarget && (
              <Button onClick={openCancelInstead} disabled={isDeleting}>
                Cancel instead
              </Button>
            )}
            <Button
              onClick={handleDelete}
              disabled={isDeleting}
              variant='destructive'
            >
              {isDeleting ? 'Deleting...' : 'Delete permanently'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CancelSubscriptionDialog
        open={showCancelDialog}
        subscriptionName={deleteTarget?.name || 'this subscription'}
        customerName={deleteTarget?.customer?.name || 'This customer'}
        pending={isCanceling}
        error={cancelError}
        onCancel={() => setShowCancelDialog(false)}
        onConfirm={handleCancelSubscription}
      />

      {showCreateForm && (
        <CreateSubscriptionForm
          isOpen={showCreateForm}
          onOpenChange={setShowCreateForm}
          onSuccess={handleCreateSuccess}
        />
      )}

      {showEditForm && (
        <CreateSubscriptionForm
          isOpen={showEditForm}
          onOpenChange={(open) => {
            setShowEditForm(open)
            if (!open) setEditSubscription(null)
          }}
          onSuccess={() => {
            refetch()
            setShowEditForm(false)
            setEditSubscription(null)
          }}
          mode='edit'
          subscription={editSubscription}
        />
      )}
    </>
  )
}
