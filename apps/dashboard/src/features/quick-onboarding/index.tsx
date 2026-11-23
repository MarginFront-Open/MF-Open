/**
 * Quick Onboarding - Main Orchestrator
 *
 * 4-step onboarding flow:
 * 1. Workflow Selection (animated intro)
 * 2. Create Organization (name and persona)
 * 3. Choose Mode (which sidebar items the user sees)
 * 4. Success (confetti + redirect to dashboard)
 *
 * Saved progress is offered back through the recovery modal.
 */
'use client'

import { useState, useCallback, useEffect } from 'react'
import { switchOrganization } from '@/app/actions/switch-organization'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
// Layout & Theme
import { useLayout } from '@/context/layout-context'
import { useTheme } from '@/context/theme-context'
import { useToast } from '@/hooks/use-toast'
import { Logo } from '@/components/layout/logo'
import { ThemeSwitch } from '@/components/theme-switch'
import RecoveryModal from './components/shared/RecoveryModal'
// Shared Components
import StepIndicator from './components/shared/StepIndicator'
import CreateOrganizationStep from './components/steps/CreateOrganizationStep'
import ModeSelectionStep from './components/steps/ModeSelectionStep'
import SuccessStep from './components/steps/SuccessStep'
// Step Components
import WorkflowSelectionStep from './components/steps/WorkflowSelectionStep'
import { useAccessibility } from './hooks/useAccessibility'
// Hooks
import { useOnboardingState } from './hooks/useOnboardingState'
import { useSwipeNavigation } from './hooks/useSwipeNavigation'

export interface QuickOnboardingProps {
  /** User's organization ID */
  organizationId?: string
  /** User's name */
  userName?: string
  /** Callback on completion */
  onComplete?: () => void
  /** Whether the user can cancel onboarding (has an existing org) */
  canCancel?: boolean
}

const QuickOnboarding = (props: QuickOnboardingProps) => {
  return <QuickOnboardingInner {...props} />
}

