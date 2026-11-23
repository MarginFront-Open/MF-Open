'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  IconArrowLeft,
  IconSparkles,
  IconRocket,
  IconCrown,
  IconBuildingSkyscraper,
  IconCheck,
  IconGripVertical,
  IconArrowRight
} from '@tabler/icons-react'
import { Plus, Trash2, Lightbulb } from 'lucide-react'
import {
  getPricingPlan as getPricingPlanAction,
  updatePricingPlan as updatePricingPlanAction,
  createPricingPlan as createPricingPlanAction,
} from '@/app/actions/pricing-plans'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Page } from '@/components/layouts/page'

// Suggested features for different plan tiers
const SUGGESTED_FEATURES = {
  starter: [
    'Access to basic features',
    'Email support',
    'Up to 1,000 requests/month',
    'Community access',
  ],
  professional: [
    'All Starter features',
    'Priority email support',
    'Up to 10,000 requests/month',
    'API access',
    'Custom integrations',
    'Analytics dashboard',
  ],
  enterprise: [
    'All Professional features',
    'Dedicated account manager',
    'Unlimited requests',
    '24/7 phone support',
    'Custom SLA',
    'On-premise deployment',
    'SSO & SAML',
  ],
}

// Plan tier icons and colors
const _PLAN_TIERS = [
  { name: 'Starter', icon: IconRocket, color: 'bg-blue-500', suggestion: 'starter' },
  { name: 'Professional', icon: IconSparkles, color: 'bg-purple-500', suggestion: 'professional' },
  { name: 'Enterprise', icon: IconCrown, color: 'bg-amber-500', suggestion: 'enterprise' },
]

