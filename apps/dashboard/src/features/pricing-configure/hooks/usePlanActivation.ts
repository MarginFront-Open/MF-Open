import { useState } from 'react'
import { updatePricingPlan as updatePricingPlanAction } from '@/app/actions/pricing-plans'
import { useToast } from '@/hooks/use-toast'

export function usePlanActivation(planId: string, initialActiveState: boolean) {
  const [isPlanActive, setIsPlanActive] = useState(initialActiveState)
  const [showActivationDialog, setShowActivationDialog] = useState(false)
  const [activationPending, setActivationPending] = useState(false)
  const { toast } = useToast()

  const handleToggle = () => {
    // Only show confirmation when activating a plan
    // (Deactivation is prevented by disabling the toggle when plan is active)
    if (!isPlanActive) {
      setShowActivationDialog(true)
    }
  }

  const confirmActivation = async () => {
    try {
      setActivationPending(true)

      const result = await updatePricingPlanAction(planId, {
        isActive: true,
      })

      if (!result.success) {
        throw new Error(result.error || 'Failed to activate plan')
      }

      setIsPlanActive(true)

      toast({
        title: 'Plan Activated',
        description:
          'The pricing plan is now live and available for subscriptions.',
      })
    } catch (error) {
      console.error('Error activating plan:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to activate plan',
      })
    } finally {
      setActivationPending(false)
      setShowActivationDialog(false)
    }
  }

  const cancelActivation = () => {
    setShowActivationDialog(false)
  }

  return {
    isPlanActive,
    showActivationDialog,
    activationPending,
    handleToggle,
    confirmActivation,
    cancelActivation,
    setIsPlanActive,
  }
}
