'use client'

/**
 * WHAT THIS FILE DOES: runs the ROI guided tour, from auto-open to dismissal.
 *
 * WHY THE TAB DANCE: Radix unmounts the panel a reader is not on, so a step
 * anchored on Goals has nothing to point at while Summary is open. The hook
 * switches tabs through the page's own handler, then waits for the anchor.
 *
 * WHY PER BROWSER: the users table has no preferences column, so this keeps
 * one versioned key through lib/storage.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { storage } from '@/lib/storage'
import { subscribeToRoiTour } from './tour-events'
import {
  TOUR_PLANS,
  TOUR_STORAGE_KEY,
  TOUR_VERSION,
  isPointableTarget,
  isTourDismissed,
  readTourState,
  resumeStep,
  runWritesDismissal,
  runWritesResumeStep,
  tourAutoOpensOnLanding,
  tourStepKey,
  tourTabSwitch,
  tourTargetSelector,
  writeTourState,
  type TourCloseReason,
  type TourPlan,
  type TourPlanId,
  type TourState,
  type TourStep,
  type TourTab,
  type TourStartSource,
} from './tour-steps'

export type { TourStartSource, TourCloseReason }

export interface RoiTourController {
  plan: TourPlan | null
  step: TourStep | null
  index: number
  isOpen: boolean
  /** The goal the customer created during the tour, so step five lands on it. */
  pinnedGoalId: string | null
  start: (planId: TourPlanId | null, source: TourStartSource) => void
  next: () => void
  back: () => void
  close: (reason: TourCloseReason) => void
}

interface TourSession {
  planId: TourPlanId
  index: number
  /** Which door opened this run, because the two write different things. */
  startedBy: TourStartSource
}

function save(state: TourState): void {
  storage.setItem(TOUR_STORAGE_KEY, writeTourState(state))
}

/** How often the auto-open looks again while a modal holds the screen. */
const MODAL_POLL_MS = 120

const MODAL_ROLES = new Set(['dialog', 'alertdialog'])

/**
 * WHY THE AUTO-OPEN WAITS: DashboardClientLayout's setup-method modal opens on
 * every dashboard load, and its focus trap pulls the opening card's focus
 * straight back, then leaves it on the body when the modal unmounts. The tour's
 * own card has no data-state, so it never counts itself.
 */
function aModalOwnsTheScreen(): boolean {
  for (const element of document.querySelectorAll('[data-state]')) {
    const role = element.getAttribute('role')
    if (
      role !== null &&
      MODAL_ROLES.has(role) &&
      element.getAttribute('data-state') === 'open'
    ) {
      return true
    }
  }
  return false
}

