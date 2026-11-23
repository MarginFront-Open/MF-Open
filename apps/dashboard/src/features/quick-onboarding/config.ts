/**
 * Onboarding Configuration
 *
 * Configuration for the quick onboarding flow.
 */

export interface OnboardingConfig {
  name: string
  description: string
  steps: number
  estimatedTime: string
  features: string[]
  theme: 'light' | 'dark'
}

/**
 * Onboarding configuration
 */
export const ONBOARDING_CONFIG: OnboardingConfig = {
  name: 'Quick Onboarding',
  description: 'Streamlined onboarding flow',
  steps: 3,
  estimatedTime: '1 minute',
  features: ['organization-creation', 'session-recovery'],
  theme: 'light',
} as const

/**
 * Get the onboarding configuration
 */
export function getOnboardingConfig(): OnboardingConfig {
  return ONBOARDING_CONFIG
}
