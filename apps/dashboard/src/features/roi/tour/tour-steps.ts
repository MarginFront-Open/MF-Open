/**
 * WHAT THIS FILE DOES: every word the ROI guided tour says, who gets which
 * tour, when it stops opening itself, and where a step card sits.
 *
 * WHY IT EXISTS: the copy lives here rather than in JSX so tour-steps.test.ts
 * can hold it to the same gates every other ROI surface passes. Pure on
 * purpose: no React, no browser globals, so the node-only jest run covers it.
 */

import { WORK_ITEM_NOUN } from '@/lib/work-item-noun'
import type { RoiTabId } from '../roi-tabs'

export type TourStartSource = 'auto' | 'button'

export const TOUR_VERSION = '1'
export const TOUR_STORAGE_KEY = 'mf_tour_roi'

export const TITLE_MAX_CHARS = 28
export const BODY_MAX_CHARS = 140

export const TOUR_LAUNCHER_LABEL = 'Show me around'
export const TOUR_LAUNCHER_ACCESSIBLE_NAME = 'Show me around this page'
export const TOUR_FOOTER_LINE =
  'Reopen this any time with Show me around in the page header.'

/** The X in the card's corner, which counts as a dismissal like Skip does. */
export const TOUR_CLOSE_LABEL = 'Close the tour'

export const TOUR_BUTTONS = {
  back: 'Back',
  next: 'Next',
  skip: 'Skip',
  done: 'Done',
} as const

export function tourProgressLine(index: number, total: number): string {
  return `Step ${index + 1} of ${total}`
}

export type TourPlanId =
  | 'first-roi'
  | 'first-numbers'
  | 'read-numbers'
  | 'finished-work'
  | 'get-it-out'

/**
 * The page's own tab type, not a copy of it. A fourth ROI tab has to break the
 * typecheck here rather than let a step name a panel that does not exist.
 */
export type TourTab = RoiTabId

export type TourCloseReason = 'done' | 'skip' | 'escape' | 'close'

/** What moves the tour on: a click of Next, or the real thing landing. */
export type TourAdvance =
  | 'next'
  | 'numbers-saved'
  | 'goal-created'
  | 'print-opened'

export interface TourStep {
  id: string
  plan: TourPlanId
  tab: TourTab
  /** The data-tour value on the element this step points at. */
  anchor: string
  title: string
  body: string
  /** The single thing the customer does here, named by its control. */
  action: string
  advanceOn: TourAdvance
  /** Shown in place of the action line when the control is not on screen. */
  missingTargetText: string
}

export interface TourPlan {
  id: TourPlanId
  label: string
  /** True for the three tours that may open by themselves on landing. */
  auto: boolean
  steps: readonly TourStep[]
}

const DATES_MISSING =
  'Choose a date range with the Month, Last 30 days or Custom control, then press Next.'
const ESTIMATE_MISSING =
  'Check at least one agent in the What you used AI for table, then the Estimate without AI button appears.'
const NET_MISSING =
  'Save your numbers in the Without AI section, with dates that have activity, and this sentence appears.'
const NEW_GOAL_MISSING = 'New goal is the dashed card on the Goals tab.'
const GOAL_CARD_MISSING =
  'Create a goal with New goal on the Goals tab and its card appears here.'
const PRINT_MISSING =
  'Print report is the button beside Get this as data in the page header.'

const DATES_BODY = 'Choose the dates to measure. Last 30 days is a good start.'
const NET_BODY =
  'What AI saved plus what it added, for the agents you checked. Hover an info icon beside any row to see where the number came from.'
const PRINT_BODY =
  'Print report puts every tab in one document. Choose Save as PDF in the print window.'

