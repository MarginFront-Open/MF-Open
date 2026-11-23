import { useState } from 'react'
import { format } from 'date-fns'
import { useCalculateInvoice } from '@/services/invoice-calculator-service'
import { useSubscriptions } from '@/services/subscriptions-service'
import { Loader2, Calculator } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DatePicker } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function InvoicePreviewCalculator() {
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState('')
  const [startDate, setStartDate] = useState<Date | undefined>()
  const [endDate, setEndDate] = useState<Date | undefined>()

  const { data: subscriptions, isLoading: isLoadingSubscriptions } =
    useSubscriptions({})
  const calculateMutation = useCalculateInvoice()

  const handleCalculate = () => {
    if (!selectedSubscriptionId) return

    calculateMutation.mutate({
      subscriptionId: selectedSubscriptionId,
      startDate: startDate ? format(startDate, 'yyyy-MM-dd') : undefined,
      endDate: endDate ? format(endDate, 'yyyy-MM-dd') : undefined,
    })
  }

  return (
    <div className='grid gap-4'>
      <Card>
        <CardHeader>
          <CardTitle>Invoice Preview Calculator</CardTitle>
          <CardDescription>
            Calculate invoice preview for a subscription
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

          <div className='grid gap-4 md:grid-cols-2'>
            <div className='space-y-2'>
              <Label>Start Date (Optional)</Label>
              <DatePicker value={startDate} onChange={setStartDate} />
            </div>

            <div className='space-y-2'>
              <Label>End Date (Optional)</Label>
              <DatePicker value={endDate} onChange={setEndDate} />
            </div>
          </div>

          <Button
            onClick={handleCalculate}
            disabled={!selectedSubscriptionId || calculateMutation.isPending}
            className='w-full'
          >
            {calculateMutation.isPending ? (
              <>
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                Calculating...
              </>
            ) : (
              <>
                <Calculator className='mr-2 h-4 w-4' />
                Calculate Invoice
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {calculateMutation.data && (
        <Card>
          <CardHeader>
            <CardTitle>Calculation Result</CardTitle>
            <CardDescription>Invoice preview details</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className='max-h-96 overflow-auto rounded-md bg-muted p-4'>
              {JSON.stringify(calculateMutation.data, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
