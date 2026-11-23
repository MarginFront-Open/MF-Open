import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { StepProgress, StepProgressWithLabels } from './index'

export const StepProgressDemo = () => {
  const [currentStep, setCurrentStep] = useState(1)
  const steps = [
    'Details',
    'Signals',
    'Plans',
    'Pricing Rules',
    'Costs',
    'Review',
  ]

  const handleNextStep = () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1)
    }
  }

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  const handleStepClick = (step: number) => {
    setCurrentStep(step)
  }

  return (
    <div className='space-y-12 p-8'>
      <div className='space-y-6'>
        <h2 className='text-xl font-bold'>Regular Step Progress</h2>
        <div className='rounded-md border bg-white p-6 shadow-sm'>
          <StepProgress
            steps={steps}
            currentStep={currentStep}
            onStepClick={handleStepClick}
            allowNavigation={true}
          />

          <div className='flex min-h-[150px] items-center justify-center rounded-md border bg-gray-50 p-8'>
            <p className='text-lg text-gray-700'>
              Step {currentStep}: {steps[currentStep - 1]} Content
            </p>
          </div>

          <div className='mt-6 flex justify-between'>
            <Button
              variant='outline'
              onClick={handlePrevStep}
              disabled={currentStep === 1}
            >
              Previous
            </Button>
            <Button
              onClick={handleNextStep}
              disabled={currentStep === steps.length}
            >
              {currentStep === steps.length ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </div>

      <div className='space-y-6'>
        <h2 className='text-xl font-bold'>Agent Wizard Style</h2>
        <div className='rounded-md border bg-white p-6 shadow-sm'>
          <StepProgressWithLabels
            steps={steps}
            currentStep={currentStep}
            onStepClick={handleStepClick}
            allowNavigation={true}
          />

          <div className='flex min-h-[150px] items-center justify-center rounded-md border bg-gray-50 p-8'>
            <p className='text-lg text-gray-700'>
              Step {currentStep}: {steps[currentStep - 1]} Content
            </p>
          </div>

          <div className='mt-6 flex justify-between'>
            <Button
              variant='outline'
              onClick={handlePrevStep}
              disabled={currentStep === 1}
            >
              Previous
            </Button>
            <Button
              onClick={handleNextStep}
              disabled={currentStep === steps.length}
            >
              {currentStep === steps.length ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default StepProgressDemo
