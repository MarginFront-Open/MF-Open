/**
 * useOnboardingState Hook
 * Centralized state management for the 4-step onboarding flow:
 * workflow-selection → create-organization → choose-mode → success
 *
 * Features:
 * - LocalStorage persistence for session resumption
 * - Organization creation via Better Auth
 * - Onboarding completion via Server Actions
 */
'use client'

import { useReducer, useCallback, useMemo, useEffect, useRef } from 'react'
import { checkOrgByName } from '@/app/actions/check-org-by-name'
import onboardingService from '@/services/onboarding-service'
import { organizationService } from '@/services/organization-service'
import { setDashboardMode as saveDashboardModeAction } from '@/app/actions/set-dashboard-mode'
import { setUserPersona as savePersonaAction } from '@/app/actions/set-user-persona'
import { useToast } from '@/hooks/use-toast'
import {
  OnboardingStateV2,
  OnboardingAction,
  OnboardingStepV2,
  WorkflowMode,
  DashboardMode,
  UserPersona,
  BrandingData,
  initialOnboardingState,
  getPhaseFromStep,
  getStepPhaseIndex,
} from '../types/v2'

// ============================================
// CONSTANTS
// ============================================

const STORAGE_KEY = 'marginfront_onboarding_state'
const STORAGE_VERSION = '4.0' // Bump when the saved state shape changes
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours

// ============================================
// REDUCER
// ============================================

function onboardingReducer(
  state: OnboardingStateV2,
  action: OnboardingAction
): OnboardingStateV2 {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, currentStep: action.payload }

    case 'SET_WORKFLOW':
      return { ...state, workflow: action.payload }

    case 'SET_ORGANIZATION_NAME':
      return { ...state, organizationName: action.payload }

    case 'SET_ORGANIZATION_CREATED':
      return {
        ...state,
        organizationCreated: action.payload.created,
        organizationId: action.payload.organizationId || state.organizationId,
      }

    case 'SET_DASHBOARD_MODE':
      return { ...state, dashboardMode: action.payload }

    case 'SET_PERSONA':
      return { ...state, persona: action.payload }

    case 'SET_BRANDING':
      return { ...state, branding: { ...state.branding, ...action.payload } }

    case 'SET_LOADING':
      return { ...state, isLoading: action.payload }

    case 'SET_ERROR':
      return { ...state, error: action.payload }

    case 'COMPLETE_ONBOARDING':
      return { ...state, completedAt: new Date() }

    case 'RESET':
      return { ...initialOnboardingState, startedAt: new Date() }

    default:
      return state
  }
}

// ============================================
// STEP NAVIGATION LOGIC
// ============================================

const STEP_ORDER: OnboardingStepV2[] = [
  'workflow-selection',
  'create-organization',
  'choose-mode',
  'success',
]

function getNextStep(currentStep: OnboardingStepV2): OnboardingStepV2 | null {
  const currentIndex = STEP_ORDER.indexOf(currentStep)
  if (currentIndex === -1 || currentIndex >= STEP_ORDER.length - 1) {
    return null
  }
  return STEP_ORDER[currentIndex + 1]
}

function getPreviousStep(
  currentStep: OnboardingStepV2
): OnboardingStepV2 | null {
  const currentIndex = STEP_ORDER.indexOf(currentStep)
  if (currentIndex <= 0) {
    return null
  }
  return STEP_ORDER[currentIndex - 1]
}

// ============================================
// HOOK
// ============================================

export interface UseOnboardingStateReturn {
  // State
  state: OnboardingStateV2

  // Computed values
  currentPhase: ReturnType<typeof getPhaseFromStep>
  phaseIndex: number
  canGoNext: boolean
  canGoBack: boolean
  progressPercent: number

  // Navigation
  goToStep: (step: OnboardingStepV2) => void
  goNext: () => void
  goBack: () => void

  // Actions
  setWorkflow: (mode: WorkflowMode) => void
  setDashboardMode: (mode: DashboardMode) => void
  saveDashboardMode: () => Promise<boolean>
  setPersona: (persona: UserPersona) => void
  savePersona: () => Promise<boolean>
  setOrganizationName: (name: string) => void
  setBranding: (branding: Partial<BrandingData>) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  completeOnboarding: () => void
  reset: () => void