export function useRoiTour({
  activeTab,
  onTabChange,
  ready,
  suppressed,
  autoPlan,
}: {
  activeTab: TourTab
  onTabChange: (tab: TourTab) => void
  /** The page's reads have landed, so a step points at a settled screen. */
  ready: boolean
  /** Another guidance surface owns the screen right now (the goal dialog). */
  suppressed: boolean
  autoPlan: TourPlan
}): RoiTourController {
  const [session, setSession] = useState<TourSession | null>(null)
  // Kept for the life of the page: the tour's own switch writes activeTab, so
  // reading it later asks the tour where the customer landed.
  const [landingTab] = useState(activeTab)
  const [pinnedGoalId, setPinnedGoalId] = useState<string | null>(null)
  const settled = useRef(false)
  const lastViewed = useRef<string | null>(null)
  const switchedTabFor = useRef<string | null>(null)

  const open = useCallback(
    (plan: TourPlan, at: number, source: TourStartSource) => {
      settled.current = true
      setPinnedGoalId(null)
      setSession({ planId: plan.id, index: at, startedBy: source })
    },
    []
  )

  // Read in an effect, never during a render: the server has no browser
  // storage, so a render that read it gives React two first paints to
  // reconcile (same reason as the how-this-page-works panel in index.tsx).
  useEffect(() => {
    if (settled.current || !ready || suppressed) return
    const stored = readTourState(storage.getItem(TOUR_STORAGE_KEY))
    if (isTourDismissed(stored, autoPlan.id)) {
      settled.current = true
      return
    }
    // Before the landing rule, never after: the resume step is half of it.
    const at = Math.max(
      0,
      Math.min(resumeStep(stored, autoPlan.id), autoPlan.steps.length - 1)
    )
    // Settled, not merely skipped: a customer who deep-linked to another tab
    // and then clicks Summary has not asked for the tour either.
    if (!tourAutoOpensOnLanding({ plan: autoPlan, landingTab, at })) {
      settled.current = true
      return
    }
    let timer = 0
    let frame = 0
    const openWhenTheScreenIsFree = () => {
      // The launcher button can settle this from under the loop.
      if (settled.current) return
      if (aModalOwnsTheScreen()) {
        timer = window.setTimeout(openWhenTheScreenIsFree, MODAL_POLL_MS)
        return
      }
      // After the next paint, not during this effect: the first card measures
      // a control the browser has to have laid out already.
      frame = requestAnimationFrame(() => {
        if (!settled.current) open(autoPlan, at, 'auto')
      })
    }
    openWhenTheScreenIsFree()
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(frame)
    }
  }, [ready, suppressed, autoPlan, landingTab, open])

  // Deduped on plan-and-index: an effect re-runs on any re-render.
  useEffect(() => {
    if (!session) {
      lastViewed.current = null
      return
    }
    const plan = TOUR_PLANS[session.planId]
    const step = plan.steps[session.index]
    if (!step) return
    const seen = tourStepKey(plan.id, session.index)
    if (lastViewed.current === seen) return
    lastViewed.current = seen
    if (
      runWritesResumeStep({
        planIsAuto: plan.auto,
        startedBy: session.startedBy,
      })
    ) {
      save({
        version: TOUR_VERSION,
        dismissed: false,
        plan: plan.id,
        step: session.index,
      })
    }
  }, [session])

  // Radix unmounts an inactive panel, so the tab has to change before the
  // anchor can exist. One move per step and no more: re-running this on every
  // tab change would undo the customer's own click, and the only escape from
  // that would be closing the tour, which is permanent.
  useEffect(() => {
    if (!session) {
      switchedTabFor.current = null
      return
    }
    const step = TOUR_PLANS[session.planId].steps[session.index]
    if (!step) return
    const decision = tourTabSwitch({
      stepKey: tourStepKey(session.planId, session.index),
      stepTab: step.tab,
      activeTab,
      switchedFor: switchedTabFor.current,
    })
    switchedTabFor.current = decision.switchedFor
    if (decision.switchTo) onTabChange(decision.switchTo)
  }, [session, activeTab, onTabChange])

  const close = useCallback(
    (reason: TourCloseReason) => {
      if (!session) return
      const plan = TOUR_PLANS[session.planId]
      // Any first close of a tour that opened by itself is the dismissal,
      // whichever door the customer used.
      if (
        runWritesDismissal({
          planIsAuto: plan.auto,
          startedBy: session.startedBy,
          reason,
        })
      ) {
        save({
          version: TOUR_VERSION,
          dismissed: true,
          plan: plan.id,
          step: session.index,
        })
      }
      // Here rather than in the card, so the finish that the print signal
      // drives returns focus like every button does.
      document
        .querySelector<HTMLElement>("[data-tour='show-me-around']")
        ?.focus()
      setSession(null)
      setPinnedGoalId(null)
    },
    [session]
  )

  const next = useCallback(() => {
    setSession((current) => {
      if (!current) return current
      const plan = TOUR_PLANS[current.planId]
      if (current.index >= plan.steps.length - 1) return current
      return { ...current, index: current.index + 1 }
    })
  }, [])

  const back = useCallback(() => {
    setSession((current) =>
      current && current.index > 0
        ? { ...current, index: current.index - 1 }
        : current
    )
  }, [])

  const start = useCallback(
    (planId: TourPlanId | null, source: TourStartSource) => {
      open(planId === null ? autoPlan : TOUR_PLANS[planId], 0, source)
    },
    [autoPlan, open]
  )

  useEffect(() => {
    if (!session) return
    return subscribeToRoiTour((signal) => {
      const plan = TOUR_PLANS[session.planId]
      const step = plan.steps[session.index]
      if (!step || step.advanceOn !== signal.kind) return
      if (signal.kind === 'goal-created') setPinnedGoalId(signal.initiativeId)
      if (session.index >= plan.steps.length - 1) {
        close('done')
        return
      }
      setSession({
        planId: session.planId,
        index: session.index + 1,
        startedBy: session.startedBy,
      })
    })
  }, [session, close])

  const plan = session ? TOUR_PLANS[session.planId] : null
  const step = plan && session ? (plan.steps[session.index] ?? null) : null

  return {
    plan,
    step,
    index: session?.index ?? 0,
    isOpen: session !== null && step !== null,
    pinnedGoalId,
    start,
    next,
    back,
    close,
  }
}

