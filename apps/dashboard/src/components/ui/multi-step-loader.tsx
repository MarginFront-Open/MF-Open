'use client'

import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

const CheckIcon = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      fill='none'
      viewBox='0 0 24 24'
      strokeWidth={1.5}
      stroke='currentColor'
      className={cn('h-6 w-6', className)}
    >
      <path d='M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' />
    </svg>
  )
}

const CheckFilled = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      viewBox='0 0 24 24'
      fill='currentColor'
      className={cn('h-6 w-6', className)}
    >
      <path
        fillRule='evenodd'
        d='M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z'
        clipRule='evenodd'
      />
    </svg>
  )
}

const LoadingSpinner = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth={2}
      className={cn('h-6 w-6 animate-spin', className)}
    >
      <path d='M21 12a9 9 0 1 1-6.219-8.56' />
    </svg>
  )
}

export type LoadingState = {
  text: string
}

const LoaderCore = ({
  loadingStates,
  value = 0,
}: {
  loadingStates: LoadingState[]
  value?: number
}) => {
  return (
    <div className='relative mx-auto flex max-w-xl flex-col justify-start'>
      {loadingStates.map((loadingState, index) => {
        const distance = Math.abs(index - value)
        const opacity = Math.max(1 - distance * 0.3, 0)

        return (
          <motion.div
            key={index}
            className={cn('mb-4 flex items-center gap-3 text-left')}
            initial={{ opacity: 0, y: 0 }}
            animate={{ opacity: opacity, y: -(value * 44) }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            <div className='flex-shrink-0'>
              {index > value && <CheckIcon className='text-muted-foreground' />}
              {index < value && <CheckFilled className='text-primary' />}
              {index === value && <LoadingSpinner className='text-primary' />}
            </div>
            <span
              className={cn(
                'text-base',
                index < value && 'text-muted-foreground',
                index === value && 'font-medium text-foreground',
                index > value && 'text-muted-foreground/60'
              )}
            >
              {loadingState.text}
            </span>
          </motion.div>
        )
      })}
    </div>
  )
}

export const MultiStepLoader = ({
  loadingStates,
  loading,
  duration = 2000,
  loop = false,
  currentStep,
  onComplete,
}: {
  loadingStates: LoadingState[]
  loading?: boolean
  duration?: number
  loop?: boolean
  currentStep?: number
  onComplete?: () => void
}) => {
  const [currentState, setCurrentState] = useState(0)

  // If currentStep is provided externally, use it
  const displayValue = currentStep !== undefined ? currentStep : currentState

  useEffect(() => {
    if (!loading) {
      setCurrentState(0)
      return
    }

    // If currentStep is controlled externally, don't auto-advance
    if (currentStep !== undefined) {
      return
    }

    const timeout = setTimeout(() => {
      setCurrentState((prevState) => {
        if (prevState === loadingStates.length - 1) {
          if (loop) {
            return 0
          }
          onComplete?.()
          return prevState
        }
        return prevState + 1
      })
    }, duration)

    return () => clearTimeout(timeout)
  }, [
    currentState,
    loading,
    loop,
    loadingStates.length,
    duration,
    currentStep,
    onComplete,
  ])

  return (
    <AnimatePresence mode='wait'>
      {loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className='flex w-full items-center justify-center'
        >
          <div className='relative flex h-[280px] items-start overflow-hidden pt-[120px]'>
            <LoaderCore value={displayValue} loadingStates={loadingStates} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