  /**
   * Create organization using Better Auth
   * Returns organization ID on success
   */
  createOrganization: (name: string) => Promise<string | null>

  /**
   * Mark onboarding as complete in database
   */
  markComplete: () => Promise<boolean>

  // Persistence
  hasSavedProgress: boolean
  clearSavedProgress: () => void
}

// ============================================
// PERSISTENCE HELPERS
// ============================================

interface StoredOnboardingData {
  version: string
  timestamp: number
  organizationId?: string
  state: Partial<OnboardingStateV2>
}

function isLocalStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const testKey = '__storage_test__'
    window.localStorage.setItem(testKey, testKey)
    window.localStorage.removeItem(testKey)
    return true
  } catch {
    return false
  }
}

function loadFromStorage(
  organizationId?: string
): Partial<OnboardingStateV2> | null {
  if (!isLocalStorageAvailable()) return null

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null

    const data: StoredOnboardingData = JSON.parse(stored)

    // Check version compatibility
    if (data.version !== STORAGE_VERSION) {
      console.log('[Onboarding] Stored data version mismatch, clearing')
      localStorage.removeItem(STORAGE_KEY)
      return null
    }

    // Check if data is too old (24 hours)
    const age = Date.now() - data.timestamp
    if (age > SESSION_MAX_AGE) {
      console.log('[Onboarding] Stored data expired, clearing')
      localStorage.removeItem(STORAGE_KEY)
      return null
    }

    // Check organization match (if provided)
    if (
      organizationId &&
      data.organizationId &&
      data.organizationId !== organizationId
    ) {
      console.log('[Onboarding] Organization mismatch, clearing')
      localStorage.removeItem(STORAGE_KEY)
      return null
    }

    // Don't restore if we're on workflow-selection (first step)
    if (data.state.currentStep === 'workflow-selection') {
      return null
    }

    console.log(
      '[Onboarding] Restoring saved progress from step:',
      data.state.currentStep
    )
    return data.state
  } catch (error) {
    console.error('[Onboarding] Failed to load progress:', error)
    return null
  }
}

function saveToStorage(
  state: OnboardingStateV2,
  organizationId?: string
): void {
  if (!isLocalStorageAvailable()) return

  try {
    // Don't save if we're on the success step (completed)
    if (state.currentStep === 'success') {
      localStorage.removeItem(STORAGE_KEY)
      return
    }

    // Don't save if we're on workflow-selection (first step)
    if (state.currentStep === 'workflow-selection') {
      return
    }

    const data: StoredOnboardingData = {
      version: STORAGE_VERSION,
      timestamp: Date.now(),
      organizationId,
      state: {
        currentStep: state.currentStep,
        workflow: state.workflow,
        organizationId: state.organizationId || organizationId,
        organizationName: state.organizationName,
        organizationCreated: state.organizationCreated,
        dashboardMode: state.dashboardMode,
        persona: state.persona,
        branding: state.branding,
      },
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (error) {
    console.error('[Onboarding] Failed to save progress:', error)
  }
}

function clearStorage(): void {
  if (!isLocalStorageAvailable()) return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.error('[Onboarding] Failed to clear progress:', error)
  }
}

function checkHasSavedProgress(organizationId?: string): boolean {
  if (!isLocalStorageAvailable()) return false
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return false

    const data: StoredOnboardingData = JSON.parse(stored)
    if (data.version !== STORAGE_VERSION) return false

    const age = Date.now() - data.timestamp
    if (age > SESSION_MAX_AGE) return false

    if (
      organizationId &&
      data.organizationId &&
      data.organizationId !== organizationId
    ) {
      return false
    }

    if (data.state.currentStep === 'workflow-selection') return false

    return true
  } catch {
    return false
  }
}

// ============================================
// HOOK IMPLEMENTATION
// ============================================

