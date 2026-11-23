import { useState } from 'react'
import { format } from 'date-fns'
import { useBillingStatus } from '@/services/invoice-calculator-service'
import { useSubscriptions } from '@/services/subscriptions-service'
import { Calendar, DollarSign, FileText } from 'lucide-react'
import { formatCurrency } from '@/lib/canon-format'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function BillingStatusViewer() {
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState('')

  const { data: subscriptions, isLoading: isLoadingSubscriptions } =
    useSubscriptions({})
  const { data: billingStatus, isLoading: isLoadingStatus } = useBillingStatus(
    selectedSubscriptionId
  )

  return (
    <div className='grid gap-4'>
      <Card>
        <CardHeader>
          <CardTitle>Billing Status Viewer</CardTitle>
          <CardDescription>
            View billing status and upcoming invoices for subscriptions
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='space-y-2'>
            <Label>Subscription</Label>
            <Select
              value={selectedSubscriptionId}
              onValueChange={setSelectedSubscriptionId}
            >
              <SelectTrigger>
                <SelectValue placeholder='Select a subscription' />
              </SelectTrigger>
              <SelectContent>
                {isLoadingSubscriptions ? (
                  <SelectItem value='loading' disabled>
                    Loading subscriptions...
                  </SelectItem>
                ) : (
                  subscriptions?.results?.map((sub: any) => (
                    <SelectItem key={sub.id} value={sub.id}>
                      {sub.customer?.name || sub.id} - {sub.status}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoadingStatus && selectedSubscriptionId && (
        <Card>
          <CardHeader>
            <Skeleton className='h-6 w-[200px]' />
            <Skeleton className='h-4 w-[300px]' />
          </CardHeader>
          <CardContent>
            <Skeleton className='h-[200px] w-full' />
          </CardContent>
        </Card>
      )}

      {billingStatus && (
        <div className='grid gap-4'>
          <div className='grid gap-4 md:grid-cols-3'>
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Current Period
                </CardTitle>
                <Calendar className='h-4 w-4 text-muted-foreground' />
              </CardHeader>
              <CardContent>
                <div className='text-sm font-bold'>
                  {format(
                    new Date(billingStatus.subscription.currentPeriodStart),
                    'MMM d, yyyy'
                  )}
                  {' - '}
                  {format(
                    new Date(billingStatus.subscription.currentPeriodEnd),
                    'MMM d, yyyy'
                  )}
                </div>
                <p className='text-xs text-muted-foreground'>Billing period</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Next Billing
                </CardTitle>
                <FileText className='h-4 w-4 text-muted-foreground' />
              </CardHeader>
              <CardContent>
                <div className='text-sm font-bold'>
                  {format(
                    new Date(billingStatus.nextBillingDate),
                    'MMM d, yyyy'
                  )}
                </div>
                <p className='text-xs text-muted-foreground'>
                  Next invoice date
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Upcoming Total
                </CardTitle>
                <DollarSign className='h-4 w-4 text-muted-foreground' />
              </CardHeader>
              <CardContent>
                <div className='text-2xl font-bold'>
                  {formatCurrency(billingStatus.upcomingInvoice.total)}
                </div>
                <p className='text-xs text-muted-foreground'>Expected amount</p>
              </CardContent>
            </Card>
          </div>

          {billingStatus.upcomingInvoice.lineItems.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Upcoming Invoice Line Items</CardTitle>
                <CardDescription>Details of the next invoice</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Description</TableHead>
                      <TableHead className='text-right'>Quantity</TableHead>
                      <TableHead className='text-right'>Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {billingStatus.upcomingInvoice.lineItems.map(
                      (item: any, idx: number) => (
                        <TableRow key={idx}>
                          <TableCell>{item.description}</TableCell>
                          <TableCell className='text-right'>
                            {item.quantity}
                          </TableCell>
                          <TableCell className='text-right font-bold'>
                            {formatCurrency(item.amount)}
                          </TableCell>
                        </TableRow>
                      )
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {billingStatus.billingHistory.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Billing History</CardTitle>
                <CardDescription>Past billing transactions</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead className='text-right'>Amount</TableHead>
                      <TableHead className='text-right'>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {billingStatus.billingHistory.map(
                      (item: any, idx: number) => (
                        <TableRow key={idx}>
                          <TableCell>
                            {format(new Date(item.date), 'MMM d, yyyy')}
                          </TableCell>
                          <TableCell className='text-right'>
                            {formatCurrency(item.amount)}
                          </TableCell>
                          <TableCell className='text-right'>
                            <span
                              className={
                                item.status === 'paid'
                                  ? 'text-green-600'
                                  : 'text-yellow-600'
                              }
                            >
                              {item.status}
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
