/**
 * Onboarding Service
 * Fully Server Action based service for onboarding operations
 */
import {
  updateOnboardingStatus as updateOnboardingStatusAction,
  markOnboardingComplete as markOnboardingCompleteAction,
  getOnboardingStatus as getOnboardingStatusAction,
  type BrandingDataInput,
} from '@/app/actions/onboarding'

// Re-export types
export type { BrandingDataInput }

export const onboardingService = {
  /**
   * Update onboarding status - Uses Server Action
   */
  updateOnboardingStatus: async (params: {
    onboardingComplete?: boolean
    onboardingStep?: string | null
  }) => {
    const result = await updateOnboardingStatusAction(params)
    if (!result.success) {
      throw new Error(result.error || 'Failed to update onboarding status')
    }
    return result.data
  },

  /**
   * Mark onboarding as complete - Uses Server Action
   * Optionally saves branding data (colors, logo) to the organization
   */
  markOnboardingComplete: async (branding?: BrandingDataInput) => {
    const result = await markOnboardingCompleteAction(branding)
    if (!result.success) {
      throw new Error(result.error || 'Failed to mark onboarding complete')
    }
    return result.data
  },

  /**
   * Get onboarding status - Uses Server Action
   */
  getOnboardingStatus: async () => {
    const result = await getOnboardingStatusAction()
    if (!result.success) {
      throw new Error(result.error || 'Failed to get onboarding status')
    }
    return result.data
  },
}

export default onboardingService
