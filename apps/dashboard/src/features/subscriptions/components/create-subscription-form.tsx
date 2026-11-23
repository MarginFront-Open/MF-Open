import { useState, useEffect } from 'react'
import { useFilters } from '@/services/filters-service'
import {
  useCreateSubscription,
  useUpdateSubscription,
} from '@/services/subscriptions-service'
import { XIcon } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

interface Subscription {
  id: string
  name: string
  customerId: string
  planId: string
  agentId?: string
  startDate?: string | null
  endDate?: string | null
  isForever?: boolean
  billingCycle: 'monthly' | 'yearly' | 'custom'
  customCycleDays?: number
  billingModel?: 'subscription' | 'usage' | 'hybrid'
  netTerms?: number
  billingDay?: number
  seatsCount?: number
  status?: string
  plan?: {
    id: string
    name: string
  }
  agent?: {
    id: string
    name: string
  }
  customer?: {
    id: string
    name: string
  }
}

interface CreateSubscriptionFormProps {
  isOpen: boolean
  onClose?: () => void
  onOpenChange?: (open: boolean) => void
  onSuccess?: () => void
  mode?: 'create' | 'edit'
  subscription?: Subscription | null
}

interface CreateSubscriptionPayload {
  name: string
  customerId: string
  planId: string
  agentId: string
  startDate: string
  endDate?: string
  isForever: boolean
  billingCycle: 'monthly' | 'yearly' | 'custom'
  customCycleDays?: number
  billingModel: 'subscription' | 'usage' | 'hybrid'
  netTerms?: number
  billingDay?: number
  seatsCount?: number
  autoCollectPayment?: boolean
  invoiceMemo?: string
}

