import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast, type ToastVariant } from '@/hooks/use-toast'
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast'

const toastConfig: Record<
  string,
  { icon: React.ElementType; className: string }
> = {
  success: {
    icon: CheckCircle2,
    className: 'text-green-600 dark:text-green-400',
  },
  destructive: {
    icon: XCircle,
    className: 'text-red-600 dark:text-red-400',
  },
  warning: {
    icon: AlertTriangle,
    className: 'text-amber-600 dark:text-amber-400',
  },
  info: {
    icon: Info,
    className: 'text-blue-600 dark:text-blue-400',
  },
  loading: {
    icon: Loader2,
    className: 'text-primary animate-spin',
  },
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({
        id,
        title,
        description,
        action,
        variant,
        ...props
      }) {
        const config = variant ? toastConfig[variant] : null
        const Icon = config?.icon

        return (
          <Toast key={id} variant={variant} {...props}>
            <div className='flex w-full items-center gap-3'>
              {Icon && (
                <Icon
                  className={cn('h-5 w-5 flex-shrink-0', config?.className)}
                />
              )}
              <div className='min-w-0 flex-1 space-y-0.5'>
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription>{description}</ToastDescription>
                )}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