const FIRST_ROI_STEPS: readonly TourStep[] = [
  {
    id: 'dates',
    plan: 'first-roi',
    tab: 'summary',
    anchor: 'date-range',
    title: 'Pick the dates',
    body: DATES_BODY,
    action: 'Pick a date range, then press Next.',
    advanceOn: 'next',
    missingTargetText: DATES_MISSING,
  },
  {
    id: 'estimate',
    plan: 'first-roi',
    tab: 'summary',
    anchor: 'estimate-without-ai',
    title: 'Say what it cost before',
    body: 'Tell us what this work cost before AI and what it brought in. Pick a method, type your numbers, then Save your numbers.',
    action:
      'Press Estimate without AI or Change your numbers, then Save your numbers.',
    advanceOn: 'numbers-saved',
    missingTargetText: ESTIMATE_MISSING,
  },
  {
    id: 'net',
    plan: 'first-roi',
    tab: 'summary',
    anchor: 'net-line',
    title: 'That sentence is your ROI',
    body: NET_BODY,
    action: 'Read the sentence, then press Next.',
    advanceOn: 'next',
    missingTargetText: NET_MISSING,
  },
  {
    id: 'goal',
    plan: 'first-roi',
    tab: 'goals',
    anchor: 'new-goal',
    title: 'Turn it into a target',
    body: 'Name a goal, pick a metric like cost or revenue, set a target, then Create goal.',
    action: 'Press New goal, fill the dialog, then Create goal.',
    advanceOn: 'goal-created',
    missingTargetText: NEW_GOAL_MISSING,
  },
  {
    id: 'goal-card',
    plan: 'first-roi',
    tab: 'goals',
    anchor: 'goal-card',
    title: 'Change it any time',
    body: 'Your goal tracks itself from here. The three dots on its card edit, archive or show details.',
    action: 'Look at your goal card, then press Next.',
    advanceOn: 'next',
    missingTargetText: GOAL_CARD_MISSING,
  },
  {
    id: 'print',
    plan: 'first-roi',
    tab: 'summary',
    anchor: 'print-report',
    title: 'Take it to the board',
    body: PRINT_BODY,
    action: 'Press Print report, then choose Save as PDF.',
    advanceOn: 'print-opened',
    missingTargetText: PRINT_MISSING,
  },
]

const FIRST_NUMBERS_STEPS: readonly TourStep[] = [
  {
    id: 'no-data',
    plan: 'first-numbers',
    tab: 'summary',
    anchor: 'getting-started-nudge',
    title: 'Nothing measured yet',
    body: 'This page fills itself once one usage event lands. Open Getting Started in the left menu, under Learn, and run the meter on your own work.',
    action:
      'Run the meter install command from Getting Started, AI spend tab, in your terminal.',
    advanceOn: 'next',
    missingTargetText:
      'Open Getting Started in the left menu, under Learn, then run the meter install command from its AI spend tab.',
  },
  {
    id: 'come-back',
    plan: 'first-numbers',
    tab: 'summary',
    anchor: 'show-me-around',
    title: 'Come back when numbers land',
    body: 'Show me around restarts this tour once your first numbers are in.',
    action: 'Press Done. Show me around brings this back.',
    advanceOn: 'next',
    missingTargetText: 'Show me around is the first button in the page header.',
  },
]

const READ_NUMBERS_STEPS: readonly TourStep[] = [
  {
    id: 'agent-table',
    plan: 'read-numbers',
    tab: 'summary',
    anchor: 'agent-table',
    title: 'Each row is one agent',
    body: 'Untick an agent to leave it out of the comparison and Finished work. The date range applies to every row.',
    action: 'Untick an agent you want left out, then press Next.',
    advanceOn: 'next',
    missingTargetText:
      'What you used AI for is the agent table on the Summary tab.',
  },
  {
    id: 'revenue-basis',
    plan: 'read-numbers',
    tab: 'summary',
    anchor: 'revenue-basis',
    title: 'Earned or Total revenue',
    body: 'Earned is usage fees only. Total revenue adds monthly, seat and one-time fees, and the comparison follows your pick.',
    action: 'Pick Earned or Total revenue, then press Next.',
    advanceOn: 'next',
    missingTargetText:
      'Earned and Total revenue sit with the agent table on the Summary tab.',
  },
  {
    id: 'tiles',
    plan: 'read-numbers',
    tab: 'summary',
    anchor: 'metric-tiles',
    title: 'The headline numbers',
    body: 'Cost, revenue and margin for these dates. See an example on any tile shows a worked example.',
    action: 'Press See an example on a tile, then press Next.',
    advanceOn: 'next',
    missingTargetText:
      'The metrics you care about is the tile grid on the Summary tab.',
  },
  {
    id: 'every-metric',
    plan: 'read-numbers',
    tab: 'summary',
    anchor: 'show-every-metric',
    title: 'More if you want them',
    body: 'Show every metric opens the second set. Hover any info icon for its definition.',
    action: 'Press Show every metric, then press Next.',
    advanceOn: 'next',
    missingTargetText:
      'Show every metric sits under the tiles on the Summary tab.',
  },
]