export function useOnboardingState(
  initialState?: Partial<OnboardingStateV2>,
  organizationId?: string
): UseOnboardingStateReturn {
  const { toast } = useToast()
  const isInitialized = useRef(false)

  // Try to restore from localStorage on first render
  const getInitialState = (): OnboardingStateV2 => {
    const savedState = loadFromStorage(organizationId)
    return {
      ...initialOnboardingState,
      ...savedState,
      ...initialState,
    }
  }

  const [state, dispatch] = useReducer(
    onboardingReducer,
    undefined,
    getInitialState
  )

  // Auto-save to localStorage on state changes
  useEffect(() => {
    if (!isInitialized.current) {
      isInitialized.current = true
      return
    }
    saveToStorage(state, organizationId)
  }, [state, organizationId])

  // Computed values
  const currentPhase = useMemo(
    () => getPhaseFromStep(state.currentStep),
    [state.currentStep]
  )

  const phaseIndex = useMemo(
    () => getStepPhaseIndex(state.currentStep),
    [state.currentStep]
  )

  const canGoNext = useMemo(
    () => getNextStep(state.currentStep) !== null,
    [state.currentStep]
  )

  const canGoBack = useMemo(
    () => getPreviousStep(state.currentStep) !== null,
    [state.currentStep]
  )

  const progressPercent = useMemo(() => {
    const currentIndex = STEP_ORDER.indexOf(state.currentStep)
    return Math.round((currentIndex / (STEP_ORDER.length - 1)) * 100)
  }, [state.currentStep])

  // Navigation
  const goToStep = useCallback((step: OnboardingStepV2) => {
    dispatch({ type: 'SET_STEP', payload: step })
  }, [])

  const goNext = useCallback(() => {
    const nextStep = getNextStep(state.currentStep)
    if (nextStep) {
      dispatch({ type: 'SET_STEP', payload: nextStep })
    }
  }, [state.currentStep])

  const goBack = useCallback(() => {
    const prevStep = getPreviousStep(state.currentStep)
    if (prevStep) {
      dispatch({ type: 'SET_STEP', payload: prevStep })
    }
  }, [state.currentStep])

  // Actions
  const setWorkflow = useCallback((mode: WorkflowMode) => {
    dispatch({ type: 'SET_WORKFLOW', payload: mode })
  }, [])

  const setDashboardMode = useCallback((mode: DashboardMode) => {
    dispatch({ type: 'SET_DASHBOARD_MODE', payload: mode })
  }, [])

  // Persists the chosen dashboard mode to the database via Server Action
  const saveDashboardMode = useCallback(async (): Promise<boolean> => {
    if (!state.organizationId || !state.dashboardMode) {
      console.error(
        '[Onboarding] Cannot save dashboard mode: missing orgId or mode'
      )
      return false
    }

    try {
      const result = await saveDashboardModeAction(state.dashboardMode)
      if (!result.success) {
        throw new Error(result.error || 'Failed to save dashboard mode')
      }
      console.log('[Onboarding] Dashboard mode saved:', state.dashboardMode)
      return true
    } catch (error) {
      console.error('[Onboarding] Failed to save dashboard mode:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save your selection. Please try again.',
      })
      return false
    }
  }, [state.organizationId, state.dashboardMode, toast])

  const setPersona = useCallback((persona: UserPersona) => {
    dispatch({ type: 'SET_PERSONA', payload: persona })
  }, [])

  // Persists the chosen persona to the database via Server Action
  const savePersona = useCallback(async (): Promise<boolean> => {
    if (!state.persona) {
      return true // No persona selected is OK — it's optional
    }

    try {
      const result = await savePersonaAction(state.persona)
      if (!result.success) {
        throw new Error(result.error || 'Failed to save persona')
      }

      console.log('[Onboarding] Persona saved:', state.persona)
      return true
    } catch (error) {
      console.error('[Onboarding] Failed to save persona:', error)
      // Don't block onboarding if persona save fails — it's not critical
      return true
    }
  }, [state.persona])

  const setOrganizationName = useCallback((name: string) => {
    dispatch({ type: 'SET_ORGANIZATION_NAME', payload: name })
  }, [])

  const setBranding = useCallback((branding: Partial<BrandingData>) => {
    dispatch({ type: 'SET_BRANDING', payload: branding })
  }, [])

  const setLoading = useCallback((loading: boolean) => {
    dispatch({ type: 'SET_LOADING', payload: loading })
  }, [])

  const setError = useCallback((error: string | null) => {
    dispatch({ type: 'SET_ERROR', payload: error })
  }, [])

  const completeOnboarding = useCallback(() => {
    dispatch({ type: 'COMPLETE_ONBOARDING' })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
    clearStorage()
  }, [])

  // ============================================
  // API INTEGRATION METHODS
  // ============================================

  /**
   * Create organization using Better Auth
   * Returns organization ID on success
   */
  const createOrganizationFunc = useCallback(
    async (name: string): Promise<string | null> => {
      dispatch({ type: 'SET_LOADING', payload: true })
      dispatch({ type: 'SET_ERROR', payload: null })

      try {
        console.log('[Onboarding] Creating organization:', name)

        // Check if user already has an organization with this name
        const checkResult = await checkOrgByName(name)
        if (
          checkResult.success &&
          checkResult.data?.exists &&
          checkResult.data.org
        ) {
          const existingOrg = checkResult.data.org

          if (existingOrg.onboardingComplete) {
            console.log(
              '[Onboarding] Organization with same name already exists:',
              existingOrg.name
            )
            const errorMessage = `You already have an organization named "${existingOrg.name}". Please choose a different name.`
            dispatch({ type: 'SET_ERROR', payload: errorMessage })
            dispatch({ type: 'SET_LOADING', payload: false })
            toast({
              variant: 'destructive',
              title: 'Organization Already Exists',
              description: errorMessage,
            })
            return null
          } else {
            console.log(
              '[Onboarding] Found incomplete org with same name:',
              existingOrg.name
            )
            const errorMessage = `You have an existing organization "${existingOrg.name}" with incomplete setup. Use "Continue setup" to resume.`
            dispatch({ type: 'SET_ERROR', payload: errorMessage })
            dispatch({ type: 'SET_LOADING', payload: false })
            return null
          }
        }

        const result = await organizationService.createOrganization({
          name,
          slug: undefined,
          website: '',
          organizationInfo: '',
          linkedin: '',
          logo: state.branding.companyLogo || '',
        })

        if (result.id) {
          console.log('[Onboarding] Organization created:', result.id)

          dispatch({
            type: 'SET_ORGANIZATION_CREATED',
            payload: { created: true, organizationId: result.id },
          })

          dispatch({ type: 'SET_LOADING', payload: false })

          toast({
            title: 'Organization Created!',
            description: `Welcome to ${name}.`,
          })

          return result.id
        }

        throw new Error('Organization creation failed')
      } catch (error) {
        console.error('[Onboarding] Failed to create organization:', error)
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Failed to create organization'
        dispatch({ type: 'SET_ERROR', payload: errorMessage })
        dispatch({ type: 'SET_LOADING', payload: false })
        toast({
          variant: 'destructive',
          title: 'Organization Creation Failed',
          description: errorMessage,
        })
        return null
      }
    },
    [toast, state.branding.companyLogo]
  )

  /**
   * Mark onboarding as complete in database
   */
  const markComplete = useCallback(async (): Promise<boolean> => {
    try {
      console.log('[Onboarding] Marking onboarding complete')

      await onboardingService.markOnboardingComplete({
        primaryColor: state.branding.primaryColor,
        secondaryColor: state.branding.secondaryColor,
        accentColor: state.branding.accentColor,
        companyLogo: state.branding.companyLogo,
      })
      dispatch({ type: 'COMPLETE_ONBOARDING' })
      clearStorage()

      console.log('[Onboarding] Onboarding marked complete')
      return true
    } catch (error) {
      console.error('[Onboarding] Failed to mark complete:', error)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to complete onboarding. Please try again.',
      })
      return false
    }
  }, [state.branding, toast])

  // Persistence helpers
  const hasSavedProgress = useMemo(
    () => checkHasSavedProgress(organizationId),
    [organizationId]
  )

  const clearSavedProgress = useCallback(() => {
    clearStorage()
  }, [])

  return {
    state,
    currentPhase,
    phaseIndex,
    canGoNext,
    canGoBack,
    progressPercent,
    goToStep,
    goNext,
    goBack,
    setWorkflow,
    setDashboardMode,
    saveDashboardMode,
    setPersona,
    savePersona,
    setOrganizationName,
    setBranding,
    setLoading,
    setError,
    completeOnboarding,
    reset,

    // API Integration Methods
    createOrganization: createOrganizationFunc,
    markComplete,

    // Persistence
    hasSavedProgress,
    clearSavedProgress,
  }
}

export default useOnboardingState
