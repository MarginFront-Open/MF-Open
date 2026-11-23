import * as React from 'react'
import type { ToastActionElement, ToastProps } from '@/components/ui/toast'

const TOAST_LIMIT = 3
const TOAST_REMOVE_DELAY = 200 // Fast remove after dismiss

// Auto-dismiss durations based on variant
const TOAST_DURATIONS = {
  success: 3000,
  error: 6000,
  destructive: 6000,
  warning: 4000,
  info: 4000,
  loading: 30000, // Long duration for loading, dismiss manually
  default: 5000,
} as const

export type ToastVariant =
  | 'default'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'info'
  | 'loading'

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
  variant?: ToastVariant
}

const _actionTypes = {
  ADD_TOAST: 'ADD_TOAST',
  UPDATE_TOAST: 'UPDATE_TOAST',
  DISMISS_TOAST: 'DISMISS_TOAST',
  REMOVE_TOAST: 'REMOVE_TOAST',
} as const

let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

type ActionType = typeof _actionTypes

type Action =
  | {
      type: ActionType['ADD_TOAST']
      toast: ToasterToast
    }
  | {
      type: ActionType['UPDATE_TOAST']
      toast: Partial<ToasterToast>
    }
  | {
      type: ActionType['DISMISS_TOAST']
      toastId?: ToasterToast['id']
    }
  | {
      type: ActionType['REMOVE_TOAST']
      toastId?: ToasterToast['id']
    }

interface State {
  toasts: ToasterToast[]
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId)
    dispatch({
      type: 'REMOVE_TOAST',
      toastId: toastId,
    })
  }, TOAST_REMOVE_DELAY)

  toastTimeouts.set(toastId, timeout)
}

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD_TOAST':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      }

    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      }

    case 'DISMISS_TOAST': {
      const { toastId } = action

      // Side effect inside the reducer: dismissing also queues the toast
      // for removal.
      if (toastId) {
        addToRemoveQueue(toastId)
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id)
        })
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      }
    }
    case 'REMOVE_TOAST':
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        }
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      }
  }
}

const listeners: Array<(state: State) => void> = []

let memoryState: State = { toasts: [] }

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach((listener) => {
    listener(memoryState)
  })
}

type Toast = Omit<ToasterToast, 'id'> & {
  duration?: number | null // null = no auto-dismiss
}

type ToastInput = string | { title: string; description?: string }

function createToast({ duration, ...props }: Toast) {
  const id = genId()

  const update = (props: ToasterToast) =>
    dispatch({
      type: 'UPDATE_TOAST',
      toast: { ...props, id },
    })
  const dismiss = () => dispatch({ type: 'DISMISS_TOAST', toastId: id })

  dispatch({
    type: 'ADD_TOAST',
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss()
      },
    },
  })

  // Auto-dismiss based on variant or custom duration
  if (duration !== null) {
    const variantKey = props.variant || 'default'
    const autoDismissDuration =
      duration ??
      TOAST_DURATIONS[variantKey as keyof typeof TOAST_DURATIONS] ??
      TOAST_DURATIONS.default
    setTimeout(() => {
      dismiss()
    }, autoDismissDuration)
  }

  return {
    id,
    dismiss,
    update,
  }
}

// Helper to normalize input
function normalizeInput(input: ToastInput): {
  title: string
  description?: string
} {
  if (typeof input === 'string') {
    return { title: input }
  }
  return input
}

// Main toast function with helper methods
function toast(props: Toast) {
  return createToast(props)
}

// Helper methods for common toast types
toast.success = (
  input: ToastInput,
  options?: Omit<Toast, 'variant' | 'title' | 'description'>
) => {
  const { title, description } = normalizeInput(input)
  return createToast({ ...options, title, description, variant: 'success' })
}

toast.error = (
  input: ToastInput,
  options?: Omit<Toast, 'variant' | 'title' | 'description'>
) => {
  const { title, description } = normalizeInput(input)
  return createToast({ ...options, title, description, variant: 'destructive' })
}

toast.warning = (
  input: ToastInput,
  options?: Omit<Toast, 'variant' | 'title' | 'description'>
) => {
  const { title, description } = normalizeInput(input)
  return createToast({ ...options, title, description, variant: 'warning' })
}

toast.info = (
  input: ToastInput,
  options?: Omit<Toast, 'variant' | 'title' | 'description'>
) => {
  const { title, description } = normalizeInput(input)
  return createToast({ ...options, title, description, variant: 'info' })
}

toast.loading = (
  input: ToastInput,
  options?: Omit<Toast, 'variant' | 'title' | 'description'>
) => {
  const { title, description } = normalizeInput(input)
  return createToast({ ...options, title, description, variant: 'loading' })
}

// Dismiss a specific toast or all toasts
toast.dismiss = (toastId?: string) => {
  dispatch({ type: 'DISMISS_TOAST', toastId })
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState)

  React.useEffect(() => {
    listeners.push(setState)
    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }, [state])

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: 'DISMISS_TOAST', toastId }),
  }
}

export { useToast, toast }
