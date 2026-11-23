// @ts-nocheck
'use client'

import { useState, useEffect } from 'react'
import { z } from 'zod'
import { format } from 'date-fns'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useParams, useRouter } from 'next/navigation'
import { CalendarIcon, Loader2, Users } from 'lucide-react'
import { Agent, PricingPlan } from '@/lib/api'
import { getCustomer as getCustomerAction } from '@/app/actions/customers'
import { getAgents as getAgentsAction } from '@/app/actions/agents'
import { getAgentPricingPlans as getAgentPricingPlansAction } from '@/app/actions/pricing-plans'
import { createSubscription as createSubscriptionAction } from '@/app/actions/subscriptions'
import { cn } from '@/lib/utils'
import { Page } from '@/components/layouts/page'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

const formSchema = z.object({
  name: z.string().min(1, { message: 'Subscription name is required' }),
  planId: z.string().min(1, { message: 'Plan is required' }),
  agentId: z.string().min(1, { message: 'Agent is required' }),
  startDate: z.date({ required_error: 'Start date is required' }),
  endDate: z.date().optional(),
  isForever: z.boolean().default(false),
  billingCycle: z.enum(['monthly', 'yearly', 'custom'], {
    required_error: 'Billing cycle is required',
  }),
  billingAmount: z.number().optional(),
  seatsCount: z
    .number()
    .min(1, { message: 'At least 1 seat is required' })
    .optional(),
})

type FormValues = z.infer<typeof formSchema>