const TARGET_POLL_MS = 60
const TARGET_WAIT_MS = 1500

export interface TourTargetSearch {
  /** The element the card points at, or null while there is nothing to point at. */
  element: HTMLElement | null
  /**
   * False until the search has had its say. The card shows the step's action
   * line until then, so a control that is merely slow never flashes the
   * "it is not here" fallback at a customer who is about to see it.
   */
  searched: boolean
}

function pointable(element: HTMLElement | null): element is HTMLElement {
  if (!element) return false
  const box = element.getBoundingClientRect()
  return isPointableTarget({
    connected: element.isConnected,
    rect: {
      top: box.top,
      left: box.left,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    },
  })
}

/**
 * The element a step points at, watched for as long as the step is open.
 *
 * WHY IT NEVER STOPS LOOKING: a target can arrive late and it can leave. The
 * goal card cannot exist until the overview refetch that follows the create
 * lands, and a lookup that gives up after a fixed delay would leave the tour
 * telling a customer to create the goal they created a second ago. The
 * Estimate without AI button goes the other way: it unmounts behind the form
 * it opens, so a search that stopped at the first hit would hand back the
 * dead node.
 */
export function useTourTarget(
  step: TourStep | null,
  pinnedGoalId: string | null
): TourTargetSearch {
  const [found, setFound] = useState<{
    stepId: string
    element: HTMLElement | null
    searched: boolean
  } | null>(null)

  useEffect(() => {
    if (!step) return
    let cancelled = false
    let timer = 0
    const startedAt = Date.now()
    let pinned: HTMLElement | null = null
    let published: HTMLElement | null | undefined
    let publishedSearched: boolean | undefined

    // Named once, asked again on every tick: the step after the create takes
    // its own card and nothing else, however long the refetch runs.
    const selector = tourTargetSelector({ anchor: step.anchor, pinnedGoalId })

    const find = (): HTMLElement | null => {
      const target = document.querySelector<HTMLElement>(selector)
      return pointable(target) ? target : null
    }

    const publish = (element: HTMLElement | null, searched: boolean) => {
      if (element === published && searched === publishedSearched) return
      published = element
      publishedSearched = searched
      setFound({ stepId: step.id, element, searched })
    }

    const look = () => {
      if (cancelled) return
      if (!pointable(pinned)) {
        pinned = find()
        publish(
          pinned,
          pinned !== null || Date.now() - startedAt > TARGET_WAIT_MS
        )
      }
      timer = window.setTimeout(look, TARGET_POLL_MS)
    }

    timer = window.setTimeout(look, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [step, pinnedGoalId])

  if (!step || found?.stepId !== step.id) {
    return { element: null, searched: false }
  }
  return { element: found.element, searched: found.searched }
}
