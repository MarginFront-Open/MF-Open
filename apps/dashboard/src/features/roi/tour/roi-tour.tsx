'use client'

/**
 * WHAT THIS FILE DOES: draws one tour step, as a dim layer with a hole around
 * the control and a card beside it.
 *
 * WHY A DIALOG AND NOT A TOOLTIP: the card holds buttons, and a tooltip never
 * takes focus, so Next would be unreachable from a keyboard. Non-modal: the
 * layer is pointer-events-none, because the customer has to do the thing.
 *
 * WHY UNDER z-50: ui/dialog and ui/dropdown-menu portal at z-50, ui/tooltip at
 * z-60, and a step that asks for the goal dialog has to leave it usable.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  TOUR_BUTTONS,
  TOUR_CLOSE_LABEL,
  TOUR_FOOTER_LINE,
  placeCard,
  tourProgressLine,
  type TourCardPlacement,
  type TourPlan,
  type TourRect,
  type TourStep,
} from './tour-steps'
import {
  useTourTarget,
  type RoiTourController,
  type TourCloseReason,
} from './use-roi-tour'

const CARD_WIDTH = 340
const VIEWPORT_MARGIN = 16

/**
 * Where the card sits for the one frame before it has been measured. Off the
 * side of the screen rather than `visibility: hidden`, because a hidden
 * subtree takes no focus and announces nothing, and that one frame is exactly
 * when the opening card has to do both.
 */
const OFF_SCREEN_LEFT = -10000

/** Not an mf token with an alpha: those are bare `var(--mf-x)` strings, which
 * Tailwind cannot read as a color, so it emits nothing for an alpha-modified
 * mf token like `bg-mf-bg/60` and the spotlight would be invisible. */
const LAYER_PANEL = 'absolute bg-black/30'

/** Drawn outside the hole, so it frames the control without covering it. */
const HIGHLIGHT_RING = 'absolute rounded-mf-inner ring-2 ring-mf-accent'

const TOP_LAYER_ROLES = new Set(['dialog', 'alertdialog', 'menu'])

/**
 * True when a Radix dialog, alert dialog, menu or tooltip is stacked on top of
 * the tour. The tour's own card is a dialog too, but a hand-rolled one with no
 * data-state attribute, so it never counts itself.
 */
function anotherLayerOwnsEscape(): boolean {
  if (document.querySelector('[data-radix-popper-content-wrapper]')) return true
  for (const element of document.querySelectorAll('[data-state]')) {
    const role = element.getAttribute('role')
    if (
      role !== null &&
      TOP_LAYER_ROLES.has(role) &&
      element.getAttribute('data-state') === 'open'
    ) {
      return true
    }
  }
  return false
}

const SMALL_BUTTON =
  'inline-flex h-7 items-center rounded-mf-seg-item border border-mf-bd bg-mf-card2 px-2.5 text-[11.5px] font-medium text-mf-tx2 hover:text-mf-tx'
const PRIMARY_BUTTON =
  'inline-flex h-7 items-center rounded-mf-seg-item bg-mf-accent2 px-2.5 text-[11.5px] font-semibold text-mf-accent'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduced(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])
  return reduced
}

export function RoiTour({ controller }: { controller: RoiTourController }) {
  if (!controller.isOpen || !controller.plan || !controller.step) return null
  return (
    <TourCard
      plan={controller.plan}
      step={controller.step}
      index={controller.index}
      pinnedGoalId={controller.pinnedGoalId}
      onNext={controller.next}
      onBack={controller.back}
      onClose={controller.close}
    />
  )
}