const FINISHED_WORK_TABLE_MISSING = 'The Finished work tab holds this table.'

const FINISHED_WORK_STEPS: readonly TourStep[] = [
  {
    id: 'finished-table',
    plan: 'finished-work',
    tab: 'finished',
    anchor: 'finished-work-table',
    title: 'What got done',
    body: `One row per kind of finished ${WORK_ITEM_NOUN}, with how many and what the AI cost, for the agents you checked.`,
    action: 'Read the rows, then press Next.',
    advanceOn: 'next',
    missingTargetText: FINISHED_WORK_TABLE_MISSING,
  },
  {
    id: 'finished-source',
    plan: 'finished-work',
    tab: 'finished',
    anchor: 'finished-work-table',
    title: 'Where a row comes from',
    body: `Rows land when your meter or your app reports a finished ${WORK_ITEM_NOUN}. Getting Started, in the left menu under Learn, shows how.`,
    action: 'Press Done when you have read this.',
    advanceOn: 'next',
    missingTargetText: FINISHED_WORK_TABLE_MISSING,
  },
]

const GET_IT_OUT_STEPS: readonly TourStep[] = [
  {
    id: 'print-again',
    plan: 'get-it-out',
    tab: 'summary',
    anchor: 'print-report',
    title: 'Print report',
    body: 'Every tab in one board-ready document. Choose Save as PDF in the print window.',
    action: 'Press Print report, then press Next.',
    advanceOn: 'next',
    missingTargetText: PRINT_MISSING,
  },
  {
    id: 'json',
    plan: 'get-it-out',
    tab: 'summary',
    anchor: 'get-this-as-data',
    title: 'Get this as data',
    body: 'The same numbers as a data file, with a source stamp on each one, for your own spreadsheet or system.',
    action: 'Press Get this as data, then press Done.',
    advanceOn: 'next',
    missingTargetText:
      'Get this as data is the link beside Print report in the page header.',
  },
]

export const TOUR_PLANS: Record<TourPlanId, TourPlan> = {
  'first-roi': {
    id: 'first-roi',
    label: 'Your first ROI number',
    auto: true,
    steps: FIRST_ROI_STEPS,
  },
  'first-numbers': {
    id: 'first-numbers',
    label: 'Your first numbers',
    auto: true,
    steps: FIRST_NUMBERS_STEPS,
  },
  'read-numbers': {
    id: 'read-numbers',
    label: 'Read the numbers',
    auto: false,
    steps: READ_NUMBERS_STEPS,
  },
  'finished-work': {
    id: 'finished-work',
    label: 'Finished work',
    auto: false,
    steps: FINISHED_WORK_STEPS,
  },
  'get-it-out': {
    id: 'get-it-out',
    label: 'Get it out',
    auto: false,
    steps: GET_IT_OUT_STEPS,
  },
}

export interface TourMenuItem {
  /** null means "whichever tour this organization resolves to right now". */
  planId: TourPlanId | null
  label: string
}

export const TOUR_MENU_ITEMS: readonly TourMenuItem[] = [
  { planId: null, label: 'Start the tour' },
  { planId: 'read-numbers', label: 'Read the numbers' },
  { planId: 'finished-work', label: 'Finished work' },
  { planId: 'get-it-out', label: 'Get it out' },
]

export function everyTourStep(): TourStep[] {
  return Object.values(TOUR_PLANS).flatMap((plan) => [...plan.steps])
}

/** One step of one tour, named so a caller can tell "still here" from "moved on". */
export function tourStepKey(planId: TourPlanId, index: number): string {
  return `${planId}:${index}`
}

export interface TourTabSwitch {
  /** The tab to move to, or null to leave the tab exactly where it is. */
  switchTo: TourTab | null
  /** The step key to remember as switched for, handed back to the next call. */
  switchedFor: string
}

/**
 * Radix unmounts the panel a reader is not on, so the tour has to move the tab
 * for a step whose control lives on another one. It gets exactly one move per
 * step. After that the tab belongs to the customer: a step card sitting on the
 * Goals tab must not drag someone back every time they click Summary to look
 * at their numbers, because the only way out of that loop is closing the tour,
 * which is permanent.
 */