export default function PricingPlanForm() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const agentId = params.agentId as string
  const planId = searchParams.get('planId')
  const { toast } = useToast()
  const [isSubmitting, setIsSubmitting] = useState(false)
  // setIsSubmitting hasn't flushed yet when two clicks land in the same JS
  // tick, so a state-based `if (isSubmitting) return` guard lets both
  // through. This ref is synchronous and closes that race.
  const submittingRef = useRef(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isEditMode, setIsEditMode] = useState(false)
  const [selectedTier, setSelectedTier] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [features, setFeatures] = useState<string[]>([
    'Access to agent',
    'Email support',
  ])

  // Check if we're in edit mode based on planId query param
  useEffect(() => {
    if (planId) {
      setIsEditMode(true)
      fetchPlanDetails(planId)
    }
  }, [planId])

  // Auto-detect tier based on plan name
  useEffect(() => {
    const lowerName = name.toLowerCase()
    if (lowerName.includes('enterprise') || lowerName.includes('business')) {
      setSelectedTier('enterprise')
    } else if (lowerName.includes('pro') || lowerName.includes('professional') || lowerName.includes('growth')) {
      setSelectedTier('professional')
    } else if (lowerName.includes('starter') || lowerName.includes('basic') || lowerName.includes('free')) {
      setSelectedTier('starter')
    }
  }, [name])

  const fetchPlanDetails = async (id: string) => {
    try {
      setIsLoading(true)
      const result = await getPricingPlanAction(id, true)

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load pricing plan')
      }

      const planData = result.data

      // Populate form with existing data
      setName(planData.name || '')
      setDescription(planData.description || '')

      if (
        planData.featuresList &&
        (planData.featuresList as any).tags &&
        (planData.featuresList as any).tags.length > 0
      ) {
        setFeatures((planData.featuresList as any).tags)
      }

      setIsLoading(false)
    } catch (error) {
      console.error('Error fetching pricing plan:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load pricing plan details',
      })
      router.push(`/agents/${agentId}/pricing-plans`)
    }
  }

  const handleAddFeature = () => {
    setFeatures([...features, ''])
  }

  const handleFeatureChange = (index: number, value: string) => {
    const newFeatures = [...features]
    newFeatures[index] = value
    setFeatures(newFeatures)
  }

  const handleRemoveFeature = (index: number) => {
    setFeatures(features.filter((_, i) => i !== index))
  }

  const _handleUseSuggestedFeatures = (tier: 'starter' | 'professional' | 'enterprise') => {
    setFeatures(SUGGESTED_FEATURES[tier])
    setSelectedTier(tier)
    toast({
      title: 'Features added',
      description: `${tier.charAt(0).toUpperCase() + tier.slice(1)} tier features have been added.`,
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (submittingRef.current) return
    submittingRef.current = true

    // Validate form
    if (!name.trim()) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Plan name is required',
      })
      submittingRef.current = false
      return
    }

    try {
      setIsSubmitting(true)

      // Inside the try: edit mode loads features from JSONB via `as any`, so a
      // non-string entry can throw here — outside the try that would skip the
      // finally and wedge submittingRef true until remount.
      const filteredFeatures = features.filter((f) => f.trim() !== '')

      if (isEditMode && planId) {
        // Update existing plan
        const updateResult = await updatePricingPlanAction(planId, {
          name,
          description,
          featuresList: { tags: filteredFeatures },
        })

        if (!updateResult.success) {
          throw new Error(updateResult.error || 'Failed to update pricing plan')
        }

        toast({
          title: 'Success',
          description: 'Pricing plan updated successfully.',
        })

        // Navigate back to plan details
        router.push(`/agents/${agentId}/pricing-plans/${planId}`)
      } else {
        // Create new plan
        const createResult = await createPricingPlanAction({
          name,
          description,
          featuresList: { tags: filteredFeatures },
          agentId,
          isActive: false,
        })

        if (!createResult.success || !createResult.data) {
          throw new Error(createResult.error || 'Failed to create pricing plan')
        }

        toast({
          title: 'Success',
          description: 'Pricing plan created. Now configure pricing details.',
        })

        // Navigate to the configure page
        router.push(`/agents/${agentId}/pricing-plans/${createResult.data.id}/configure`)
      }
    } catch (error) {
      console.error('Error saving pricing plan:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: `Failed to ${isEditMode ? 'update' : 'create'} pricing plan`,
      })
    } finally {
      setIsSubmitting(false)
      submittingRef.current = false
    }
  }

  if (isLoading) {
    return (
      <Page
        title="Loading..."
        headerProps={{
          breadcrumb: [
            { name: 'Home', href: '/' },
            { name: 'Agents', href: '/build' },
            { name: 'Pricing Plans', href: `/agents/${agentId}/pricing-plans` },
            { name: 'Loading...' }
          ]
        }}
      >
        <div className='max-w-4xl space-y-6'>
          <Card>
            <CardContent className='pt-6 space-y-4'>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className='pt-6'>
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
        </div>
      </Page>
    )
  }

  return (
    <Page
      title={isEditMode ? 'Edit Pricing Plan' : 'Create New Pricing Plan'}
      headerProps={{
        breadcrumb: [
          { name: 'Home', href: '/' },
          { name: 'Agents', href: '/build' },
          { name: 'Pricing Plans', href: `/agents/${agentId}/pricing-plans` },
          { name: isEditMode ? 'Edit Plan' : 'New Plan' }
        ]
      }}
    >
      <div className='w-full'>
        {/* Back to Metrics link */}
        {!isEditMode && (
          <div className='mb-8'>
            <Button
              variant='ghost'
              className='flex items-center gap-2 text-muted-foreground hover:text-foreground'
              onClick={() => router.push(`/agents/${agentId}/signals`)}
            >
              <IconArrowLeft size={16} />
              Back to Agent Metrics
            </Button>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className='grid gap-6 lg:grid-cols-3'>
            {/* Main Form - Takes 2 columns */}
            <div className='lg:col-span-2 space-y-6'>
              {/* Plan Details Card */}
              <Card className='border border-brand-primary/10 shadow-sm'>
                <CardHeader className='pb-4'>
                  <div className='flex items-center gap-3'>
                    <div className='flex h-10 w-10 items-center justify-center rounded-lg bg-brand-primary/10'>
                      <IconBuildingSkyscraper className='h-5 w-5 text-brand-primary' />
                    </div>
                    <div>
                      <CardTitle className='text-lg text-brand-primary'>Plan Details</CardTitle>
                      <CardDescription>
                        Give your pricing plan a name and description
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className='space-y-5'>
                  <div className='space-y-2'>
                    <Label htmlFor='name' className='text-sm font-medium'>
                      Plan Name <span className='text-destructive'>*</span>
                    </Label>
                    <Input
                      id='name'
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder='e.g. Starter, Professional, Enterprise'
                      className='text-base'
                      maxLength={255}
                      required
                    />
                    <p className='text-xs text-muted-foreground'>
                      Choose a name that clearly communicates the plan&apos;s value
                    </p>
                  </div>

                  <div className='space-y-2'>
                    <Label htmlFor='description' className='text-sm font-medium'>
                      Description
                    </Label>
                    <Textarea
                      id='description'
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder='Describe who this plan is for and what makes it valuable...'
                      className='resize-none text-base'
                      rows={3}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Features Card */}
              <Card className='border border-brand-primary/10 shadow-sm'>
                <CardHeader className='pb-4'>
                  <div className='flex items-center justify-between'>
                    <div className='flex items-center gap-3'>
                      <div className='flex h-10 w-10 items-center justify-center rounded-lg bg-brand-lime/20'>
                        <IconCheck className='h-5 w-5 text-brand-primary' />
                      </div>
                      <div>
                        <CardTitle className='text-lg text-brand-primary'>Features</CardTitle>
                        <CardDescription>
                          What&apos;s included in this plan?
                        </CardDescription>
                      </div>
                    </div>
                    <Badge className='bg-brand-lime text-brand-primary font-medium'>
                      {features.filter(f => f.trim()).length} features
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className='space-y-4'>
                  {/* Feature List */}
                  <div className='space-y-2'>
                    {features.map((feature, index) => (
                      <div
                        key={index}
                        className='group flex items-center gap-2 rounded-lg border bg-muted/30 p-2 transition-colors hover:bg-muted/50'
                      >
                        <IconGripVertical className='h-4 w-4 text-muted-foreground/50' />
                        <Input
                          value={feature}
                          onChange={(e) => handleFeatureChange(index, e.target.value)}
                          placeholder='Enter a feature...'
                          className='flex-1 border-0 bg-transparent px-2 focus-visible:ring-0 focus-visible:ring-offset-0'
                        />
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          onClick={() => handleRemoveFeature(index)}
                          className='h-8 w-8 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100'
                        >
                          <Trash2 className='h-4 w-4' />
                        </Button>
                      </div>
                    ))}
                  </div>

                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='w-full border-dashed'
                    onClick={handleAddFeature}
                  >
                    <Plus className='mr-2 h-4 w-4' />
                    Add Feature
                  </Button>

                </CardContent>
              </Card>

              {/* Actions */}
              <div className='flex items-center justify-between pt-2'>
                <Button
                  type='button'
                  variant='ghost'
                  onClick={() => router.push(`/agents/${agentId}/pricing-plans`)}
                >
                  <IconArrowLeft className='mr-2 h-4 w-4' />
                  Cancel
                </Button>
                <Button
                  type='submit'
                  disabled={isSubmitting || !name.trim()}
                  size='lg'
                  className='gap-2'
                >
                  {isSubmitting ? (
                    isEditMode ? 'Saving...' : 'Creating...'
                  ) : isEditMode ? (
                    'Save Changes'
                  ) : (
                    <>
                      Continue to Pricing
                      <IconArrowRight className='h-4 w-4' />
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Sidebar - Tips & Preview */}
            <div className='space-y-6'>
              {/* Tips Card */}
              <Card className='border-brand-lime/50 bg-brand-lime/10'>
                <CardHeader className='pb-3'>
                  <div className='flex items-center gap-2'>
                    <Lightbulb className='h-5 w-5 text-brand-primary' />
                    <CardTitle className='text-base text-brand-primary'>
                      Pro Tips
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className='space-y-3 text-sm text-brand-primary/80'>
                  <div className='flex gap-2'>
                    <span className='font-medium text-brand-primary'>1.</span>
                    <p>Use clear, benefit-focused feature names that resonate with customers</p>
                  </div>
                  <div className='flex gap-2'>
                    <span className='font-medium text-brand-primary'>2.</span>
                    <p>Limit features to 5-8 per plan for better readability</p>
                  </div>
                  <div className='flex gap-2'>
                    <span className='font-medium text-brand-primary'>3.</span>
                    <p>Differentiate plans by highlighting unique value propositions</p>
                  </div>
                </CardContent>
              </Card>

              {/* Live Preview Card */}
              <Card className='border border-brand-primary/10'>
                <CardHeader className='pb-3'>
                  <CardTitle className='text-base text-brand-primary'>Live Preview</CardTitle>
                  <CardDescription className='text-xs'>
                    How your plan will appear to customers
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className='rounded-lg border-2 border-dashed border-brand-primary/20 p-4 space-y-3'>
                    <div className='flex items-center gap-2'>
                      {selectedTier && (
                        <Badge className='bg-brand-primary text-white'>
                          {selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)}
                        </Badge>
                      )}
                    </div>
                    <h3 className='font-semibold text-lg text-brand-primary'>
                      {name || 'Plan Name'}
                    </h3>
                    <p className='text-sm text-brand-primary/60 line-clamp-2'>
                      {description || 'Plan description will appear here...'}
                    </p>
                    <Separator className='bg-brand-primary/10' />
                    <div className='space-y-2'>
                      {features.filter(f => f.trim()).slice(0, 4).map((feature, i) => (
                        <div key={i} className='flex items-center gap-2 text-sm'>
                          <IconCheck className='h-4 w-4 text-brand-lime flex-shrink-0' />
                          <span className='truncate text-brand-primary/80'>{feature}</span>
                        </div>
                      ))}
                      {features.filter(f => f.trim()).length > 4 && (
                        <p className='text-xs text-brand-primary/50 pl-6'>
                          +{features.filter(f => f.trim()).length - 4} more features
                        </p>
                      )}
                      {features.filter(f => f.trim()).length === 0 && (
                        <p className='text-sm text-brand-primary/50 italic'>
                          No features added yet
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </form>
      </div>
    </Page>
  )
}