function TourCard({
  plan,
  step,
  index,
  pinnedGoalId,
  onNext,
  onBack,
  onClose,
}: {
  plan: TourPlan
  step: TourStep
  index: number
  pinnedGoalId: string | null
  onNext: () => void
  onBack: () => void
  onClose: (reason: TourCloseReason) => void
}) {
  const { element: target, searched } = useTourTarget(step, pinnedGoalId)
  const cardRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusedFor = useRef<string | null>(null)
  const [placement, setPlacement] = useState<TourCardPlacement | null>(null)
  const [canGlide, setCanGlide] = useState(false)
  const [targetRect, setTargetRect] = useState<TourRect | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const titleId = useId()
  const bodyId = useId()

  const total = plan.steps.length
  const isLast = index === total - 1
  const progress = tourProgressLine(index, total)

  // WHY A RENDER LATER: a transition starts on the style a property lands in,
  // however new that style is, so turning the glide on in the same commit as
  // the first placement animates the card in from its off-screen parking spot.
  useEffect(() => {
    if (!placement || canGlide) return
    const frame = requestAnimationFrame(() => setCanGlide(true))
    return () => cancelAnimationFrame(frame)
  }, [placement, canGlide])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // A step can ask the customer to open the goal dialog or the card's
      // menu, and Radix dismisses those on this same native event without
      // stopping it. Closing here too would end the tour for good on the
      // Escape that only meant "back out of this form".
      if (event.defaultPrevented) return
      if (anotherLayerOwnsEscape()) return
      onClose('escape')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Not on step.id alone: the opening card renders parked off screen for the
  // frame before it is measured. Claimed only on a focus that landed, and
  // re-asserted only from the body, because a modal focus trap pulls this
  // focus back and drops it on the body when it unmounts.
  useEffect(() => {
    if (!placement) return
    const heading = headingRef.current
    if (!heading) return
    if (
      focusedFor.current === step.id &&
      document.activeElement !== document.body
    ) {
      return
    }
    heading.focus()
    if (document.activeElement === heading) focusedFor.current = step.id
  }, [step.id, placement])

  useEffect(() => {
    if (!target) return
    // ONE SCROLL, NEVER TWO: scrollIntoView is asynchronous under smooth
    // behavior, so a correction measured from the rect on the next line is
    // measured from where the control sat before the scroll, and the two scrolls compose
    // into a resting place that shows neither. The sticky-header allowance is
    // instead a scroll-margin-top on [data-tour] in src/index.css, which the
    // browser applies inside the one scroll it performs (WCAG 2.4.11).
    target.scrollIntoView({
      block: 'start',
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
  }, [target, reducedMotion])

  const measure = useCallback(() => {
    const card = cardRef.current
    if (!card) return
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const size = {
      width: Math.min(CARD_WIDTH, viewport.width - VIEWPORT_MARGIN * 2),
      height: card.offsetHeight,
    }
    if (!target || !target.isConnected) {
      setTargetRect(null)
      setPlacement({
        top: Math.max(
          VIEWPORT_MARGIN,
          Math.round((viewport.height - size.height) / 2)
        ),
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.round((viewport.width - size.width) / 2)
        ),
        width: size.width,
        docked: false,
      })
      return
    }
    const box = target.getBoundingClientRect()
    const rect: TourRect = {
      top: box.top,
      left: box.left,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    }
    setTargetRect(rect)
    setPlacement(placeCard(rect, size, viewport))
  }, [target])

  useEffect(() => {
    // After the paint: the card's own height is one of the inputs, and it is
    // zero until the browser has laid this render out.
    const frame = requestAnimationFrame(measure)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [measure, step.id])

  return (
    <>
      <div
        aria-hidden='true'
        className='no-print pointer-events-none fixed inset-0 z-[40]'
      >
        {targetRect ? (
          <>
            <div
              className={LAYER_PANEL}
              style={{
                top: 0,
                left: 0,
                right: 0,
                height: Math.max(0, targetRect.top),
              }}
            />
            <div
              className={LAYER_PANEL}
              style={{
                top: Math.max(0, targetRect.bottom),
                left: 0,
                right: 0,
                bottom: 0,
              }}
            />
            <div
              className={LAYER_PANEL}
              style={{
                top: Math.max(0, targetRect.top),
                left: 0,
                width: Math.max(0, targetRect.left),
                height: Math.max(0, targetRect.height),
              }}
            />
            <div
              className={LAYER_PANEL}
              style={{
                top: Math.max(0, targetRect.top),
                left: Math.max(0, targetRect.right),
                right: 0,
                height: Math.max(0, targetRect.height),
              }}
            />
            <div
              className={HIGHLIGHT_RING}
              style={{
                top: targetRect.top,
                left: targetRect.left,
                width: targetRect.width,
                height: targetRect.height,
              }}
            />
          </>
        ) : (
          <div className={LAYER_PANEL} style={{ inset: 0 }} />
        )}
      </div>

      <div
        ref={cardRef}
        role='dialog'
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={`no-print fixed z-[45] flex flex-col gap-2 rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-[14px] shadow-lg ${
          canGlide && !reducedMotion ? 'transition-[top,left] duration-200' : ''
        }`}
        style={{
          top: placement?.top ?? VIEWPORT_MARGIN,
          left: placement?.left ?? OFF_SCREEN_LEFT,
          width: placement?.width ?? CARD_WIDTH,
        }}
      >
        <span className='sr-only' aria-live='polite'>
          {`${progress}: ${step.title}`}
        </span>

        <div className='flex items-start justify-between gap-2'>
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className='text-[13px] font-semibold tracking-[-.01em] text-mf-tx outline-none'
          >
            {step.title}
          </h2>
          <button
            type='button'
            onClick={() => onClose('close')}
            aria-label={TOUR_CLOSE_LABEL}
            className='shrink-0 text-mf-tx3 hover:text-mf-tx'
          >
            <X className='h-4 w-4' />
          </button>
        </div>

        <p id={bodyId} className='text-[12px] text-mf-tx2'>
          {step.body}
        </p>

        <p className='text-[11.5px] text-mf-tx3'>
          {target || !searched ? step.action : step.missingTargetText}
        </p>

        {isLast && (
          <p className='text-[11px] text-mf-tx3'>{TOUR_FOOTER_LINE}</p>
        )}

        <div className='flex items-center gap-2 border-t border-mf-bd2 pt-2.5'>
          <span className='text-[11px] tabular-nums text-mf-tx3'>
            {progress}
          </span>
          <div className='ml-auto flex items-center gap-2'>
            <button
              type='button'
              onClick={() => onClose('skip')}
              className={SMALL_BUTTON}
            >
              {TOUR_BUTTONS.skip}
            </button>
            {index > 0 && (
              <button type='button' onClick={onBack} className={SMALL_BUTTON}>
                {TOUR_BUTTONS.back}
              </button>
            )}
            <button
              type='button'
              onClick={isLast ? () => onClose('done') : onNext}
              className={PRIMARY_BUTTON}
            >
              {isLast ? TOUR_BUTTONS.done : TOUR_BUTTONS.next}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