export function tourTabSwitch({
  stepKey,
  stepTab,
  activeTab,
  switchedFor,
}: {
  stepKey: string
  stepTab: TourTab
  activeTab: TourTab
  switchedFor: string | null
}): TourTabSwitch {
  if (switchedFor === stepKey) return { switchTo: null, switchedFor }
  return {
    switchTo: stepTab === activeTab ? null : stepTab,
    switchedFor: stepKey,
  }
}

/**
 * WHY A DEEP LINK OUTRANKS THE TOUR: every auto tour's first card sits on
 * Summary, so its tab switch would turn a fresh /roi?tab=goals into
 * ?tab=summary.
 * The launcher is unaffected: pressing Show me around asks for the tab move.
 *
 * WHY THE RESUME STEP COUNTS TOO: the tour's own tab switch is what lands a
 * customer who left on a Goals step back on ?tab=goals, so reading only the
 * first card's tab would call their own resume a deep link and shut it off. A
 * browser with no key resumes at zero, which is the first card again.
 */
export function tourAutoOpensOnLanding({
  plan,
  landingTab,
  at,
}: {
  plan: TourPlan
  landingTab: TourTab
  /** The step this landing would resume on, zero for a browser with no key. */
  at: number
}): boolean {
  if (!plan.auto) return false
  const firstStep = plan.steps[0]
  if (!firstStep) return false
  if (firstStep.tab === landingTab) return true
  return plan.steps[at]?.tab === landingTab
}

export function resolveTourPlan({
  hasEvents,
}: {
  /** null is "the first-event read has not answered", never a claim of zero. */
  hasEvents: boolean | null
}): TourPlan {
  if (hasEvents === false) return TOUR_PLANS['first-numbers']
  return TOUR_PLANS['first-roi']
}

export interface TourState {
  version: string
  dismissed: boolean
  /**
   * Which tour was on screen when this was written. One key holds one
   * dismissal, and the three auto tours are different tours: the customer who
   * skips the three-step no-data tour has not seen the six-step one, and the
   * step they left on belongs to the plan they left it in.
   */
  plan: TourPlanId | null
  /** The step the customer left on, so they come back to it. */
  step: number
}

const NEVER_SEEN: TourState = {
  version: TOUR_VERSION,
  dismissed: false,
  plan: null,
  step: 0,
}

const isPlanId = (value: unknown): value is TourPlanId =>
  typeof value === 'string' && value in TOUR_PLANS

export function readTourState(raw: string | null): TourState {
  if (!raw) return NEVER_SEEN
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NEVER_SEEN
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NEVER_SEEN
  }
  const value = parsed as Partial<TourState>
  const step = value.step
  return {
    version: typeof value.version === 'string' ? value.version : '',
    dismissed: value.dismissed === true,
    plan: isPlanId(value.plan) ? value.plan : null,
    step:
      typeof step === 'number' && Number.isInteger(step) && step >= 0
        ? step
        : 0,
  }
}

export function writeTourState(state: TourState): string {
  return JSON.stringify(state)
}

/**
 * Dismissed counts against the tour it was dismissed on and the version it was
 * dismissed at. Plan, because closing the no-data tour is not a verdict on the
 * six-step one, and the customer with nothing on the page is the one who needs
 * the real tour most once their numbers land. Version, so a material redesign
 * of this page bumps TOUR_VERSION and the tour returns exactly once.
 */
export function isTourDismissed(
  stored: TourState,
  planId: TourPlanId,
  version: string = TOUR_VERSION
): boolean {
  return (
    stored.dismissed && stored.version === version && stored.plan === planId
  )
}

/**
 * The launcher is not a way to undo a dismissal: a customer who reopens the
 * tour from it is reading the tour, not asking for it back on every landing.
 * Only reaching Done writes the flag on a run the customer started.
 */
export function runWritesDismissal({
  planIsAuto,
  startedBy,
  reason,
}: {
  planIsAuto: boolean
  startedBy: TourStartSource
  reason: TourCloseReason
}): boolean {
  if (!planIsAuto) return false
  return startedBy === 'auto' || reason === 'done'
}

