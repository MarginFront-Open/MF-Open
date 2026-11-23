/**
 * Quick Onboarding types for the 4-step flow:
 * workflow-selection → create-organization → choose-mode → success
 */

export interface BrandingData {
  primaryColor: string
  secondaryColor?: string
  accentColor?: string
  companyLogo?: string
}

// Short alias used across the onboarding components
export type OnboardingState = OnboardingStateV2

// Short alias used across the onboarding components
export type OnboardingStep = OnboardingStepV2

// Step definitions for layout
export const ONBOARDING_STEPS = [
  {
    id: 'workflow-selection',
    label: 'Workflow',
    phase: 'setup',
    description: 'Getting started',
  },
  {
    id: 'create-organization',
    label: 'Organization',
    phase: 'setup',
    description: 'Create your organization',
  },
  {
    id: 'choose-mode',
    label: 'Mode',
    phase: 'setup',
    description: 'What do you want to do?',
  },
  {
    id: 'success',
    label: 'Complete',
    phase: 'complete',
    description: 'Setup complete',
  },
] as const

// ============================================
// STEP TYPES
// ============================================

// 4 steps mapped to 2 phases
export type OnboardingStepV2 =
  | 'workflow-selection'
  | 'create-organization'
  | 'choose-mode'
  | 'success'

// Workflow modes
export type WorkflowMode = 'quick' | 'build-blocks' | null

// Dashboard mode — what the user wants to do with the product
export type DashboardMode = 'cost_tracking' | 'revenue' | 'full'

// User persona — their role/function, used for UX personalization
export type UserPersona =
  | 'founder'
  | 'finance'
  | 'gtm_sales'
  | 'product_engineering'
  | 'ops'
  | 'investor_advisor'
  | 'other'

// Human-readable labels for the persona dropdown
export const PERSONA_LABELS: Record<UserPersona, string> = {
  founder: 'Founder',
  finance: 'Finance',
  gtm_sales: 'GTM / Sales',
  product_engineering: 'Product / Engineering',
  ops: 'Ops',
  investor_advisor: 'Investor / Advisor',
  other: 'Other',
}

// Phase mapping
export type OnboardingPhase = 'setup' | 'complete'

// Get phase from step
export const getPhaseFromStep = (step: OnboardingStepV2): OnboardingPhase => {
  if (step === 'success') return 'complete'
  return 'setup'
}

// Step index for progress indicator (0, 1)
export const getStepPhaseIndex = (step: OnboardingStepV2): number => {
  const phase = getPhaseFromStep(step)
  switch (phase) {
    case 'setup':
      return 0
    case 'complete':
      return 1
  }
}

// ============================================
// MAIN STATE INTERFACE
// ============================================

export interface OnboardingStateV2 {
  // Current position
  currentStep: OnboardingStepV2
  workflow: WorkflowMode

  // User data
  userId?: string
  organizationId?: string
  userName?: string

  // Organization
  organizationName: string
  organizationCreated: boolean

  // Dashboard mode — chosen during onboarding, controls sidebar visibility
  dashboardMode: DashboardMode | null

  // User persona — their role/function
  persona: UserPersona | null

  // Branding (carried through to markComplete)
  branding: BrandingData

  // UI State
  isLoading: boolean
  error: string | null

  // Timestamps
  startedAt: Date
  completedAt: Date | null
}

// ============================================
// ACTION TYPES FOR STATE REDUCER
// ============================================

export type OnboardingAction =
  | { type: 'SET_STEP'; payload: OnboardingStepV2 }
  | { type: 'SET_WORKFLOW'; payload: WorkflowMode }
  | { type: 'SET_ORGANIZATION_NAME'; payload: string }
  | {
      type: 'SET_ORGANIZATION_CREATED'
      payload: { created: boolean; organizationId?: string }
    }
  | { type: 'SET_BRANDING'; payload: Partial<BrandingData> }
  | { type: 'SET_DASHBOARD_MODE'; payload: DashboardMode }
  | { type: 'SET_PERSONA'; payload: UserPersona }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'COMPLETE_ONBOARDING' }
  | { type: 'RESET' }

// ============================================
// INITIAL STATE
// ============================================

export const initialOnboardingState: OnboardingStateV2 = {
  currentStep: 'workflow-selection',
  workflow: null,

  // Organization
  organizationName: '',
  organizationCreated: false,

  // No mode selected yet — null until user picks one
  dashboardMode: null,

  // No persona selected yet
  persona: null,

  // Branding
  branding: {
    primaryColor: '',
  },

  isLoading: false,
  error: null,

  startedAt: new Date(),
  completedAt: null,
}

// ============================================
// SHARED TYPES (used by developer-zone components)
// ============================================

export interface PricingPlanV2 {
  id: string
  name: string
  price: number
  billingCycle: 'monthly' | 'yearly' | 'usage'
  features: string[]
  isPopular?: boolean
  isEdited?: boolean
  enabled: boolean
}

export type MetricType = 'activity' | 'outcome'

export interface BillingMetric {
  id: string
  name: string
  shortName: string
  costPerUnit: number
  type: MetricType
  aiSuggested?: boolean
  description?: string
}
