import React from 'react'
import { CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface StepProgressProps {
  steps: string[] // Labels for each step
  currentStep: number // Current active step (1-indexed)
  onStepClick?: (step: number) => void // Optional callback for step navigation
  allowNavigation?: boolean // Whether clicking on steps is allowed for navigation
  className?: string // Additional custom classes
}

const StepProgress: React.FC<StepProgressProps> = ({
  steps,
  currentStep,
  onStepClick,
  allowNavigation = false,
  className,
}) => {
  // Handle click on a step
  const handleStepClick = (stepIndex: number) => {
    if (allowNavigation && onStepClick) {
      onStepClick(stepIndex)
    }
  }

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent, stepIndex: number) => {
    if (
      allowNavigation &&
      onStepClick &&
      (e.key === 'Enter' || e.key === ' ')
    ) {
      e.preventDefault()
      onStepClick(stepIndex)
    }
  }

  return (
    <div className={cn('w-full py-4', className)}>
      <div className='w-full'>
        {/* Step count indicator */}
        <div className='mb-2 flex justify-between px-4'>
          <button
            className='text-sm text-gray-500 hover:text-gray-700 focus:outline-none'
            onClick={() =>
              allowNavigation && onStepClick && onStepClick(currentStep - 1)
            }
            disabled={currentStep === 1 || !allowNavigation}
            aria-label='Back'
          >
            {currentStep > 1 ? '← Back' : ''}
          </button>
          <div className='text-sm font-medium text-gray-600'>
            Step {currentStep} of {steps.length}
          </div>
          <button
            className='text-sm text-gray-500 hover:text-gray-700 focus:outline-none'
            onClick={() =>
              allowNavigation && onStepClick && onStepClick(currentStep + 1)
            }
            disabled={currentStep === steps.length || !allowNavigation}
            aria-label='Next'
          >
            {currentStep < steps.length ? 'Next →' : ''}
          </button>
        </div>

        {/* Progress bar */}
        <div className='relative mb-4 h-1 w-full rounded-full bg-gray-200'>
          <div
            className='absolute h-1 rounded-full bg-primary transition-all duration-300'
            style={{
              width: `${((currentStep - 1) / (steps.length - 1)) * 100}%`,
            }}
            aria-hidden='true'
          />
        </div>

        {/* Steps */}
        <div className='relative flex items-center justify-between px-4'>
          {/* Connecting line */}
          <div
            className='absolute left-8 right-8 top-1/2 z-0 h-[1px] -translate-y-1/2 bg-gray-200'
            aria-hidden='true'
          />

          {/* Step indicators */}
          <div className='relative z-10 flex w-full justify-between'>
            {steps.map((step, index) => {
              const stepNumber = index + 1
              const isCompleted = stepNumber < currentStep
              const isCurrent = stepNumber === currentStep
              const isPending = stepNumber > currentStep

              return (
                <div
                  key={`step-${index}`}
                  className={cn(
                    'flex flex-col items-center',
                    allowNavigation && !isPending && 'cursor-pointer',
                    isPending && 'cursor-default'
                  )}
                  onClick={() => isCompleted && handleStepClick(stepNumber)}
                  onKeyDown={(e) => isCompleted && handleKeyDown(e, stepNumber)}
                  role={allowNavigation && !isPending ? 'button' : undefined}
                  tabIndex={allowNavigation && !isPending ? 0 : undefined}
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-label={`Step ${stepNumber}: ${step}`}
                >
                  <div
                    className={cn(
                      'mb-2 flex h-8 w-8 items-center justify-center rounded-full text-sm',
                      isCompleted
                        ? 'bg-primary text-white'
                        : isCurrent
                          ? 'border-2 border-primary bg-white text-primary'
                          : 'border-2 border-gray-300 bg-white text-gray-400'
                    )}
                  >
                    {isCompleted ? (
                      <CheckCircle className='h-5 w-5' />
                    ) : (
                      <span>{isCurrent ? '●' : '○'}</span>
                    )}
                  </div>
                  <span
                    className={cn(
                      'max-w-[100px] truncate text-center text-sm font-medium',
                      isCompleted
                        ? 'text-gray-700'
                        : isCurrent
                          ? 'text-primary'
                          : 'text-gray-400'
                    )}
                    title={step}
                  >
                    {step}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export default StepProgress