/** The resume point belongs to the run that opened by itself. */
export function runWritesResumeStep({
  planIsAuto,
  startedBy,
}: {
  planIsAuto: boolean
  startedBy: TourStartSource
}): boolean {
  return planIsAuto && startedBy === 'auto'
}

/** A step index only means anything inside the plan it was written for. */
export function resumeStep(
  stored: TourState,
  planId: TourPlanId,
  version: string = TOUR_VERSION
): number {
  if (stored.version !== version || stored.plan !== planId) return 0
  return stored.dismissed ? 0 : stored.step
}

export interface TourRect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface TourViewport {
  width: number
  height: number
}

export interface TourCardSize {
  width: number
  height: number
}

export interface TourCardPlacement {
  top: number
  left: number
  width: number
  docked: boolean
}

/**
 * A target the card can point at. A control that has left the document still
 * answers getBoundingClientRect, with every field zero, which would park the
 * card in the top-left corner and collapse the spotlight to a hole with no
 * size, dimming the whole page. The Estimate without AI button does exactly
 * that: it unmounts the moment the form it opens is on screen.
 */
export function isPointableTarget(
  target: { connected: boolean; rect: TourRect } | null
): boolean {
  if (!target) return false
  return target.connected && target.rect.width > 0 && target.rect.height > 0
}

/** The one anchor that can match several elements at once. */
export const GOAL_CARD_ANCHOR = 'goal-card'

/**
 * WHY THE GOAL CARD IS ITS OWN CASE: every goal wears the goal-card anchor and
 * the created one is rarely first in the grid, so a search that ran before the
 * refetch landed would settle on somebody else's card and keep it. The id in the
 * selector is what makes the wait a wait.
 */
export function tourTargetSelector({
  anchor,
  pinnedGoalId,
}: {
  anchor: string
  pinnedGoalId: string | null
}): string {
  if (anchor !== GOAL_CARD_ANCHOR || !pinnedGoalId) {
    return `[data-tour='${anchor}']`
  }
  // It comes from the server and it is about to be spliced into a selector.
  const id = pinnedGoalId.replace(/['\\]/g, '')
  return `[data-tour='${GOAL_CARD_ANCHOR}'][data-tour-id='${id}']`
}

const CARD_GAP = 12
const VIEWPORT_MARGIN = 16
const DOCK_BELOW_WIDTH = 640

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, high))

function dockCard(
  card: TourCardSize,
  viewport: TourViewport
): TourCardPlacement {
  return {
    top: Math.max(
      VIEWPORT_MARGIN,
      viewport.height - card.height - VIEWPORT_MARGIN
    ),
    left: VIEWPORT_MARGIN,
    width: Math.max(0, viewport.width - VIEWPORT_MARGIN * 2),
    docked: true,
  }
}

/**
 * The card may never cover the control it points at, so the order is below,
 * then above, then beside, and it docks at the bottom rather than take a place
 * it does not fit. Under 640px nothing floats: the card always docks.
 *
 * The one case the rule cannot hold is a control that is itself taller and
 * wider than the room a card needs on any side of it. Docking is the least bad
 * answer there: the top of the control stays readable.
 */
export function placeCard(
  target: TourRect,
  card: TourCardSize,
  viewport: TourViewport
): TourCardPlacement {
  if (viewport.width < DOCK_BELOW_WIDTH) return dockCard(card, viewport)

  const left = clamp(
    target.left,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewport.width - card.width - VIEWPORT_MARGIN)
  )
  const below = target.bottom + CARD_GAP
  if (below + card.height <= viewport.height - VIEWPORT_MARGIN) {
    return { top: below, left, width: card.width, docked: false }
  }

  const above = target.top - CARD_GAP - card.height
  if (above >= VIEWPORT_MARGIN) {
    return { top: above, left, width: card.width, docked: false }
  }

  const top = clamp(
    target.top,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewport.height - card.height - VIEWPORT_MARGIN)
  )
  const rightOf = target.right + CARD_GAP
  if (rightOf + card.width <= viewport.width - VIEWPORT_MARGIN) {
    return { top, left: rightOf, width: card.width, docked: false }
  }

  const leftOf = target.left - CARD_GAP - card.width
  if (leftOf >= VIEWPORT_MARGIN) {
    return { top, left: leftOf, width: card.width, docked: false }
  }

  return dockCard(card, viewport)
}
