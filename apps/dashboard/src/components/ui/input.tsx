import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const inputVariants = cva(
  'flex w-full rounded-md border bg-background text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground transition-micro focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
  {
    variants: {
      variant: {
        default: 'border-input hover:border-border/80',
        error:
          'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20',
      },
      inputSize: {
        default: 'h-10 px-3 py-2',
        sm: 'h-9 px-2.5 py-1.5 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      inputSize: 'default',
    },
  }
)

export interface InputProps
  extends
    Omit<React.ComponentProps<'input'>, 'size'>,
    VariantProps<typeof inputVariants> {
  error?: boolean
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant, inputSize, error, ...props }, ref) => {
    const inputRef = React.useRef<HTMLInputElement>(null)

    // Combine refs
    React.useImperativeHandle(ref, () => inputRef.current!)

    // Prevent mouse wheel from changing number input values
    React.useEffect(() => {
      const input = inputRef.current
      if (!input || type !== 'number') return

      const handleWheel = (e: WheelEvent) => {
        // Prevent wheel event only when input is focused
        if (document.activeElement === input) {
          e.preventDefault()
        }
      }

      // Prevent scroll on focus (when user clicks on the input)
      const handleFocus = () => {
        input.addEventListener('wheel', handleWheel, { passive: false })
      }

      const handleBlur = () => {
        input.removeEventListener('wheel', handleWheel)
      }

      input.addEventListener('focus', handleFocus)
      input.addEventListener('blur', handleBlur)

      return () => {
        input.removeEventListener('focus', handleFocus)
        input.removeEventListener('blur', handleBlur)
        input.removeEventListener('wheel', handleWheel)
      }
    }, [type])

    return (
      <input
        type={type}
        className={cn(
          inputVariants({ variant: error ? 'error' : variant, inputSize }),
          error && 'animate-shake',
          className
        )}
        ref={inputRef}
        aria-invalid={error}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input, inputVariants }