const QuickOnboardingInner = ({
  organizationId,
  userName = 'there',
  onComplete: _onComplete,
  canCancel = false,
}: QuickOnboardingProps) => {
  // Layout context - hide sidebar/navbar for full-screen experience
  const { updateOptions } = useLayout()

  // Hide sidebar and navbar on mount, restore on unmount
  useEffect(() => {
    updateOptions({ sidebar: false, navbar: false })
    return () => updateOptions({ sidebar: true, navbar: true })
  }, [updateOptions])

  // Recovery modal state
  const [showRecoveryModal, setShowRecoveryModal] = useState(false)
  const [recoveryChecked, setRecoveryChecked] = useState(false)

  // Onboarding state management
  const {
    state,
    canGoNext,
    canGoBack,
    goToStep,
    goNext,
    goBack,
    setWorkflow,
    setDashboardMode,
    saveDashboardMode,
    setPersona,
    savePersona,
    setOrganizationName,
    createOrganization,
    markComplete,
    hasSavedProgress,
    reset,
  } = useOnboardingState(undefined, organizationId)

  // Check for saved progress on mount (recovery system)
  useEffect(() => {
    if (
      !recoveryChecked &&
      hasSavedProgress &&
      state.currentStep !== 'workflow-selection'
    ) {
      setShowRecoveryModal(true)
      setRecoveryChecked(true)
    } else if (!recoveryChecked) {
      setRecoveryChecked(true)
    }
  }, [hasSavedProgress, recoveryChecked, state.currentStep])

  // Handle recovery modal actions
  const handleRecoveryContinue = useCallback(() => {
    setShowRecoveryModal(false)
  }, [])

  const handleRecoveryStartFresh = useCallback(() => {
    setShowRecoveryModal(false)
    reset()
  }, [reset])

  // Toast hook for notifications
  const { toast } = useToast()

  // Handle continuing with an existing incomplete organization
  const handleContinueIncomplete = useCallback(
    async (orgId: string, orgName: string) => {
      try {
        const result = await switchOrganization(orgId)
        if (!result.success) {
          throw new Error(result.error || 'Failed to switch organization')
        }

        setOrganizationName(orgName)

        // Write resume state to localStorage and reload
        const resumeState = {
          version: '4.0',
          timestamp: Date.now(),
          organizationId: orgId,
          state: {
            currentStep: 'create-organization',
            organizationName: orgName,
            organizationCreated: true,
            organizationId: orgId,
          },
        }
        localStorage.setItem(
          'marginfront_onboarding_state',
          JSON.stringify(resumeState)
        )

        toast({
          title: 'Continuing setup',
          description: `Resuming setup for ${orgName}`,
        })

        setTimeout(() => {
          window.location.href = '/quick-onboarding'
        }, 500)
      } catch (error) {
        console.error(
          '[QuickOnboarding] Failed to continue with existing org:',
          error
        )
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to switch organization. Please try again.',
        })
      }
    },
    [setOrganizationName, toast]
  )

  // Accessibility
  const {
    stepContainerRef: _stepContainerRef,
    handleKeyDown: _handleKeyDown,
    announceStepChange,
  } = useAccessibility({
    currentStep: state.currentStep,
    onNextStep: goNext,
    onPrevStep: goBack,
    isFirstStep: !canGoBack,
    isLastStep: state.currentStep === 'success',
    canProceed: canGoNext,
  })

  // Announce step changes
  useEffect(() => {
    announceStepChange(state.currentStep)
  }, [state.currentStep, announceStepChange])

  // Swipe navigation
  const { containerRef, swipeOffset } = useSwipeNavigation({
    enabled: true,
    canSwipeLeft: canGoNext,
    canSwipeRight: canGoBack,
    onSwipeLeft: goNext,
    onSwipeRight: goBack,
  })

  // Handle workflow selection
  const handleWorkflowSelect = useCallback(
    (mode: 'quick' | 'build-blocks') => {
      setWorkflow(mode)
      goToStep('create-organization')
    },
    [setWorkflow, goToStep]
  )

  // Handle completion with real API
  const handleComplete = useCallback(async () => {
    try {
      await markComplete()
    } catch (error) {
      console.error('[QuickOnboarding] Failed to mark complete:', error)
    }

    // Navigate to home with full page reload to ensure fresh data
    window.location.href = '/'
  }, [markComplete])

  // Render current step
  const renderStep = () => {
    switch (state.currentStep) {
      case 'workflow-selection':
        return (
          <WorkflowSelectionStep
            selectedWorkflow={state.workflow}
            onSelectWorkflow={setWorkflow}
            onContinue={() => handleWorkflowSelect(state.workflow || 'quick')}
          />
        )

      case 'create-organization':
        return (
          <CreateOrganizationStep
            organizationName={state.organizationName}
            organizationCreated={state.organizationCreated}
            isLoading={state.isLoading}
            error={state.error}
            onOrganizationNameChange={setOrganizationName}
            onCreateOrganization={createOrganization}
            onContinue={async () => {
              await savePersona()
              goNext()
            }}
            onBack={goBack}
            onContinueIncomplete={handleContinueIncomplete}
            persona={state.persona}
            onPersonaChange={setPersona}
          />
        )

      case 'choose-mode':
        return (
          <ModeSelectionStep
            selectedMode={state.dashboardMode}
            onSelectMode={setDashboardMode}
            onContinue={async () => {
              const saved = await saveDashboardMode()
              if (saved) {
                goNext()
              }
            }}
          />
        )

      case 'success':
        return (
          <SuccessStep
            userName={userName}
            companyName={state.organizationName || 'Your Company'}
            onGoToDashboard={handleComplete}
          />
        )

      default:
        return null
    }
  }

  // Step definitions for progress bar
  const stepPhases = [
    { id: 'setup', label: 'Setup' },
    { id: 'complete', label: 'Complete' },
  ]

  // Map current step to phase index
  const getPhaseIndex = () => {
    if (state.currentStep === 'success') return 1
    return 0
  }

  const currentPhaseIndex = getPhaseIndex()

  // Handle cancel - clear state and return to dashboard
  const handleCancel = useCallback(() => {
    localStorage.removeItem('marginfront_onboarding_state')
    window.location.href = '/'
  }, [])

  // Theme detection for light/dark support
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = mounted && resolvedTheme === 'dark'

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex min-h-svh w-full flex-col overflow-hidden',
        isDark
          ? 'bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950'
          : 'bg-white'
      )}
      style={{
        transform: `translateX(${swipeOffset * 0.3}px)`,
        transition: swipeOffset === 0 ? 'transform 0.3s ease-out' : 'none',
      }}
    >
      {/* ============================================ */}
      {/* BACKGROUND - Trapezoid Grid + Gradient */}
      {/* ============================================ */}
      {!isDark && (
        <div className='pointer-events-none absolute inset-0 overflow-hidden'>
          <div
            className='absolute inset-x-0 top-0 h-[85vh]'
            style={{
              clipPath: 'polygon(0% 0%, 100% 0%, 85% 100%, 15% 100%)',
              maskImage:
                'linear-gradient(to bottom, black 0%, black 30%, rgba(0,0,0,0.5) 60%, rgba(0,0,0,0.2) 80%, transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, black 0%, black 30%, rgba(0,0,0,0.5) 60%, rgba(0,0,0,0.2) 80%, transparent 100%)',
            }}
          >
            <div
              className='absolute inset-0'
              style={{
                backgroundImage: `
                  linear-gradient(to right, rgba(16, 185, 129, 0.12) 1px, transparent 1px),
                  linear-gradient(to bottom, rgba(16, 185, 129, 0.12) 1px, transparent 1px)
                `,
                backgroundSize: '50px 50px',
              }}
            />
          </div>

          <div
            className='absolute inset-0'
            style={{
              background:
                'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(16, 185, 129, 0.08) 0%, transparent 60%)',
            }}
          />
        </div>
      )}

      {isDark && (
        <div className='pointer-events-none absolute inset-0 overflow-hidden'>
          <div
            className='absolute inset-0'
            style={{
              background:
                'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(16, 185, 129, 0.2) 0%, rgba(16, 185, 129, 0.05) 40%, transparent 70%)',
            }}
          />

          <div
            className='absolute inset-0 opacity-[0.03]'
            style={{
              backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
                               linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
              backgroundSize: '64px 64px',
            }}
          />
        </div>
      )}

      {/* ============================================ */}
      {/* TOP BAR - Logo, Progress (centered), Theme Switch */}
      {/* ============================================ */}
      <header className='sticky top-0 z-20 w-full bg-transparent px-6 pb-2 pt-4 sm:px-8'>
        <div className='relative flex h-[70px] items-center justify-between'>
          <div className='flex-shrink-0'>
            <Logo
              linkToHome={false}
              size='default'
              className={isDark ? 'text-white' : 'text-neutral-900'}
            />
          </div>

          <div className='absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'>
            <StepIndicator
              currentPhase={currentPhaseIndex}
              phases={stepPhases.map((p) => p.label)}
              size='md'
              showLabelsOnMobile={true}
            />
          </div>

          <div className='flex flex-shrink-0 items-center gap-2'>
            <ThemeSwitch />
            {canCancel && (
              <button
                onClick={handleCancel}
                className={cn(
                  'rounded-md p-2 transition-colors',
                  isDark
                    ? 'text-neutral-400 hover:bg-white/10 hover:text-white'
                    : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600'
                )}
                aria-label='Cancel onboarding and return to dashboard'
                title='Cancel'
              >
                <X className='size-5' />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ============================================ */}
      {/* MAIN CONTENT AREA */}
      {/* ============================================ */}
      <main className='relative flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8'>
        <AnimatePresence mode='wait'>
          <motion.div
            key={state.currentStep}
            className='w-full max-w-lg'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            {renderStep()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Recovery Modal */}
      <RecoveryModal
        isOpen={showRecoveryModal}
        lastStep={state.currentStep}
        lastUpdated={state.startedAt}
        onContinue={handleRecoveryContinue}
        onStartFresh={handleRecoveryStartFresh}
        onDismiss={() => setShowRecoveryModal(false)}
      />
    </div>
  )
}

export default QuickOnboarding