export default function CreateSubscriptionComponent() {
  const params = useParams()
  const router = useRouter()
  const customerId = params.customerId as string
  const [submitting, setSubmitting] = useState(false)
  const [plans, setPlans] = useState<PricingPlan[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loadingPlans, setLoadingPlans] = useState(false)
  const [loadingAgents, setLoadingAgents] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [_selectedPlan, setSelectedPlan] = useState<PricingPlan | null>(null)
  const [isSeatBased, setIsSeatBased] = useState(false)
  const [seatMinimum, setSeatMinimum] = useState<number | null>(null)
  const [customerName, setCustomerName] = useState<string>('Customer')

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      planId: '',
      agentId: '',
      startDate: new Date(),
      isForever: false,
      billingCycle: 'monthly',
      seatsCount: 1,
    },
  })

  const isForever = form.watch('isForever')
  const selectedAgentId = form.watch('agentId')
  const selectedPlanId = form.watch('planId')

  // Fetch customer name for breadcrumb
  useEffect(() => {
    const fetchCustomer = async () => {
      try {
        const result = await getCustomerAction(customerId)
        if (result.success && result.data) {
          setCustomerName(result.data.name)
        }
      } catch (err) {
        console.error('Failed to fetch customer:', err)
      }
    }

    fetchCustomer()
  }, [customerId])

  // Fetch agents on component mount
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        setLoadingAgents(true)
        const result = await getAgentsAction({ isActive: true })
        if (result.success && result.data) {
          setAgents(result.data.results)
        } else {
          setError(result.error || 'Failed to load agents. Please try again.')
        }
      } catch (err) {
        console.error('Failed to fetch agents:', err)
        setError('Failed to load agents. Please try again.')
      } finally {
        setLoadingAgents(false)
      }
    }

    fetchAgents()
  }, [])

  // Fetch pricing plans when an agent is selected
  useEffect(() => {
    if (!selectedAgentId) {
      setPlans([])
      return
    }

    const fetchPricingPlans = async () => {
      try {
        setLoadingPlans(true)
        form.setValue('planId', '') // Reset selected plan when agent changes
        setSelectedPlan(null)
        setIsSeatBased(false)

        const result = await getAgentPricingPlansAction(selectedAgentId, true)
        if (result.success && result.data) {
          setPlans(
            result.data.results.map((plan: any) => ({
              ...plan,
              price: plan.pricingStrategies?.[0]?.rate || 0,
              billingCycle:
                plan.pricingStrategies?.[0]?.billingFrequency || 'monthly',
            }))
          )
        } else {
          setError(
            result.error || 'Failed to load pricing plans. Please try again.'
          )
        }
      } catch (err) {
        console.error('Failed to fetch pricing plans:', err)
        setError('Failed to load pricing plans. Please try again.')
      } finally {
        setLoadingPlans(false)
      }
    }

    fetchPricingPlans()
  }, [selectedAgentId])

  // Update selected plan when plan ID changes
  useEffect(() => {
    if (!selectedPlanId || plans.length === 0) {
      setSelectedPlan(null)
      setIsSeatBased(false)
      return
    }

    const plan = plans.find((p) => p.id === selectedPlanId) || null
    setSelectedPlan(plan)

    // A deactivated seat strategy never bills, so it must not
    // trigger the seats input either.
    const seatStrategies =
      plan?.pricingStrategies?.filter(
        (strategy) =>
          strategy.chargeType === 'seat_based' && strategy.active !== false
      ) ?? []
    const seatStrategy = seatStrategies[0] ?? null

    setIsSeatBased(!!seatStrategy)
    // With several active seat strategies no single minimum is THE minimum,
    // so the hint stays quiet — same contract as the simulate engines'
    // billedSeatsCount emit.
    setSeatMinimum(
      seatStrategies.length === 1
        ? (seatStrategy?.minimumCommitment ?? null)
        : null
    )

    // Set default seatsCount value if seat-based
    if (seatStrategy) {
      form.setValue('seatsCount', 1)
    }
  }, [selectedPlanId, plans])

  const onSubmit = async (data: FormValues) => {
    try {
      setSubmitting(true)
      const subscriptionData = {
        customerId,
        name: data.name,
        planId: data.planId,
        agentId: data.agentId,
        startDate: data.startDate.toISOString(),
        endDate: data.isForever ? undefined : data.endDate?.toISOString(),
        isForever: data.isForever,
        billingCycle: data.billingCycle,
        billingAmount: data.billingAmount,
        seatsCount: isSeatBased ? data.seatsCount : undefined,
      }

      const result = await createSubscriptionAction(subscriptionData)

      if (!result.success) {
        setError(
          result.error || 'Failed to create subscription. Please try again.'
        )
        return
      }

      router.push('/customers/')
    } catch (error) {
      console.error('Failed to create subscription:', error)
      setError('Failed to create subscription. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = () => {
    // Navigate back to the customer detail page
    router.push(`/customers/${customerId}`)
  }

  return (
    <Page
      title='Create New Subscription'
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          { name: customerName, href: `/customers/${customerId}` },
          { name: 'New Subscription' },
        ],
      }}
    >
      <div className='new-subscription-form space-y-6'>
        {error && (
          <div className='mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive'>
            <p className='text-sm font-medium'>{error}</p>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Subscription Details</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className='space-y-6'
              >
                <div className='grid gap-6 md:grid-cols-2'>
                  {/* Subscription Name */}
                  <FormField
                    control={form.control}
                    name='name'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Subscription Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder='Enter subscription name'
                            {...field}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  {/* Billing Cycle */}
                  <FormField
                    control={form.control}
                    name='billingCycle'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Billing Cycle</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder='Select billing cycle' />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value='monthly'>Monthly</SelectItem>
                            <SelectItem value='yearly'>Yearly</SelectItem>
                            <SelectItem value='custom'>Custom</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className='grid gap-6 md:grid-cols-2'>
                  {/* Start Date */}
                  <FormField
                    control={form.control}
                    name='startDate'
                    render={({ field }) => (
                      <FormItem className='flex flex-col'>
                        <FormLabel>Start Date</FormLabel>
                        <Popover>
                          <PopoverTrigger asChild>
                            <FormControl>
                              <Button
                                variant={'outline'}
                                className={cn(
                                  'w-full pl-3 text-left font-normal',
                                  !field.value && 'text-muted-foreground'
                                )}
                              >
                                {field.value ? (
                                  format(field.value, 'PPP')
                                ) : (
                                  <span>Pick a date</span>
                                )}
                                <CalendarIcon className='ml-auto h-4 w-4 opacity-50' />
                              </Button>
                            </FormControl>
                          </PopoverTrigger>
                          <PopoverContent className='w-auto p-0' align='start'>
                            <Calendar
                              mode='single'
                              selected={field.value}
                              onSelect={field.onChange}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Forever Switch */}
                  <FormField
                    control={form.control}
                    name='isForever'
                    render={({ field }) => (
                      <FormItem className='flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm'>
                        <div className='space-y-0.5'>
                          <FormLabel>Forever Subscription</FormLabel>
                          <FormDescription>
                            No end date for this subscription
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>

                {/* End Date (only if not forever) */}
                {!isForever && (
                  <div className='grid gap-6 md:grid-cols-2'>
                    <FormField
                      control={form.control}
                      name='endDate'
                      render={({ field }) => (
                        <FormItem className='flex flex-col'>
                          <FormLabel>End Date</FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button
                                  variant={'outline'}
                                  className={cn(
                                    'w-full pl-3 text-left font-normal',
                                    !field.value && 'text-muted-foreground'
                                  )}
                                >
                                  {field.value ? (
                                    format(field.value, 'PPP')
                                  ) : (
                                    <span>Pick a date</span>
                                  )}
                                  <CalendarIcon className='ml-auto h-4 w-4 opacity-50' />
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent
                              className='w-auto p-0'
                              align='start'
                            >
                              <Calendar
                                mode='single'
                                selected={field.value}
                                onSelect={field.onChange}
                                disabled={(date) =>
                                  date < form.getValues('startDate') ||
                                  date < new Date()
                                }
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <div className='grid gap-6 md:grid-cols-2'>
                  {/* Agent Selection */}
                  <FormField
                    control={form.control}
                    name='agentId'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Agent</FormLabel>
                        {loadingAgents ? (
                          <div className='flex items-center space-x-2'>
                            <Loader2 className='h-4 w-4 animate-spin' />
                            <span>Loading agents...</span>
                          </div>
                        ) : (
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder='Select an agent' />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {agents.map((agent) => (
                                <SelectItem key={agent.id} value={agent.id}>
                                  {agent.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </FormItem>
                    )}
                  />

                  {/* Plan Selection */}
                  <FormField
                    control={form.control}
                    name='planId'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Pricing Plan</FormLabel>
                        {!selectedAgentId ? (
                          <FormDescription>
                            Select an agent first to view available plans
                          </FormDescription>
                        ) : loadingPlans ? (
                          <div className='flex items-center space-x-2'>
                            <Loader2 className='h-4 w-4 animate-spin' />
                            <span>Loading plans...</span>
                          </div>
                        ) : plans.length === 0 ? (
                          <FormDescription>
                            No pricing plans available for the selected agent
                          </FormDescription>
                        ) : (
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder='Select a plan' />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {plans.map((plan) => (
                                <SelectItem key={plan.id} value={plan.id}>
                                  {plan.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </FormItem>
                    )}
                  />
                </div>

                {/* Seat Quantity (only if plan is seat-based) */}
                {isSeatBased && (
                  <div className='grid gap-6 md:grid-cols-2'>
                    <FormField
                      control={form.control}
                      name='seatsCount'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Number of Seats</FormLabel>
                          <div className='flex items-center space-x-2'>
                            <Users className='h-4 w-4 text-muted-foreground' />
                            <FormControl>
                              <Input
                                type='number'
                                min={1}
                                placeholder='Enter number of seats'
                                {...field}
                                onChange={(e) =>
                                  field.onChange(parseInt(e.target.value) || 1)
                                }
                              />
                            </FormControl>
                          </div>
                          <FormDescription>
                            How many seats this subscription includes.
                            {seatMinimum && seatMinimum > 0
                              ? ` This plan bills a minimum of ${seatMinimum} seats.`
                              : ''}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}

                <div className='flex justify-end space-x-2'>
                  <Button
                    type='button'
                    variant='outline'
                    onClick={handleCancel}
                    disabled={submitting}
                  >
                    Cancel
                  </Button>
                  <Button type='submit' disabled={submitting}>
                    {submitting && (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    )}
                    Create Subscription
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
