import React from 'react'
import { cn } from '@/lib/utils'

export interface StepProgressWithLabelsProps {
  steps: string[] // Labels for each step
  currentStep: number // Current active step (1-indexed)
  onStepClick?: (step: number) => void // Optional callback for step navigation
  allowNavigation?: boolean // Whether clicking on steps is allowed for navigation
  className?: string // Additional custom classes
  title?: string // Title for the wizard
  showCancel?: boolean // Show cancel button
  onCancel?: () => void // Cancel callback
}

const StepProgressWithLabels: React.FC<StepProgressWithLabelsProps> = ({
  steps,
  currentStep,
  onStepClick,
  allowNavigation = false,
  className,
  title = 'Create New Agent',
  showCancel = false,
  onCancel,
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

  // Handle cancel
  const handleCancel = () => {
    if (onCancel) {
      onCancel()
    }
  }

  return (
    <div className={cn('w-full', className)}>
      <div className='flex w-full flex-col'>
        {/* Steps with bullets in a single row */}
        <div className='mb-4 flex items-center justify-between overflow-x-auto px-4'>
          {steps.map((step, index) => {
            const stepNumber = index + 1
            const isCompleted = stepNumber < currentStep
            const isCurrent = stepNumber === currentStep

            return (
              <React.Fragment key={`step-container-${index}`}>
                {index > 0 && (
                  <div
                    className='mx-2 h-[1px] flex-grow bg-gray-200'
                    aria-hidden='true'
                  />
                )}
                <div
                  key={`step-${index}`}
                  className={cn(
                    'flex items-center gap-2 whitespace-nowrap',
                    allowNavigation &&
                      (isCompleted || isCurrent) &&
                      'cursor-pointer'
                  )}
                  onClick={() =>
                    allowNavigation &&
                    (isCompleted || isCurrent) &&
                    handleStepClick(stepNumber)
                  }
                  onKeyDown={(e) =>
                    allowNavigation &&
                    (isCompleted || isCurrent) &&
                    handleKeyDown(e, stepNumber)
                  }
                  role={
                    allowNavigation && (isCompleted || isCurrent)
                      ? 'button'
                      : undefined
                  }
                  tabIndex={
                    allowNavigation && (isCompleted || isCurrent)
                      ? 0
                      : undefined
                  }
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span
                    className={cn(
                      'text-xl leading-none',
                      isCompleted || isCurrent
                        ? 'text-primary'
                        : 'text-gray-300'
                    )}
                    aria-hidden='true'
                  >
                    {isCompleted || isCurrent ? '●' : '○'}
                  </span>
                  <span
                    className={cn(
                      'text-sm font-medium',
                      isCompleted || isCurrent
                        ? 'text-primary'
                        : 'text-gray-400'
                    )}
                  >
                    {step}
                  </span>
                </div>
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default StepProgressWithLabels
