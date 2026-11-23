/**
 * CreateOrganizationStep Component
 * Collects organization name for new organization creation
 */
'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { checkOrgByName } from '@/app/actions/check-org-by-name'
import { Building2, ArrowRight, Loader2, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'
import { UserPersona, PERSONA_LABELS } from '../../types/v2'

export interface CreateOrganizationStepProps {
  /** Current organization name value */
  organizationName: string
  /** Whether organization was already created */
  organizationCreated: boolean
  /** Loading state */
  isLoading?: boolean
  /** Error message */
  error?: string | null
  /** Callback when organization name changes */
  onOrganizationNameChange: (name: string) => void
  /** Callback to create organization */
  onCreateOrganization: (name: string) => Promise<string | null>
  /** Callback to proceed to next step */
  onContinue: () => void
  /** Callback to go back */
  onBack?: () => void
  /** Callback when user wants to continue with existing incomplete org */
  onContinueIncomplete?: (orgId: string, orgName: string) => void
  /** Current persona selection */
  persona: UserPersona | null
  /** Callback when persona changes */
  onPersonaChange: (persona: UserPersona) => void
}

const CreateOrganizationStep = ({
  organizationName,
  organizationCreated,
  isLoading = false,
  error,
  onOrganizationNameChange,
  onCreateOrganization,
  onContinue,
  onBack: _onBack,
  onContinueIncomplete,
  persona,
  onPersonaChange,
}: CreateOrganizationStepProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [validationError, setValidationError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isFocused, setIsFocused] = useState(false)

  // State for detecting incomplete organizations
  const [incompleteOrg, setIncompleteOrg] = useState<{
    id: string
    name: string
  } | null>(null)
  const [isCheckingOrg, setIsCheckingOrg] = useState(false)
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Debounced check for existing org with incomplete onboarding
  useEffect(() => {
    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current)
    }

    if (!organizationName || organizationName.trim().length < 2) {
      setIncompleteOrg(null)
      setIsCheckingOrg(false)
      return
    }

    setIsCheckingOrg(true)
    checkTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await checkOrgByName(organizationName)
        if (result.success && result.data?.exists && result.data.org) {
          if (!result.data.org.onboardingComplete) {
            setIncompleteOrg({
              id: result.data.org.id,
              name: result.data.org.name,
            })
          } else {
            setIncompleteOrg(null)
          }
        } else {
          setIncompleteOrg(null)
        }
      } catch (error) {
        console.error('[CreateOrganizationStep] Failed to check org:', error)
        setIncompleteOrg(null)
      } finally {
        setIsCheckingOrg(false)
      }
    }, 300)

    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current)
      }
    }
  }, [organizationName])

  // Validate organization name
  const validateName = useCallback((name: string): boolean => {
    if (!name || name.trim().length < 2) {
      setValidationError('Organization name must be at least 2 characters')
      return false
    }
    if (name.trim().length > 100) {
      setValidationError('Organization name must be less than 100 characters')
      return false
    }
    setValidationError(null)
    return true
  }, [])

  // Handle name change with validation
  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      onOrganizationNameChange(value)
      if (value.length > 0) {
        validateName(value)
      } else {
        setValidationError(null)
      }
    },
    [onOrganizationNameChange, validateName]
  )

  // Handle form submission
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault()

      if (!validateName(organizationName)) {
        return
      }

      setIsCreating(true)
      try {
        const orgId = await onCreateOrganization(organizationName.trim())

        if (orgId) {
          onContinue()
        }
      } finally {
        setIsCreating(false)
      }
    },
    [organizationName, validateName, onCreateOrganization, onContinue]
  )

  // Handle keyboard submit
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key === 'Enter' &&
        !isCreating &&
        organizationName.trim().length >= 2
      ) {
        handleSubmit()
      }
    },
    [handleSubmit, isCreating, organizationName]
  )

  // If organization is already created (from session recovery), show a message
  if (organizationCreated && organizationName) {
    return (
      <div
        className={cn(
          'mx-auto flex w-full max-w-sm flex-col items-center',
          'animate-slide-up-fade [--offset:10px] [animation-duration:0.6s] [animation-fill-mode:both]'
        )}
      >
        <h1
          className={cn(
            'text-center text-xl font-semibold',
            isDark ? 'text-white' : 'text-neutral-900'
          )}
        >
          Organization Ready
        </h1>
        <p
          className={cn(
            'mt-2 text-balance text-center text-base',
            isDark ? 'text-slate-400' : 'text-neutral-500'
          )}
        >
          Your organization <strong>{organizationName}</strong> is already set
          up
        </p>
        <div className='mt-8 w-full'>
          <button
            type='button'
            onClick={onContinue}
            className={cn(
              'h-10 w-full rounded-lg',
              'flex items-center justify-center gap-2',
              'text-sm font-medium',
              'transition-all duration-200',
              'group',
              isDark
                ? 'bg-emerald-500 text-white hover:bg-emerald-400'
                : 'bg-neutral-900 text-white hover:bg-neutral-800'
            )}
          >
            Continue
            <ArrowRight className='h-4 w-4 transition-transform group-hover:translate-x-1' />
          </button>
        </div>
      </div>
    )
  }

  // If we found an existing org with incomplete onboarding
  if (incompleteOrg && onContinueIncomplete) {
    return (
      <div
        className={cn(
          'mx-auto flex w-full max-w-sm flex-col items-center',
          'animate-slide-up-fade [--offset:10px] [animation-duration:0.6s] [animation-fill-mode:both]'
        )}
      >
        <h1
          className={cn(
            'text-center text-xl font-semibold',
            isDark ? 'text-white' : 'text-neutral-900'
          )}
        >
          Organization Ready
        </h1>
        <p
          className={cn(
            'mt-2 text-balance text-center text-base',
            isDark ? 'text-slate-400' : 'text-neutral-500'
          )}
        >
          Your organization <strong>{incompleteOrg.name}</strong> is already set
          up
        </p>
        <p
          className={cn(
            'mt-1 text-balance text-center text-sm',
            isDark ? 'text-slate-500' : 'text-neutral-400'
          )}
        >
          Let&apos;s continue where you left off
        </p>
        <div className='mt-8 w-full space-y-3'>
          <button
            type='button'
            onClick={() =>
              onContinueIncomplete(incompleteOrg.id, incompleteOrg.name)
            }
            className={cn(
              'h-10 w-full rounded-lg',
              'flex items-center justify-center gap-2',
              'text-sm font-medium',
              'transition-all duration-200',
              'group',
              isDark
                ? 'bg-emerald-500 text-white hover:bg-emerald-400'
                : 'bg-neutral-900 text-white hover:bg-neutral-800'
            )}
          >
            Continue Setup
            <ArrowRight className='h-4 w-4 transition-transform group-hover:translate-x-1' />
          </button>
          <button
            type='button'
            onClick={() => {
              setIncompleteOrg(null)
              onOrganizationNameChange('')
            }}
            className={cn(
              'h-10 w-full rounded-lg',
              'flex items-center justify-center gap-2',
              'text-sm font-medium',
              'transition-all duration-200',
              isDark
                ? 'text-slate-400 hover:text-slate-300'
                : 'text-neutral-500 hover:text-neutral-700'
            )}
          >
            Create New Organization Instead
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-sm flex-col items-center',
        'animate-slide-up-fade [--offset:10px] [animation-duration:0.6s] [animation-fill-mode:both]'
      )}
    >
      {/* Title */}
      <h1
        className={cn(
          'text-center text-xl font-semibold',
          isDark ? 'text-white' : 'text-neutral-900'
        )}
      >
        Create your organization
      </h1>

      {/* Description */}
      <p
        className={cn(
          'mt-2 text-balance text-center text-base',
          isDark ? 'text-slate-400' : 'text-neutral-500'
        )}
      >
        This is your workspace for managing everything in MarginFront
      </p>

      {/* Form */}
      <form onSubmit={handleSubmit} className='mt-8 w-full space-y-4'>
        {/* Organization Name */}
        <div className='space-y-2'>
          <label
            htmlFor='org-name'
            className={cn(
              'flex items-center gap-1.5 text-sm font-medium',
              isDark ? 'text-slate-300' : 'text-neutral-700'
            )}
          >
            <Building2 className='h-4 w-4' />
            Organization name
          </label>
          <div className='relative'>
            <input
              id='org-name'
              type='text'
              value={organizationName}
              onChange={handleNameChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder='Acme Inc.'
              disabled={isCreating || isLoading}
              autoFocus
              autoComplete='organization'
              className={cn(
                'h-10 w-full rounded-lg px-3',
                'text-sm',
                'transition-all duration-200',
                'outline-none',
                isDark
                  ? 'border border-slate-700 bg-slate-900 text-white placeholder:text-slate-500'
                  : 'border border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-400',
                isFocused &&
                  (isDark
                    ? 'border-emerald-500 ring-2 ring-emerald-500/50'
                    : 'border-neutral-900 ring-2 ring-neutral-900/10'),
                validationError && 'border-red-500 ring-2 ring-red-500/20',
                (isCreating || isLoading) && 'cursor-not-allowed opacity-50'
              )}
            />
            {/* Character count */}
            <span
              className={cn(
                'absolute right-3 top-1/2 -translate-y-1/2 text-xs',
                isDark ? 'text-slate-500' : 'text-neutral-400'
              )}
            >
              {organizationName.length}/100
            </span>
          </div>
          {validationError && (
            <p className='animate-fade-in text-sm text-red-500'>
              {validationError}
            </p>
          )}
        </div>

        {/* Persona dropdown */}
        <div className='space-y-2'>
          <label
            htmlFor='persona'
            className={cn(
              'flex items-center gap-1.5 text-sm font-medium',
              isDark ? 'text-slate-300' : 'text-neutral-700'
            )}
          >
            <User className='h-4 w-4' />
            What&apos;s your role?
          </label>
          <select
            id='persona'
            value={persona || ''}
            onChange={(e) => onPersonaChange(e.target.value as UserPersona)}
            disabled={isCreating || isLoading}
            className={cn(
              'h-10 w-full rounded-lg px-3',
              'text-sm',
              'transition-all duration-200',
              'appearance-none outline-none',
              isDark
                ? 'border border-slate-700 bg-slate-900 text-white'
                : 'border border-neutral-300 bg-white text-neutral-900',
              !persona && (isDark ? 'text-slate-500' : 'text-neutral-400'),
              (isCreating || isLoading) && 'cursor-not-allowed opacity-50'
            )}
          >
            <option value='' disabled>
              Select your role
            </option>
            {(Object.entries(PERSONA_LABELS) as [UserPersona, string][]).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              )
            )}
          </select>
        </div>

        {/* Error message from API */}
        {error && (
          <div
            className={cn(
              'animate-fade-in rounded-lg p-3 text-sm',
              isDark
                ? 'border border-red-500/20 bg-red-500/10 text-red-400'
                : 'border border-red-200 bg-red-50 text-red-600'
            )}
          >
            {error}
          </div>
        )}

        {/* Actions */}
        <div className='flex items-center justify-center pt-4'>
          <button
            type='submit'
            disabled={
              isCreating ||
              isLoading ||
              !organizationName.trim() ||
              organizationName.trim().length < 2 ||
              isCheckingOrg
            }
            className={cn(
              'h-10 rounded-lg px-6',
              'flex items-center justify-center gap-2',
              'text-sm font-medium',
              'transition-all duration-200',
              'group',
              'disabled:cursor-not-allowed disabled:opacity-50',
              isDark
                ? 'bg-emerald-500 text-white hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400'
                : 'bg-neutral-900 text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400'
            )}
          >
            {isCreating || isLoading ? (
              <>
                <Loader2 className='h-4 w-4 animate-spin' />
                Creating...
              </>
            ) : (
              <>
                Create Organization
                <ArrowRight className='h-4 w-4 transition-transform group-hover:translate-x-1' />
              </>
            )}
          </button>
        </div>
      </form>

      {/* Info text */}
      <p
        className={cn(
          'mt-6 text-center text-xs',
          isDark ? 'text-slate-600' : 'text-neutral-400'
        )}
      >
        You can invite team members after completing setup
      </p>
    </div>
  )
}

export default CreateOrganizationStep
