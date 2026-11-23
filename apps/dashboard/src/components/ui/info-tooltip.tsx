import { Info } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// A small "?" icon that shows a definition on hover (desktop) or tap (mobile).
// Used across all pages so every term in the UI has a plain-English explanation.

/**
 * A touch screen has no hover, and Radix closes its tooltip on the pointerdown
 * of a tap and suppresses the focus that follows, so out of the box a tap shows
 * nothing. The tap's own click drives `open` instead, and the close Radix fires
 * during that same tap is dropped. Nothing here cancels a default event:
 * TooltipWrap wraps links whose own click still has to run.
 */
function useHoverOrTap() {
  const [open, setOpen] = useState(false)
  const openBeforeTap = useRef<boolean | null>(null)
  const dropNextClose = useRef(false)

  return {
    open,
    onOpenChange: (next: boolean) => {
      if (!next && dropNextClose.current) {
        dropNextClose.current = false
        return
      }
      setOpen(next)
    },
    triggerProps: {
      onPointerDown: () => {
        openBeforeTap.current = open
      },
      onClick: () => {
        const wasOpen = openBeforeTap.current ?? open
        openBeforeTap.current = null
        dropNextClose.current = !wasOpen
        setOpen(!wasOpen)
      },
    },
  }
}

interface InfoTooltipProps {
  // Bold heading shown at the top of the tooltip
  title: string
  // Main explanation — keep this to 1-2 sentences
  description: string
  // Optional secondary text (dimmer color) for extra context like formulas or examples
  details?: string
  // Override the default icon size (default: 3.5 = 14px)
  iconSize?: string
}

export function InfoTooltip({
  title,
  description,
  details,
  iconSize = 'h-3.5 w-3.5',
}: InfoTooltipProps) {
  const { open, onOpenChange, triggerProps } = useHoverOrTap()

  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild>
          {/* A native button, not the bare icon: an SVG never joins the tab
              order, so keyboard readers could not open this at all. */}
          <button
            type='button'
            aria-label={`What ${title} means`}
            className='inline-flex cursor-help items-center rounded-sm text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
            {...triggerProps}
          >
            <Info className={iconSize} aria-hidden='true' />
          </button>
        </TooltipTrigger>
        <TooltipContent className='max-w-xs'>
          <p className='font-medium'>{title}</p>
          <p className='mt-1 text-xs'>{description}</p>
          {details && (
            <p className='mt-2 text-xs text-muted-foreground'>{details}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// TooltipWrap — same tooltip shape as InfoTooltip but without a visible
// ⓘ icon. Wrap an existing element (label, badge, value) and the tooltip
// appears on hover. Use this when layout is too tight for an inline icon.
interface TooltipWrapProps {
  title: string
  description: string
  details?: string
  children: ReactNode
}

export function TooltipWrap({
  title,
  description,
  details,
  children,
}: TooltipWrapProps) {
  const { open, onOpenChange, triggerProps } = useHoverOrTap()

  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild {...triggerProps}>
          {children}
        </TooltipTrigger>
        <TooltipContent className='max-w-xs'>
          <p className='font-medium'>{title}</p>
          <p className='mt-1 text-xs'>{description}</p>
          {details && (
            <p className='mt-2 text-xs text-muted-foreground'>{details}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
