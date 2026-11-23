import { ArrowLeft, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface StepFooterProps {
  onBack?: () => void
  backLabel?: string
  showBack?: boolean
  children?: React.ReactNode
  className?: string
}

export const StepFooter = ({
  onBack,
  backLabel = 'Back',
  showBack = true,
  children,
  className,
}: StepFooterProps) => {
  return (
    <div
      className={cn(
        'flex flex-shrink-0 items-center justify-between',
        'mt-auto pt-5',
        'border-t border-border/60',
        className
      )}
    >
      {/* Left side - Back button */}
      <div className='flex items-center'>
        {showBack && onBack ? (
          <Button
            variant='ghost'
            onClick={onBack}
            className='gap-2 text-muted-foreground hover:text-foreground'
          >
            <ArrowLeft className='h-4 w-4' />
            {backLabel}
          </Button>
        ) : (
          <div /> // Spacer for alignment
        )}
      </div>

      {/* Right side - Action buttons */}
      <div className='flex items-center gap-3'>{children}</div>
    </div>
  )
}

// Primary action button with consistent styling
interface PrimaryActionProps {
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  loading?: boolean
  icon?: React.ReactNode
}

export const PrimaryAction = ({
  onClick,
  children,
  disabled = false,
  loading = false,
  icon,
}: PrimaryActionProps) => {
  return (
    <Button
      onClick={onClick}
      disabled={disabled || loading}
      className='h-10 gap-2 px-5 font-medium shadow-sm'
    >
      {children}
      {icon || <ArrowRight className='h-4 w-4' />}
    </Button>
  )
}

// Secondary action button
interface SecondaryActionProps {
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  icon?: React.ReactNode
}

export const SecondaryAction = ({
  onClick,
  children,
  disabled = false,
  icon,
}: SecondaryActionProps) => {
  return (
    <Button
      variant='outline'
      onClick={onClick}
      disabled={disabled}
      className='h-10 gap-2'
    >
      {icon}
      {children}
    </Button>
  )
}

// Ghost/Skip action
interface GhostActionProps {
  onClick: () => void
  children: React.ReactNode
}

export const GhostAction = ({ onClick, children }: GhostActionProps) => {
  return (
    <Button
      variant='ghost'
      onClick={onClick}
      className='text-muted-foreground hover:text-foreground'
    >
      {children}
    </Button>
  )
}
