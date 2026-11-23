/**
 * Quick Onboarding Feature Exports
 *
 * All components and utilities are exported from this file.
 */

// Router (recommended entry point)
export { OnboardingRouter } from './OnboardingRouter'
export type { OnboardingRouterProps } from './OnboardingRouter'

// Configuration
export { ONBOARDING_CONFIG, getOnboardingConfig } from './config'
export type { OnboardingConfig } from './config'

// Main component (for direct usage)
export { default as QuickOnboarding } from './index'

// Default export is the router
export { OnboardingRouter as default } from './OnboardingRouter'
