// @ts-nocheck
'use client'

import { useState } from 'react'
import {
  IconPlus,
  IconArrowRight,
  IconCheck,
  IconInfoCircle,
  IconCopy,
  IconUsers,
  IconLink,
} from '@tabler/icons-react'
import {
  copyPricingPlan as copyPricingPlanAction,
  getPricingPlans as getPricingPlansAction,
  linkPlanToAgent as linkPlanToAgentAction,
} from '@/app/actions/pricing-plans'
import { useAgent } from '@/services/agent-service'
import { useAgentPricingPlans } from '@/services/pricing-plans-service'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { PricingPlan, PricingStrategy } from '@/lib/api'
import { useOrgCurrency } from '@/hooks/use-org-currency'
import { useToast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// @ts-nocheck

export default function PricingPlans() {
  const params = useParams()
  const agentId = params.agentId as string
  const router = useRouter()
  const { toast } = useToast()
  const { orgCurrency, currencySymbol: _currencySymbol } = useOrgCurrency()

  // React Query hooks - data is cached, instant loading on tab switch
  const { data: agent } = useAgent(agentId)
  const { data: plansData, isLoading, refetch } = useAgentPricingPlans(agentId)
  const pricingPlans = plansData?.results || []

  const [selectedPlan, setSelectedPlan] = useState<PricingPlan | null>(null)
  const [copyDialogOpen, setCopyDialogOpen] = useState(false)
  const [copyFormData, setCopyFormData] = useState({
    name: '',
    discount: 0,
    requestedYearly: false,
  })

  // "Link existing plan" dialog state
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [availablePlans, setAvailablePlans] = useState<
    { id: string; name: string; description: string | null }[]
  >([])
  const [linkingPlanId, setLinkingPlanId] = useState<string | null>(null)

  // Fetch all org plans and filter out ones already linked to this agent
  const openLinkDialog = async () => {
    const result = await getPricingPlansAction({ limit: 100 })
    if (result.success && result.data) {
      const linkedPlanIds = new Set(pricingPlans.map((p) => p.id))
      const unlinked = result.data.results.filter(
        (p) => !linkedPlanIds.has(p.id)
      )
      setAvailablePlans(unlinked)
    }
    setLinkDialogOpen(true)
  }

  const handleLinkPlan = async (planId: string) => {
    setLinkingPlanId(planId)
    try {
      const result = await linkPlanToAgentAction(planId, agentId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to link plan')
      }
      await refetch()
      setLinkDialogOpen(false)
      toast({
        title: 'Plan linked',
        description:
          'Next step: create a subscription to connect a customer to this plan.',
        duration: 8000,
        action: (
          <ToastAction
            altText='Go to Subscriptions'
            onClick={() => router.push('/subscriptions')}
          >
            Subscriptions
          </ToastAction>
        ),
      })
    } catch (error) {
      console.error('Error linking plan:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          error instanceof Error ? error.message : 'Failed to link plan',
      })
    } finally {
      setLinkingPlanId(null)
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: orgCurrency,
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount)
  }

  const _getStrategyByName = (
    plan: PricingPlan,
    name: string
  ): PricingStrategy | undefined => {
    return plan.pricingStrategies?.find((strategy) => strategy.name === name)
  }

  // Get setup fee strategy - look for exact name OR chargeType 'onetime'
  const getSetupFeeStrategy = (
    plan: PricingPlan
  ): PricingStrategy | undefined => {
    return plan.pricingStrategies?.find(
      (strategy) =>
        strategy.name === 'setup_fee' ||
        (strategy.chargeType === 'onetime' &&
          strategy.name?.toLowerCase().includes('setup'))
    )
  }

  // Get platform fee strategy - look for exact name OR chargeType 'recurring' (excluding usage-based)
  const getPlatformFeeStrategy = (
    plan: PricingPlan
  ): PricingStrategy | undefined => {
    return plan.pricingStrategies?.find(
      (strategy) =>
        strategy.name === 'platform_fee' ||
        (strategy.chargeType === 'recurring' &&
          strategy.name?.toLowerCase().includes('platform'))
    )
  }

  // Get seat-based strategy from the plan
  const getSeatBasedStrategy = (
    plan: PricingPlan
  ): PricingStrategy | undefined => {
    return plan.pricingStrategies?.find(
      (strategy) => strategy.chargeType === 'seat_based'
    )
  }

  // Helper to get rate from strategy - handles both tiers array and direct rate field
  const getStrategyRate = (strategy: PricingStrategy | undefined): number => {
    if (!strategy) return 0
    // First check tiers array
    if (
      strategy.tiers &&
      strategy.tiers.length > 0 &&
      strategy.tiers[0]?.rate
    ) {
      return strategy.tiers[0].rate
    }
    // Fall back to direct rate field
    return strategy.rate || 0
  }

  const formatTierRange = (tier: { lower: number; upper: number | null }) => {
    if (tier.upper === null) {
      return `${tier.lower}+`
    }
    return `${tier.lower}–${tier.upper}`
  }

  const handleCopyPlan = async () => {
    if (!selectedPlan) return

    try {
      // Use custom name if provided, otherwise generate based on modifiers
      let newName = copyFormData.name

      if (!newName) {
        const discountSuffix =
          copyFormData.discount > 0 ? ` - ${copyFormData.discount}% off` : ''
        const yearlySuffix = copyFormData.requestedYearly ? ' (Yearly)' : ''
        newName = `${selectedPlan.name}${discountSuffix}${yearlySuffix}`
      }

      const result = await copyPricingPlanAction(selectedPlan.id, {
        newName,
        newDescription: selectedPlan.description,
        discount: copyFormData.discount,
        requestedYearly: copyFormData.requestedYearly,
      })

      if (!result.success) {
        throw new Error(result.error || 'Failed to copy pricing plan')
      }

      // Refetch the pricing plans list
      await refetch()

      // Reset form and close dialog
      setCopyFormData({
        name: '',
        discount: 0,
        requestedYearly: false,
      })
      setCopyDialogOpen(false)

      toast({
        title: 'Success',
        description: 'Pricing plan copied successfully',
      })
    } catch (error) {
      console.error('Error copying pricing plan:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to copy pricing plan',
      })
    }
  }

  return (
    <div className='space-y-6'>
      <div className='mb-4 flex justify-between'>
        <div>
          <h2 className='text-xl font-semibold'>Pricing Plans</h2>
          <p className='text-muted-foreground'>
            Manage pricing plans for this agent
          </p>
        </div>
        <div className='flex gap-2'>
          <Button variant='outline' onClick={openLinkDialog}>
            <IconLink size={18} className='mr-1' />
            <span>Link Existing Plan</span>
          </Button>
          <Link href={`/agents/${agentId}/pricing-plans/new`}>
            <Button className='space-x-1'>
              <span>New Plan</span> <IconPlus size={18} />
            </Button>
          </Link>
        </div>
      </div>

      <Separator className='mb-6' />

      {isLoading ? (
        <div className='grid gap-6 md:grid-cols-2'>
          {[1, 2].map((i) => (
            <Card
              key={i}
              className='flex h-full flex-col border border-border/50 bg-card'
            >
              <CardHeader>
                <div className='flex items-center justify-between'>
                  <Skeleton className='h-6 w-32' />
                  <Skeleton className='h-5 w-16' />
                </div>
                <Skeleton className='mt-2 h-4 w-full' />
                <Skeleton className='mt-1 h-4 w-3/4' />
              </CardHeader>
              <CardContent className='flex-grow space-y-6'>
                <div>
                  <Skeleton className='mb-3 h-4 w-28' />
                  <div className='space-y-2'>
                    <Skeleton className='h-4 w-full' />
                    <Skeleton className='h-4 w-full' />
                    <Skeleton className='h-4 w-2/3' />
                  </div>
                </div>
                <div>
                  <Skeleton className='mb-3 h-4 w-24' />
                  <div className='space-y-2'>
                    <Skeleton className='h-4 w-full' />
                    <Skeleton className='h-4 w-full' />
                  </div>
                </div>
              </CardContent>
              <CardFooter className='mt-auto border-t pt-4'>
                <div className='flex w-full gap-2'>
                  <Skeleton className='h-9 flex-1' />
                  <Skeleton className='h-9 w-9' />
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : pricingPlans.length === 0 ? (
        <div className='flex h-64 flex-col items-center justify-center'>
          <p className='text-muted-foreground'>No pricing plans found</p>
          <Link href={`/agents/${agentId}/pricing-plans/new`} className='mt-4'>
            <Button size='sm'>Create your first pricing plan</Button>
          </Link>
        </div>
      ) : (
        <div className='grid gap-6 md:grid-cols-2'>
          {pricingPlans.map((plan) => (
            <Card
              key={plan.id}
              className='relative flex h-full flex-col border border-border/50 bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg'
            >
              <CardHeader>
                <CardTitle className='flex items-center justify-between'>
                  <span className='text-xl font-semibold tracking-tight'>
                    {plan.name}
                  </span>
                  <Badge
                    variant={plan.isActive ? 'default' : 'secondary'}
                    className='font-normal'
                  >
                    {plan.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </CardTitle>
                <CardDescription className='text-sm text-muted-foreground'>
                  {plan.description || 'Usage-based pricing for this agent.'}
                </CardDescription>
              </CardHeader>
              <CardContent className='flex-grow'>
                <div className='space-y-6'>
                  {/* Pricing Overview */}
                  <div>
                    <h3 className='mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground'>
                      Pricing Overview
                    </h3>
                    <div className='space-y-2'>
                      {/* Setup Fee */}
                      {getSetupFeeStrategy(plan) && (
                        <div className='flex items-center justify-between py-1.5'>
                          <span className='text-sm text-muted-foreground'>
                            Setup Fee
                          </span>
                          <span className='font-medium'>
                            {formatCurrency(
                              getStrategyRate(getSetupFeeStrategy(plan))
                            )}
                            <span className='ml-1 text-xs text-muted-foreground'>
                              (One-time)
                            </span>
                          </span>
                        </div>
                      )}

                      {/* Platform Fee */}
                      {getPlatformFeeStrategy(plan) && (
                        <div className='flex items-center justify-between py-1.5'>
                          <span className='text-sm text-muted-foreground'>
                            Platform Fee
                          </span>
                          <span className='font-medium'>
                            {formatCurrency(
                              getStrategyRate(getPlatformFeeStrategy(plan))
                            )}
                            <span className='ml-1 text-xs text-muted-foreground'>
                              /
                              {getPlatformFeeStrategy(plan)
                                ?.billingFrequency === 'yearly'
                                ? 'year'
                                : 'month'}
                            </span>
                          </span>
                        </div>
                      )}

                      {/* Seat-based Fee */}
                      {getSeatBasedStrategy(plan) && (
                        <div className='flex items-center justify-between py-1.5'>
                          <span className='flex items-center text-sm text-muted-foreground'>
                            <IconUsers size={16} className='mr-1.5' />
                            Seat Fee
                          </span>
                          <span className='font-medium'>
                            {formatCurrency(
                              getStrategyRate(getSeatBasedStrategy(plan))
                            )}
                            <span className='ml-1 text-xs text-muted-foreground'>
                              /seat
                              {getSeatBasedStrategy(plan)?.billingFrequency ===
                              'yearly'
                                ? '/year'
                                : '/month'}
                            </span>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Metrics-based Charges */}
                  <div>
                    <h3 className='mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground'>
                      Metrics-based Charges
                    </h3>
                    <div className='space-y-2'>
                      {plan.pricingStrategies
                        ?.filter(
                          (strategy) =>
                            strategy.chargeType === 'usage' &&
                            strategy.agentId === agentId
                        )
                        .sort((a, b) => {
                          // Sort by signal name alphabetically
                          const nameA = (
                            a.signal?.name ||
                            a.name ||
                            ''
                          ).toLowerCase()
                          const nameB = (
                            b.signal?.name ||
                            b.name ||
                            ''
                          ).toLowerCase()
                          return nameA.localeCompare(nameB)
                        })
                        .map((strategy) => (
                          <div key={strategy.id || strategy.name}>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className='flex cursor-help items-center justify-between rounded-md py-1.5 hover:bg-muted/50'>
                                    <div className='flex items-center gap-1.5'>
                                      <span className='text-sm text-muted-foreground'>
                                        {strategy.signal?.shortName ||
                                          strategy.signal?.name ||
                                          strategy.name}
                                      </span>
                                      <IconInfoCircle
                                        size={14}
                                        className='text-muted-foreground/70'
                                      />
                                    </div>
                                    {strategy.pricingModel === 'flat' ||
                                    !strategy.pricingModel ? (
                                      <span className='font-medium'>
                                        {formatCurrency(
                                          getStrategyRate(strategy)
                                        )}
                                        <span className='ml-1 text-xs text-muted-foreground'>
                                          per{' '}
                                          {strategy.signal?.name?.toLowerCase() ||
                                            'unit'}
                                        </span>
                                      </span>
                                    ) : (
                                      <span className='text-sm font-medium'>
                                        {strategy.tiers &&
                                        strategy.tiers.length > 0 ? (
                                          <>
                                            {/* Find the first two non-zero tiers */}
                                            {(() => {
                                              const nonZeroTiers =
                                                strategy.tiers
                                                  .filter(
                                                    (tier) => tier.rate > 0
                                                  )
                                                  .slice(0, 2)
                                              if (nonZeroTiers.length === 0)
                                                return 'Custom pricing'

                                              return (
                                                <>
                                                  {formatCurrency(
                                                    nonZeroTiers[0].rate
                                                  )}
                                                  {nonZeroTiers.length > 1 && (
                                                    <>
                                                      {' '}
                                                      →{' '}
                                                      {formatCurrency(
                                                        nonZeroTiers[1].rate
                                                      )}
                                                    </>
                                                  )}
                                                  {strategy.tiers.length >
                                                    nonZeroTiers.length && (
                                                    <>
                                                      {' '}
                                                      +{' '}
                                                      <span className='text-xs text-muted-foreground'>
                                                        more tiers
                                                      </span>
                                                    </>
                                                  )}
                                                  <div className='text-xs text-muted-foreground'>
                                                    {strategy.pricingModel ===
                                                    'volume'
                                                      ? 'Volume-based pricing'
                                                      : 'Graduated pricing'}
                                                  </div>
                                                </>
                                              )
                                            })()}
                                          </>
                                        ) : (
                                          <>
                                            {strategy.pricingModel === 'volume'
                                              ? 'Volume-based '
                                              : 'Graduated '}
                                            pricing
                                          </>
                                        )}
                                      </span>
                                    )}
                                  </div>
                                </TooltipTrigger>
                                {(strategy.pricingModel === 'volume' ||
                                  strategy.pricingModel === 'graduated') && (
                                  <TooltipContent
                                    side='right'
                                    className='w-[200px]'
                                  >
                                    <div className='space-y-2'>
                                      <p className='text-xs font-medium'>
                                        {strategy.pricingModel === 'volume'
                                          ? 'Volume-Based'
                                          : 'Graduated'}
                                        Pricing Tiers
                                      </p>
                                      <div className='grid gap-1'>
                                        {strategy.tiers?.map((tier, index) => (
                                          <div
                                            key={index}
                                            className='grid grid-cols-2 gap-2 text-xs'
                                          >
                                            <span className='text-muted-foreground'>
                                              {formatTierRange(tier)}
                                            </span>
                                            <span className='font-medium'>
                                              {formatCurrency(tier.rate)} each
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </TooltipContent>
                                )}
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        ))}
                    </div>
                  </div>

                  {/* Features */}
                  <div>
                    <h3 className='mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground'>
                      Features Included
                    </h3>
                    {plan.featuresList &&
                    (plan.featuresList.tags?.length > 0 ||
                      plan.featuresList.features?.length > 0) ? (
                      <ul className='grid grid-cols-1 gap-2'>
                        {(
                          plan.featuresList.tags ||
                          plan.featuresList.features ||
                          []
                        ).map((feature: string, index: number) => (
                          <li
                            key={index}
                            className='flex items-center text-sm text-muted-foreground'
                          >
                            <IconCheck
                              size={16}
                              className='mr-2 text-primary'
                            />
                            {feature}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <ul className='grid grid-cols-1 gap-2'>
                        <li className='flex items-center text-sm text-muted-foreground'>
                          <IconCheck size={16} className='mr-2 text-primary' />
                          Access to{' '}
                          <strong className='ml-1'>{agent?.name}</strong>
                        </li>
                        <li className='flex items-center text-sm text-muted-foreground'>
                          <IconCheck size={16} className='mr-2 text-primary' />
                          Monthly usage resets
                        </li>
                        <li className='flex items-center text-sm text-muted-foreground'>
                          <IconCheck size={16} className='mr-2 text-primary' />
                          Full signal tracking and analytics
                        </li>
                        <li className='flex items-center text-sm text-muted-foreground'>
                          <IconCheck size={16} className='mr-2 text-primary' />
                          Email support
                        </li>
                      </ul>
                    )}
                  </div>
                </div>
              </CardContent>
              <CardFooter className='flex gap-2 border-t bg-muted/50 p-4'>
                <Link
                  href={`/agents/${agentId}/pricing-plans/${plan.id}`}
                  className='flex-1'
                >
                  <Button
                    variant='outline'
                    className='w-full hover:bg-background'
                  >
                    <span>View Details</span>
                    <IconArrowRight size={16} className='ml-2' />
                  </Button>
                </Link>
                <div className='flex flex-1 gap-2'>
                  <Button
                    variant='outline'
                    className='flex-1'
                    onClick={() => {
                      setSelectedPlan(plan)
                      // Pre-populate the name in state, not just as a
                      // display fallback. Without this the input shows
                      // a default but copyFormData.name stays empty,
                      // so submitting without typing falls through to
                      // server-side auto-numbering ("{Original} 3").
                      setCopyFormData({
                        name: `${plan.name} Copy`,
                        discount: 0,
                        requestedYearly: false,
                      })
                      setCopyDialogOpen(true)
                    }}
                  >
                    <IconCopy size={16} className='mr-2' />
                    Copy
                  </Button>
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Copy Plan Dialog */}
      <Dialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy Pricing Plan</DialogTitle>
            <DialogDescription>
              Create a copy of{' '}
              <span className='font-medium'>{selectedPlan?.name}</span> with
              optional modifications.
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='planName'>Plan Name</Label>
              <Input
                id='planName'
                value={copyFormData.name}
                onChange={(e) =>
                  setCopyFormData((prev) => ({
                    ...prev,
                    name: e.target.value,
                  }))
                }
                placeholder='Enter new plan name'
              />
            </div>

            <div className='space-y-2'>
              <Label htmlFor='discount'>Discount Percentage</Label>
              <Input
                id='discount'
                type='number'
                min='0'
                max='100'
                value={copyFormData.discount}
                onChange={(e) =>
                  setCopyFormData((prev) => ({
                    ...prev,
                    discount: Number(e.target.value),
                  }))
                }
                placeholder='Enter discount percentage'
              />
            </div>

            <div className='flex items-center space-x-2'>
              <Switch
                id='yearly'
                checked={copyFormData.requestedYearly}
                onCheckedChange={(checked) =>
                  setCopyFormData((prev) => ({
                    ...prev,
                    requestedYearly: checked,
                  }))
                }
              />
              <Label htmlFor='yearly'>Convert to Yearly Billing</Label>
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant='outline'>Cancel</Button>
            </DialogClose>
            <Button onClick={handleCopyPlan}>Copy Plan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link Existing Plan Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link Existing Plan</DialogTitle>
            <DialogDescription>
              Choose a plan from your organization to make available for this
              agent. The plan itself stays the same. It just becomes usable here
              too.
            </DialogDescription>
          </DialogHeader>

          <div className='max-h-80 space-y-2 overflow-y-auto'>
            {availablePlans.length === 0 ? (
              <p className='py-8 text-center text-sm text-muted-foreground'>
                All your plans are already linked to this agent.
              </p>
            ) : (
              availablePlans.map((plan) => (
                <div
                  key={plan.id}
                  className='flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50'
                >
                  <div>
                    <p className='font-medium'>{plan.name}</p>
                    {plan.description && (
                      <p className='text-sm text-muted-foreground'>
                        {plan.description}
                      </p>
                    )}
                  </div>
                  <Button
                    size='sm'
                    disabled={linkingPlanId === plan.id}
                    onClick={() => handleLinkPlan(plan.id)}
                  >
                    {linkingPlanId === plan.id ? 'Linking...' : 'Link'}
                  </Button>
                </div>
              ))
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant='outline'>Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
