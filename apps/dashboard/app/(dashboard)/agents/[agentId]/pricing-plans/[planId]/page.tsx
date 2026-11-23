'use client'

import { Fragment, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Settings, Pencil, ArrowLeft } from 'lucide-react'
import { PricingPlan, PricingStrategy } from '@/lib/api/pricing'
import { getPricingPlan as getPricingPlanAction } from '@/app/actions/pricing-plans'
import { formatCurrency } from '@/lib/canon-format'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Page } from '@/components/layouts/page'

export default function PricingPlanDetailsComponent() {
  const params = useParams()
  const router = useRouter()
  const agentId = params.agentId as string
  const planId = params.planId as string
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(true)
  const [plan, setPlan] = useState<PricingPlan | null>(null)

  useEffect(() => {
    const fetchPricingPlan = async () => {
      try {
        setIsLoading(true)

        // Get the pricing plan details
        const result = await getPricingPlanAction(planId, true)
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Failed to load pricing plan')
        }
        setPlan(result.data as any)
      } catch (_error) {
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load pricing plan details',
        })

        // Redirect back to pricing plans list on error
        router.push(`/agents/${agentId}/pricing-plans`)
      } finally {
        setIsLoading(false)
      }
    }

    if (planId) {
      fetchPricingPlan()
    }
  }, [agentId, planId, toast, router])

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

  if (isLoading) {
    return (
      <Page
        title='Loading...'
        headerProps={{
          breadcrumb: [
            { name: 'Home', href: '/' },
            { name: 'Agents', href: '/build' },
            { name: 'Pricing Plans', href: `/agents/${agentId}/pricing-plans` },
            { name: 'Loading...' },
          ],
          actionButtons: (
            <>
              <Button variant='outline' disabled>
                <Pencil className='size-4' />
                Edit Details
              </Button>
              <Button variant='outline' disabled>
                <Settings className='size-4' />
                Configure Pricing
              </Button>
            </>
          ),
        }}
      >
        <div className='space-y-6'>
          <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
            <Card>
              <CardHeader>
                <Skeleton className='h-6 w-32' />
              </CardHeader>
              <CardContent className='space-y-4'>
                <Skeleton className='h-4 w-full' />
                <Skeleton className='h-4 w-3/4' />
                <Skeleton className='h-4 w-1/2' />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <Skeleton className='h-6 w-32' />
              </CardHeader>
              <CardContent>
                <Skeleton className='h-20 w-full' />
              </CardContent>
            </Card>
          </div>
        </div>
      </Page>
    )
  }

  if (!plan) {
    return (
      <Page
        title='Plan Not Found'
        headerProps={{
          breadcrumb: [
            { name: 'Home', href: '/' },
            { name: 'Agents', href: '/build' },
            { name: 'Pricing Plans', href: `/agents/${agentId}/pricing-plans` },
            { name: 'Not Found' },
          ],
        }}
      >
        <div className='flex h-64 flex-col items-center justify-center space-y-4'>
          <p className='text-lg text-muted-foreground'>
            Pricing plan not found
          </p>
          <Button
            onClick={() => router.push(`/agents/${agentId}/pricing-plans`)}
          >
            <ArrowLeft className='size-4' />
            Back to Pricing Plans
          </Button>
        </div>
      </Page>
    )
  }

  return (
    <Page
      title={plan.name}
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          { name: 'Agents', href: '/build' },
          { name: 'Pricing Plans', href: `/agents/${agentId}/pricing-plans` },
          { name: plan.name },
        ],
        actionButtons: (
          <>
            <Button
              variant='outline'
              onClick={() =>
                router.push(
                  `/agents/${agentId}/pricing-plans/new?planId=${planId}`
                )
              }
            >
              <Pencil className='size-4' />
              Edit Details
            </Button>
            <Button
              onClick={() =>
                router.push(
                  `/agents/${agentId}/pricing-plans/${planId}/configure`
                )
              }
            >
              <Settings className='size-4' />
              Configure Pricing
            </Button>
          </>
        ),
      }}
    >
      {plan.description && (
        <p className='mb-6 text-sm text-muted-foreground'>{plan.description}</p>
      )}

      <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center justify-between text-lg font-medium'>
              <span>Plan Details</span>
              <Badge
                variant='outline'
                className={
                  plan.isActive
                    ? 'border-theme-accent-200 bg-theme-accent-50 text-theme-accent-700'
                    : 'border-gray-200 bg-gray-50 text-gray-600'
                }
              >
                {plan.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className='space-y-4'>
              <div>
                <p className='text-sm text-muted-foreground'>Created</p>
                <p>{new Date(plan.createdAt).toLocaleDateString()}</p>
              </div>
              <div>
                <p className='text-sm text-muted-foreground'>Last Updated</p>
                <p>{new Date(plan.updatedAt).toLocaleDateString()}</p>
              </div>
              <div>
                <p className='text-sm text-muted-foreground'>Agent</p>
                <p>{plan.agent?.name}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className='text-lg font-medium'>Features</CardTitle>
          </CardHeader>
          <CardContent>
            {plan.featuresList &&
            ((plan.featuresList as any).tags?.length > 0 ||
              (plan.featuresList as any).features?.length > 0) ? (
              <ul className='list-disc space-y-1 pl-5'>
                {(
                  (plan.featuresList as any).tags ||
                  (plan.featuresList as any).features ||
                  []
                ).map((feature: string, index: number) => (
                  <li key={index}>{feature}</li>
                ))}
              </ul>
            ) : (
              <p className='text-muted-foreground'>No features specified</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator className='my-8' />

      <h2 className='mb-6 text-lg font-medium'>Pricing Strategies</h2>

      {plan.pricingStrategies && plan.pricingStrategies.length > 0 ? (
        <div className='space-y-4'>
          {plan.pricingStrategies
            .filter((s) => !s.signalId || s.agentId === agentId)
            .map((strategy) => (
              <Card key={strategy.id || strategy.name}>
                <CardContent className='pt-6'>
                  <div className='flex items-start justify-between'>
                    <div className='flex-1'>
                      <div className='mb-2 flex items-center gap-2'>
                        <h3 className='text-base font-medium'>
                          {strategy.signal?.shortName ||
                            strategy.signal?.name ||
                            strategy.name}
                        </h3>
                        <Badge variant='outline' className='text-xs'>
                          {strategy.chargeType === 'recurring'
                            ? 'Recurring'
                            : strategy.chargeType === 'onetime'
                              ? 'One-time'
                              : strategy.chargeType === 'usage'
                                ? 'Usage-based'
                                : strategy.chargeType === 'seat_based'
                                  ? 'Seat-based'
                                  : strategy.chargeType}
                        </Badge>
                        {strategy.active && (
                          <Badge
                            variant='default'
                            className='bg-green-600 text-xs'
                          >
                            Active
                          </Badge>
                        )}
                      </div>

                      <div className='mb-3 text-sm text-muted-foreground'>
                        {strategy.pricingModel === 'flat' ||
                        !strategy.pricingModel
                          ? 'Flat Rate'
                          : strategy.pricingModel === 'volume'
                            ? 'Volume-based Pricing'
                            : strategy.pricingModel === 'graduated'
                              ? 'Graduated Pricing'
                              : strategy.pricingModel}
                        {strategy.billingFrequency && (
                          <>
                            {' '}
                            • Billed{' '}
                            {strategy.billingFrequency === 'yearly'
                              ? 'Yearly'
                              : 'Monthly'}
                          </>
                        )}
                        {strategy.signal && (
                          <>
                            {' '}
                            • Signal:{' '}
                            {strategy.signal.shortName || strategy.signal.name}
                          </>
                        )}
                      </div>
                    </div>

                    <div className='text-right'>
                      <p className='text-xl font-semibold'>
                        {formatCurrency(getStrategyRate(strategy))}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        {strategy.chargeType === 'recurring'
                          ? `per ${strategy.billingFrequency === 'yearly' ? 'year' : 'month'}`
                          : strategy.chargeType === 'onetime'
                            ? 'one-time'
                            : strategy.chargeType === 'seat_based'
                              ? `per seat/${strategy.billingFrequency === 'yearly' ? 'year' : 'month'}`
                              : strategy.chargeType === 'usage'
                                ? `per ${(strategy.signal?.shortName || strategy.signal?.name || 'unit').toLowerCase()}`
                                : 'per unit'}
                      </p>
                    </div>
                  </div>

                  {/* Show tiers if available */}
                  {strategy.tiers && strategy.tiers.length > 0 && (
                    <div className='mt-4 border-t pt-4'>
                      <p className='mb-2 text-sm font-medium'>Pricing Tiers</p>
                      <div className='grid grid-cols-2 gap-2 text-sm'>
                        <span className='text-muted-foreground'>Range</span>
                        <span className='text-muted-foreground'>Rate</span>
                        {strategy.tiers.map((tier: any, index: number) => (
                          <Fragment key={index}>
                            <span>{formatTierRange(tier)}</span>
                            <span>{formatCurrency(tier.rate)}</span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Show minimum commitment if available */}
                  {strategy.minimumCommitment && (
                    <div className='mt-3 border-t pt-3'>
                      <p className='text-sm'>
                        <span className='text-muted-foreground'>
                          Minimum Commitment:
                        </span>{' '}
                        <span className='font-medium'>
                          {strategy.minimumCommitment.toLocaleString()}{' '}
                          {(
                            strategy.signal?.shortName ||
                            strategy.signal?.name ||
                            'units'
                          ).toLowerCase()}
                        </span>
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
        </div>
      ) : (
        <Card>
          <CardContent className='py-8 text-center'>
            <p className='text-muted-foreground'>
              No pricing strategies configured
            </p>
          </CardContent>
        </Card>
      )}
    </Page>
  )
}
