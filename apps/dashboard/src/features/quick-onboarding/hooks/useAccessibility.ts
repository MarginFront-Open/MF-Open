/**
 * Quick Onboarding Accessibility Hook
 * Provides keyboard navigation, focus management, and screen reader support
 */
import { useCallback, useEffect, useRef, RefObject } from 'react'
import type { OnboardingStepV2 } from '../types/v2'

export interface UseAccessibilityOptions {
  currentStep: OnboardingStepV2
  onNextStep: () => void
  onPrevStep: () => void
  onSkipStep?: () => void
  isFirstStep: boolean
  isLastStep: boolean
  canProceed: boolean
}

export interface UseAccessibilityReturn {
  // Refs for focus management
  stepContainerRef: RefObject<HTMLDivElement | null>
  primaryActionRef: RefObject<HTMLButtonElement | null>

  // Keyboard handlers
  handleKeyDown: (event: React.KeyboardEvent) => void

  // Focus management
  focusPrimaryAction: () => void
  focusStepContainer: () => void

  // Accessibility announcements
  announceStepChange: (step: OnboardingStepV2) => void
  announceProgress: (progress: number) => void

  // ARIA attributes helpers
  getStepAriaProps: () => Record<string, string | number>
  getProgressAriaProps: (progress: number) => Record<string, string | number>
}

export const STEP_LABELS: Record<OnboardingStepV2, string> = {
  'workflow-selection': 'Welcome',
  'create-organization': 'Create Your Organization',
  'choose-mode': 'Choose Your Mode',
  success: 'Setup Complete',
}

/**
 * Both the aria region label and the live announcement resolve through here so
 * neither announces a raw step id like "choose-mode".
 */
export function getStepLabel(step: OnboardingStepV2): string {
  return STEP_LABELS[step] || 'Onboarding Step'
}

export function useAccessibility({
  currentStep,
  onNextStep,
  onPrevStep,
  onSkipStep,
  isFirstStep,
  isLastStep,
  canProceed,
}: UseAccessibilityOptions): UseAccessibilityReturn {
  const stepContainerRef = useRef<HTMLDivElement>(null)
  const primaryActionRef = useRef<HTMLButtonElement>(null)
  const announcerRef = useRef<HTMLDivElement | null>(null)

  // Create live region for announcements
  useEffect(() => {
    if (typeof document === 'undefined') return

    // Check if announcer already exists
    let announcer = document.getElementById(
      'quick-onboarding-announcer'
    ) as HTMLDivElement | null

    if (!announcer) {
      announcer = document.createElement('div')
      announcer.id = 'quick-onboarding-announcer'
      announcer.setAttribute('role', 'status')
      announcer.setAttribute('aria-live', 'polite')
      announcer.setAttribute('aria-atomic', 'true')
      announcer.className = 'sr-only'
      document.body.appendChild(announcer)
    }

    announcerRef.current = announcer

    return () => {
      // Don't remove on unmount as other components may use it
    }
  }, [])

  // Focus management functions
  const focusPrimaryAction = useCallback(() => {
    if (primaryActionRef.current) {
      primaryActionRef.current.focus()
    }
  }, [])

  // Focus primary action when step changes
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      focusPrimaryAction()
    }, 100)

    return () => clearTimeout(timeoutId)
  }, [currentStep, focusPrimaryAction])

  // Keyboard navigation handler
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const { key, ctrlKey, metaKey } = event

      // Navigate with arrow keys when holding Ctrl/Cmd
      if (ctrlKey || metaKey) {
        switch (key) {
          case 'ArrowRight':
            if (!isLastStep && canProceed) {
              event.preventDefault()
              onNextStep()
            }
            break
          case 'ArrowLeft':
            if (!isFirstStep) {
              event.preventDefault()
              onPrevStep()
            }
            break
        }
        return
      }

      // Skip with Ctrl/Cmd + S (skip step)
      if ((ctrlKey || metaKey) && key === 's' && onSkipStep) {
        event.preventDefault()
        onSkipStep()
        return
      }

      // Enter to proceed (only when not in an input/textarea)
      if (key === 'Enter' && !isLastStep && canProceed) {
        const target = event.target as HTMLElement
        const tagName = target.tagName.toLowerCase()
        const isFormElement = ['input', 'textarea', 'select'].includes(tagName)
        const isButton = tagName === 'button'

        if (!isFormElement && !isButton) {
          event.preventDefault()
          onNextStep()
        }
      }

      // Escape to go back
      if (key === 'Escape' && !isFirstStep) {
        event.preventDefault()
        onPrevStep()
      }
    },
    [isFirstStep, isLastStep, canProceed, onNextStep, onPrevStep, onSkipStep]
  )

  const focusStepContainer = useCallback(() => {
    if (stepContainerRef.current) {
      stepContainerRef.current.focus()
    }
  }, [])

  // Announcement functions
  const announceStepChange = useCallback((step: OnboardingStepV2) => {
    if (announcerRef.current) {
      announcerRef.current.textContent = `Now on step: ${getStepLabel(step)}`
    }
  }, [])

  const announceProgress = useCallback((progress: number) => {
    if (announcerRef.current) {
      announcerRef.current.textContent = `Onboarding progress: ${Math.round(progress)}% complete`
    }
  }, [])

  // ARIA attribute helpers
  const getStepAriaProps = useCallback(() => {
    return {
      role: 'region',
      'aria-label': getStepLabel(currentStep),
      tabIndex: -1,
    }
  }, [currentStep])

  const getProgressAriaProps = useCallback((progress: number) => {
    return {
      role: 'progressbar',
      'aria-valuenow': Math.round(progress),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-label': `Onboarding progress: ${Math.round(progress)}% complete`,
    }
  }, [])

  return {
    stepContainerRef,
    primaryActionRef,
    handleKeyDown,
    focusPrimaryAction,
    focusStepContainer,
    announceStepChange,
    announceProgress,
    getStepAriaProps,
    getProgressAriaProps,
  }
}

export default useAccessibility
