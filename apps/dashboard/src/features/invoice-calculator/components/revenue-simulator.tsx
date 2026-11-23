import { useState } from 'react'
import { useSimulateRevenue } from '@/services/invoice-calculator-service'
import { usePricingPlans } from '@/services/pricing-plans-service'
import { Loader2, Calculator, DollarSign, TrendingUp } from 'lucide-react'
import { formatCurrency } from '@/lib/canon-format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function RevenueSimulator() {
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>(
    'monthly'
  )
  const [projectedEvents, setProjectedEvents] = useState<
    Record<string, number>
  >({})
  const [seatsCount, setSeatsCount] = useState(1)

  const { data: pricingPlans, isLoading: isLoadingPlans } = usePricingPlans({})
  const simulateMutation = useSimulateRevenue()

  const handleSimulate = () => {
    if (!selectedPlanId) return

    simulateMutation.mutate({
      pricingPlanId: selectedPlanId,
      projectedEvents,
      billingCycle,
      seatsCount,
    })
  }

  return (
    <div className='grid gap-4'>
      <Card>
        <CardHeader>
          <CardTitle>Revenue Simulation Parameters</CardTitle>
          <CardDescription>
            Configure your pricing plan and projected usage to simulate revenue
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='grid gap-4 md:grid-cols-2'>
            <div className='space-y-2'>
              <Label>Pricing Plan</Label>
              <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder='Select a pricing plan' />
                </SelectTrigger>
                <SelectContent>
                  {isLoadingPlans ? (
                    <SelectItem value='loading' disabled>
                      Loading plans...
                    </SelectItem>
                  ) : (
                    pricingPlans?.results?.map((plan: any) => (
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className='space-y-2'>
              <Label>Billing Cycle</Label>
              <Select
                value={billingCycle}
                onValueChange={(value: any) => setBillingCycle(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='monthly'>Monthly</SelectItem>
                  <SelectItem value='yearly'>Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className='space-y-2'>
              <Label>Number of Seats (if applicable)</Label>
              <Input
                type='number'
                min={1}
                value={seatsCount}
                onChange={(e) => setSeatsCount(parseInt(e.target.value) || 1)}
                placeholder='Enter seat count'
              />
            </div>
          </div>

          <div className='space-y-2'>
            <Label>Projected Events (Signal ID: Count)</Label>
            <p className='text-sm text-muted-foreground'>
              Enter projected event counts for usage-based pricing signals
            </p>
            <div className='space-y-2'>
              <div className='flex gap-2'>
                <Input placeholder='Signal ID' id='signal-id-input' />
                <Input
                  type='number'
                  placeholder='Event Count'
                  id='event-count-input'
                />
                <Button
                  type='button'
                  onClick={() => {
                    const signalInput = document.getElementById(
                      'signal-id-input'
                    ) as HTMLInputElement
                    const countInput = document.getElementById(
                      'event-count-input'
                    ) as HTMLInputElement
                    if (signalInput?.value && countInput?.value) {
                      setProjectedEvents((prev) => ({
                        ...prev,
                        [signalInput.value]: parseInt(countInput.value),
                      }))
                      signalInput.value = ''
                      countInput.value = ''
                    }
                  }}
                >
                  Add
                </Button>
              </div>
              {Object.keys(projectedEvents).length > 0 && (
                <div className='space-y-1 rounded-md border p-2'>
                  {Object.entries(projectedEvents).map(([signalId, count]) => (
                    <div
                      key={signalId}
                      className='flex items-center justify-between text-sm'
                    >
                      <span className='font-medium'>{signalId}:</span>
                      <div className='flex items-center gap-2'>
                        <span>{count} events</span>
                        <Button
                          variant='ghost'
                          size='sm'
                          onClick={() => {
                            setProjectedEvents((prev) => {
                              const newEvents = { ...prev }
                              delete newEvents[signalId]
                              return newEvents
                            })
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Button
            onClick={handleSimulate}
            disabled={!selectedPlanId || simulateMutation.isPending}
            className='w-full'
          >
            {simulateMutation.isPending ? (
              <>
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                Simulating...
              </>
            ) : (
              <>
                <Calculator className='mr-2 h-4 w-4' />
                Simulate Revenue
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {simulateMutation.data && (
        <div className='grid gap-4'>
          <div className='grid gap-4 md:grid-cols-4'>
            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Setup Costs
                </CardTitle>
                <DollarSign className='h-4 w-4 text-muted-foreground' />
              </CardHeader>
              <CardContent>
                <div className='text-2xl font-bold'>
                  {formatCurrency(
                    simulateMutation.data.simulationSummary.setupCosts
                  )}
                </div>
                <p className='text-xs text-muted-foreground'>
                  One-time charges
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Recurring Costs
                </CardTitle>
                <DollarSign className='h-4 w-4 text-muted-foreground' />
              </CardHeader>
              <CardContent>
                <div className='text-2xl font-bold'>
                  {formatCurrency(
                    simulateMutation.data.simulationSummary.recurringCosts
                  )}
                </div>
                <p className='text-xs text-muted-foreground'>
                  Per {billingCycle === 'monthly' ? 'month' : 'year'}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Usage Costs
                </CardTitle>
                <DollarSign className='h-4 w-4 text-muted-foreground' />
              </CardHeader>
              <CardContent>
                <div className='text-2xl font-bold'>
                  {formatCurrency(
                    simulateMutation.data.simulationSummary.usageBasedCosts
                  )}
                </div>
                <p className='text-xs text-muted-foreground'>
                  Based on projected usage
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Annual Total
                </CardTitle>
                <TrendingUp className='h-4 w-4 text-muted-foreground' />
              </CardHeader>
              <CardContent>
                <div className='text-2xl font-bold'>
                  {formatCurrency(simulateMutation.data.annualProjection)}
                </div>
                <p className='text-xs text-muted-foreground'>
                  Yearly projection
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Charge Breakdown</CardTitle>
              <CardDescription>
                Detailed breakdown of all charges
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className='text-right'>Quantity</TableHead>
                    <TableHead className='text-right'>Unit Price</TableHead>
                    <TableHead className='text-right'>Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {simulateMutation.data.initialCharges?.lineItems?.map(
                    (item: any, idx: number) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <Badge variant='secondary'>Setup</Badge>
                        </TableCell>
                        <TableCell>{item.description}</TableCell>
                        <TableCell className='text-right'>
                          {item.quantity}
                        </TableCell>
                        <TableCell className='text-right'>
                          {formatCurrency(item.unitPrice)}
                        </TableCell>
                        <TableCell className='text-right font-bold'>
                          {formatCurrency(item.amount)}
                        </TableCell>
                      </TableRow>
                    )
                  )}
                  {simulateMutation.data.recurringCharges?.lineItems?.map(
                    (item: any, idx: number) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <Badge>Recurring</Badge>
                        </TableCell>
                        <TableCell>{item.description}</TableCell>
                        <TableCell className='text-right'>
                          {item.quantity}
                        </TableCell>
                        <TableCell className='text-right'>
                          {formatCurrency(item.unitPrice)}
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
        </div>
      )}
    </div>
  )
}