export function CreateSubscriptionForm({
  isOpen,
  onClose,
  onOpenChange,
  onSuccess,
  mode = 'create',
  subscription,
}: CreateSubscriptionFormProps) {
  const isEditMode = mode === 'edit'
  const { mutate: createSubscription, isPending: isCreating } =
    useCreateSubscription()
  const [changeReason, setChangeReason] = useState('')
  const { mutate: updateSubscription, isPending: isUpdating } =
    useUpdateSubscription()
  const { data: filtersData } = useFilters()

  const agents = filtersData?.agents || []
  const customers = filtersData?.customers || []
  const pricingPlans = filtersData?.pricingPlans || []

  const [selectedAgentId, setSelectedAgentId] = useState<string>('')

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)

  // In edit mode, use all pricing plans; in create mode, use agent's plans
  const availablePlans = (() => {
    // In edit mode, always use all pricing plans to ensure current plan is available
    if (isEditMode) {
      let plans = [...pricingPlans]

      // Also ensure the current plan from subscription is included
      if (subscription?.planId && subscription?.plan) {
        const currentPlanExists = plans.some(
          (p) => p.id === subscription.planId
        )
        if (!currentPlanExists) {
          plans.unshift({
            id: subscription.plan.id,
            name: subscription.plan.name,
            description: '',
            isActive: true,
            featuresList: { tags: [] },
          })
        }
      }

      return plans
    }

    if (selectedAgent?.pricingPlans?.length) {
      return selectedAgent.pricingPlans
    }

    return []
  })()

  const [formData, setFormData] = useState<CreateSubscriptionPayload>({
    name: '',
    customerId: '',
    planId: '',
    agentId: '',
    startDate: new Date().toISOString().split('T')[0],
    isForever: true,
    billingCycle: 'monthly',
    billingModel: 'subscription',
    netTerms: 30,
    seatsCount: 1,
  })

  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [formSubmitted, setFormSubmitted] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect -- Intentional form population from prop */
  useEffect(() => {
    if (isEditMode && subscription && isOpen) {
      setSelectedAgentId(subscription.agentId || '')
      setFormData({
        name: subscription.name || '',
        customerId: subscription.customerId || '',
        planId: subscription.planId || '',
        agentId: subscription.agentId || '',
        startDate:
          subscription.startDate?.split('T')[0] ||
          new Date().toISOString().split('T')[0],
        endDate: subscription.endDate?.split('T')[0],
        isForever: subscription.isForever ?? true,
        billingCycle: subscription.billingCycle || 'monthly',
        customCycleDays: subscription.customCycleDays,
        billingModel: subscription.billingModel || 'subscription',
        netTerms: subscription.netTerms ?? 30,
        billingDay: subscription.billingDay,
        // A stored 0 prefills as empty instead of jamming the min-1 validation.
        seatsCount: subscription.seatsCount || undefined,
      })
      setChangeReason('')
    }
  }, [isEditMode, subscription, isOpen])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    field: keyof CreateSubscriptionPayload
  ) => {
    const { value } = e.target

    if (formErrors[field]) {
      setFormErrors({
        ...formErrors,
        [field]: '',
      })
    }

    setFormData({
      ...formData,
      [field]: value,
    })
  }

  const handleSelectChange = (
    value: string,
    field: keyof CreateSubscriptionPayload
  ) => {
    if (formErrors[field]) {
      setFormErrors({
        ...formErrors,
        [field]: '',
      })
    }

    // Special handling for agent selection - reset plan when agent changes (only in create mode)
    if (field === 'agentId') {
      setSelectedAgentId(value)
      if (isEditMode) {
        setFormData({
          ...formData,
          agentId: value,
        })
      } else {
        setFormData({
          ...formData,
          agentId: value,
          planId: '',
        })
      }
      return
    }

    if (field === 'isForever') {
      setFormData({
        ...formData,
        [field]: value === 'true',
      })
      return
    }

    setFormData({
      ...formData,
      [field]: value,
    })
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}

    if (!formData.name.trim()) {
      errors.name = 'Subscription name is required'
    }

    if (!formData.customerId) {
      errors.customerId = 'Customer is required'
    }

    if (!formData.agentId) {
      errors.agentId = 'Agent is required'
    }

    if (!formData.planId) {
      errors.planId = 'Pricing plan is required'
    }

    if (!formData.startDate) {
      errors.startDate = 'Start date is required'
    }

    if (
      formData.billingCycle === 'custom' &&
      (!formData.customCycleDays || formData.customCycleDays < 1)
    ) {
      errors.customCycleDays =
        'Custom cycle days is required for custom billing cycle'
    }

    if (isEditMode && !changeReason.trim()) {
      errors.changeReason = 'Please provide a reason for this change'
    }

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleClose = () => {
    setFormErrors({})
    setFormSubmitted(false)
    setChangeReason('')

    if (onClose) {
      onClose()
    }
    if (onOpenChange) {
      onOpenChange(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormSubmitted(true)

    if (!validateForm()) {
      toast({
        variant: 'destructive',
        title: 'Validation Error',
        description: 'Please fill in all required fields',
      })
      return
    }

    // Prepare submission data - different fields allowed for create vs update
    const submissionData: Record<string, unknown> = {
      name: formData.name,
      planId: formData.planId,
      agentId: formData.agentId,
      isForever: formData.isForever,
      billingCycle: formData.billingCycle,
    }

    // These fields are only allowed for create (not update)
    if (!isEditMode) {
      submissionData.customerId = formData.customerId
      submissionData.startDate = formData.startDate
      submissionData.billingModel = formData.billingModel
    }

    if (formData.endDate && !formData.isForever) {
      submissionData.endDate = formData.endDate
    }

    if (formData.billingCycle === 'custom' && formData.customCycleDays) {
      submissionData.customCycleDays = formData.customCycleDays
    }

    if (formData.netTerms !== undefined) {
      submissionData.netTerms = formData.netTerms
    }

    if (formData.billingDay !== undefined) {
      submissionData.billingDay = formData.billingDay
    }

    // Sent in edit mode too, so an edit can correct a stored 0.
    if (formData.seatsCount !== undefined) {
      submissionData.seatsCount = formData.seatsCount
    } else if (!isEditMode) {
      // A cleared field on create still sends the default; sending nothing
      // would let the action's ?? 0 mint a fresh zero-seat row.
      submissionData.seatsCount = 1
    }

    const mutationOptions = {
      onSuccess: () => {
        toast({
          title: 'Success',
          description: isEditMode
            ? 'Subscription updated successfully'
            : 'Subscription created successfully',
        })

        setFormData({
          name: '',
          customerId: '',
          planId: '',
          agentId: '',
          startDate: new Date().toISOString().split('T')[0],
          isForever: true,
          billingCycle: 'monthly',
          billingModel: 'subscription',
          netTerms: 30,
          seatsCount: 1,
        })
        setSelectedAgentId('')
        setFormErrors({})
        setFormSubmitted(false)
        setChangeReason('')

        if (onSuccess) {
          onSuccess()
        }

        handleClose()
      },
      onError: (error: any) => {
        console.error(
          isEditMode
            ? 'Error updating subscription:'
            : 'Error creating subscription:',
          error
        )
        const errorMessage =
          error?.response?.data?.message ||
          error?.message ||
          (isEditMode
            ? 'Failed to update subscription'
            : 'Failed to create subscription')
        toast({
          variant: 'destructive',
          title: 'Error',
          description: errorMessage,
        })
      },
    }

    if (isEditMode && subscription?.id) {
      updateSubscription(
        {
          subscriptionId: subscription.id,
          data: submissionData,
          changeReason,
        },
        mutationOptions
      )
    } else {
      createSubscription(
        submissionData as unknown as CreateSubscriptionPayload,
        {
          onSuccess: mutationOptions.onSuccess,
          onError: (error: any) => {
            console.error('Error creating subscription:', error)
            const errorMessage =
              error?.response?.data?.message ||
              error?.message ||
              'Failed to create subscription'
            toast({
              variant: 'destructive',
              title: 'Error',
              description: errorMessage,
            })
          },
        }
      )
    }
  }

  if (!isOpen) return null

  return (
    <div className='fixed inset-0 z-50 flex'>
      <div className='fixed inset-0 bg-black/20' onClick={handleClose} />
      <div className='fixed right-0 top-0 flex h-full w-full max-w-md flex-col bg-background shadow-lg'>
        <div className='flex items-center justify-between border-b p-4'>
          <h2 className='text-lg font-semibold'>
            {isEditMode ? 'Edit Subscription' : 'New Subscription'}
          </h2>
          <Button variant='ghost' size='icon' onClick={handleClose}>
            <XIcon className='h-4 w-4' />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className='flex h-full flex-col'>
          <div className='flex-1 overflow-y-auto'>
            <div className='space-y-6 p-6'>
              <div className='space-y-4'>
                <div>
                  <Label htmlFor='name'>Subscription Name</Label>
                  <Input
                    id='name'
                    placeholder='Enter subscription name'
                    onChange={(e) => handleInputChange(e, 'name')}
                    value={formData.name}
                    className={
                      formSubmitted && formErrors.name ? 'border-red-500' : ''
                    }
                  />
                  {formSubmitted && formErrors.name && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.name}
                    </p>
                  )}
                </div>

                <div>
                  <Label htmlFor='customerId'>
                    Customer{' '}
                    {isEditMode && (
                      <span className='text-xs text-muted-foreground'>
                        (cannot change)
                      </span>
                    )}
                  </Label>
                  <Select
                    value={formData.customerId}
                    onValueChange={(value) =>
                      handleSelectChange(value, 'customerId')
                    }
                    disabled={isEditMode}
                  >
                    <SelectTrigger
                      className={
                        formSubmitted && formErrors.customerId
                          ? 'border-red-500'
                          : ''
                      }
                    >
                      <SelectValue placeholder='Select a customer' />
                    </SelectTrigger>
                    <SelectContent>
                      {customers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formSubmitted && formErrors.customerId && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.customerId}
                    </p>
                  )}
                </div>

                <div>
                  <Label htmlFor='agentId'>Agent</Label>
                  <Select
                    value={formData.agentId}
                    onValueChange={(value) =>
                      handleSelectChange(value, 'agentId')
                    }
                  >
                    <SelectTrigger
                      className={
                        formSubmitted && formErrors.agentId
                          ? 'border-red-500'
                          : ''
                      }
                    >
                      <SelectValue placeholder='Select an agent' />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formSubmitted && formErrors.agentId && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.agentId}
                    </p>
                  )}
                </div>

                <div>
                  <Label htmlFor='planId'>Pricing Plan</Label>
                  <Select
                    value={formData.planId}
                    onValueChange={(value) =>
                      handleSelectChange(value, 'planId')
                    }
                    disabled={!isEditMode && !formData.agentId}
                  >
                    <SelectTrigger
                      className={
                        formSubmitted && formErrors.planId
                          ? 'border-red-500'
                          : ''
                      }
                    >
                      <SelectValue
                        placeholder={
                          formData.agentId
                            ? 'Select a pricing plan'
                            : 'Select an agent first'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {availablePlans.map((plan) => (
                        <SelectItem key={plan.id} value={plan.id}>
                          {plan.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {formSubmitted && formErrors.planId && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.planId}
                    </p>
                  )}
                </div>

                {/* Seats — always shown: the plan list here carries no pricing
                    strategies, so there's nothing to gate on. Billing only
                    reads it for seat-based plans. */}
                <div>
                  <Label htmlFor='seatsCount'>Seats</Label>
                  <Input
                    id='seatsCount'
                    type='number'
                    min='1'
                    placeholder='Number of seats'
                    onChange={(e) => {
                      const value = parseInt(e.target.value)
                      setFormData({
                        ...formData,
                        seatsCount: value >= 1 ? value : undefined,
                      })
                    }}
                    value={formData.seatsCount || ''}
                  />
                  <p className='mt-1 text-xs text-muted-foreground'>
                    Only used when the plan bills per seat.
                  </p>
                </div>

                <div>
                  <Label htmlFor='startDate'>
                    Start Date{' '}
                    {isEditMode && (
                      <span className='text-xs text-muted-foreground'>
                        (cannot change)
                      </span>
                    )}
                  </Label>
                  <Input
                    id='startDate'
                    type='date'
                    onChange={(e) => handleInputChange(e, 'startDate')}
                    value={formData.startDate}
                    disabled={isEditMode}
                    className={
                      formSubmitted && formErrors.startDate
                        ? 'border-red-500'
                        : ''
                    }
                  />
                  {formSubmitted && formErrors.startDate && (
                    <p className='mt-1 text-xs text-red-500'>
                      {formErrors.startDate}
                    </p>
                  )}
                </div>

                <div>
                  <Label
                    htmlFor='billingCycle'
                    className='flex items-center gap-1'
                  >
                    Billing Cycle
                    <InfoTooltip {...tooltipDefinitions.billingCycle} />
                  </Label>
                  <Select
                    value={formData.billingCycle}
                    onValueChange={(value) =>
                      handleSelectChange(value, 'billingCycle')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder='Select billing cycle' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='monthly'>Monthly</SelectItem>
                      <SelectItem value='yearly'>Yearly</SelectItem>
                      <SelectItem value='custom'>Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.billingCycle === 'custom' && (
                  <div>
                    <Label htmlFor='customCycleDays'>Custom Cycle Days</Label>
                    <Input
                      id='customCycleDays'
                      type='number'
                      min='1'
                      placeholder='Enter number of days'
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          customCycleDays:
                            parseInt(e.target.value) || undefined,
                        })
                      }}
                      value={formData.customCycleDays || ''}
                      className={
                        formSubmitted && formErrors.customCycleDays
                          ? 'border-red-500'
                          : ''
                      }
                    />
                    {formSubmitted && formErrors.customCycleDays && (
                      <p className='mt-1 text-xs text-red-500'>
                        {formErrors.customCycleDays}
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <Label
                    htmlFor='billingModel'
                    className='flex items-center gap-1'
                  >
                    Billing Model
                    <InfoTooltip {...tooltipDefinitions.billingModel} />{' '}
                    {isEditMode && (
                      <span className='text-xs text-muted-foreground'>
                        (cannot change)
                      </span>
                    )}
                  </Label>
                  <Select
                    value={formData.billingModel}
                    onValueChange={(value) =>
                      handleSelectChange(value, 'billingModel')
                    }
                    disabled={isEditMode}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder='Select billing model' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='subscription'>Subscription</SelectItem>
                      <SelectItem value='usage'>Usage</SelectItem>
                      <SelectItem value='hybrid'>Hybrid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor='isForever'>Duration</Label>
                  <Select
                    value={formData.isForever.toString()}
                    onValueChange={(value) =>
                      handleSelectChange(value, 'isForever')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder='Select duration type' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='true'>
                        Forever (No end date)
                      </SelectItem>
                      <SelectItem value='false'>Fixed duration</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {!formData.isForever && (
                  <div>
                    <Label htmlFor='endDate'>End Date</Label>
                    <Input
                      id='endDate'
                      type='date'
                      onChange={(e) => handleInputChange(e, 'endDate')}
                      value={formData.endDate || ''}
                      min={formData.startDate}
                    />
                  </div>
                )}

                <div>
                  <Label htmlFor='netTerms' className='flex items-center gap-1'>
                    Net Terms (Days)
                    <InfoTooltip {...tooltipDefinitions.netTerms} />
                  </Label>
                  <Input
                    id='netTerms'
                    type='number'
                    min='0'
                    placeholder='30'
                    onChange={(e) => {
                      setFormData({
                        ...formData,
                        netTerms: parseInt(e.target.value) || 30,
                      })
                    }}
                    value={formData.netTerms || 30}
                  />
                </div>

                <div className={isEditMode ? '' : 'pb-14'}>
                  <Label
                    htmlFor='billingDay'
                    className='flex items-center gap-1'
                  >
                    Billing Day (1-31)
                    <InfoTooltip {...tooltipDefinitions.billingDay} />
                  </Label>
                  <Input
                    id='billingDay'
                    type='number'
                    min='1'
                    max='31'
                    placeholder='Day of month for billing'
                    onChange={(e) => {
                      const value = parseInt(e.target.value)
                      setFormData({
                        ...formData,
                        billingDay:
                          value >= 1 && value <= 31 ? value : undefined,
                      })
                    }}
                    value={formData.billingDay || ''}
                  />
                </div>

                {isEditMode && (
                  <div className='pb-14'>
                    <Label htmlFor='changeReason'>Reason for Change *</Label>
                    <Textarea
                      id='changeReason'
                      placeholder='Enter reason for this change (required)'
                      value={changeReason}
                      onChange={(e) => {
                        setChangeReason(e.target.value)
                        if (formErrors.changeReason) {
                          setFormErrors({ ...formErrors, changeReason: '' })
                        }
                      }}
                      className={
                        formSubmitted && formErrors.changeReason
                          ? 'border-red-500'
                          : ''
                      }
                      rows={3}
                    />
                    {formSubmitted && formErrors.changeReason && (
                      <p className='mt-1 text-xs text-red-500'>
                        {formErrors.changeReason}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className='sticky bottom-0 mt-auto border-t bg-background p-4'>
            <Button
              type='submit'
              className='w-full'
              disabled={isCreating || isUpdating}
            >
              {isEditMode
                ? isUpdating
                  ? 'Updating...'
                  : 'Update Subscription'
                : isCreating
                  ? 'Creating...'
                  : 'Create Subscription'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
