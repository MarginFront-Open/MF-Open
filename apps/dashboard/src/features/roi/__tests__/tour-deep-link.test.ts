/**
 * A deep link to a tab must survive the guided tour, and a tour left half way
 * through must still come back on the step the customer left.
 *
 * Two rules meet on the same landing. The auto-open fires on a landing and the
 * first card of every auto tour sits on Summary, so a fresh browser opening
 * /roi?tab=goals would be carried to ?tab=summary and lose the tab it asked
 * for. But a customer who leaves the tour on a Goals step reloads onto
 * ?tab=goals, and that landing has to reopen the tour on the step they left:
 * a rule that only looked at the first card's tab would shut the resume off.
 *
 * The rule: the tour opens by itself when the landing tab is the tab its first
 * card lives on, or the tab of the step it is about to resume on. On every
 * other landing tab the Show me around launcher stays the door.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { ROI_TABS, resolveRoiTab } from '../roi-tabs'
import {
  TOUR_PLANS,
  TOUR_VERSION,
  isTourDismissed,
  readTourState,
  resumeStep,
  tourAutoOpensOnLanding,
  writeTourState,
  type TourPlanId,
  type TourState,
  type TourTab,
} from '../tour/tour-steps'

const hookSrc = readFileSync(
  join(__dirname, '..', 'tour', 'use-roi-tour.ts'),
  'utf8'
)

const stored = (over: Partial<TourState>): TourState =>
  readTourState(
    writeTourState({
      version: TOUR_VERSION,
      dismissed: false,
      plan: 'first-roi',
      step: 0,
      ...over,
    })
  )

const NEVER_SEEN = readTourState(null)

/** The hook's own order, so the tests pin the decision the page makes. */
function landingDecision({
  planId,
  landingTab,
  state,
}: {
  planId: TourPlanId
  landingTab: TourTab
  state: TourState
}): { opens: boolean; at: number } {
  const plan = TOUR_PLANS[planId]
  if (isTourDismissed(state, plan.id)) return { opens: false, at: 0 }
  const at = Math.max(
    0,
    Math.min(resumeStep(state, plan.id), plan.steps.length - 1)
  )
  return { opens: tourAutoOpensOnLanding({ plan, landingTab, at }), at }
}

describe('tourAutoOpensOnLanding', () => {
  it('opens on the tab its first card lives on', () => {
    const plan = TOUR_PLANS['first-roi']
    expect(plan.steps[0].tab).toBe('summary')
    expect(tourAutoOpensOnLanding({ plan, landingTab: 'summary', at: 0 })).toBe(
      true
    )
  })

  it('a bare /roi still opens the tour, because no tab param means Summary', () => {
    expect(
      tourAutoOpensOnLanding({
        plan: TOUR_PLANS['first-roi'],
        landingTab: resolveRoiTab(null),
        at: 0,
      })
    ).toBe(true)
  })

  it.each(['finished', 'goals'] as const)(
    'stays shut on a fresh deep link to ?tab=%s',
    (tab) => {
      for (const planId of ['first-roi', 'first-numbers'] as const) {
        expect(
          tourAutoOpensOnLanding({
            plan: TOUR_PLANS[planId],
            landingTab: tab,
            at: 0,
          })
        ).toBe(false)
      }
    }
  )

  it('never auto-opens a plan the customer has to start by hand', () => {
    for (const plan of Object.values(TOUR_PLANS)) {
      if (plan.auto) continue
      for (const tab of ROI_TABS) {
        for (let at = 0; at < plan.steps.length; at += 1) {
          expect(tourAutoOpensOnLanding({ plan, landingTab: tab.id, at })).toBe(
            false
          )
        }
      }
    }
  })

  it('answers for every tab the page can resolve', () => {
    for (const tab of ROI_TABS) {
      expect(
        typeof tourAutoOpensOnLanding({
          plan: TOUR_PLANS['first-numbers'],
          landingTab: tab.id,
          at: 0,
        })
      ).toBe('boolean')
    }
  })

  it('opens on the tab the step it is resuming on lives on', () => {
    const plan = TOUR_PLANS['first-roi']
    expect(plan.steps[4].tab).toBe('goals')
    expect(tourAutoOpensOnLanding({ plan, landingTab: 'goals', at: 4 })).toBe(
      true
    )
  })

  it('a resume step is not a way onto a third tab', () => {
    const plan = TOUR_PLANS['first-roi']
    expect(
      tourAutoOpensOnLanding({ plan, landingTab: 'finished', at: 4 })
    ).toBe(false)
  })
})

describe('the landing decision, stored state and all', () => {
  it('a fresh browser deep-linked to Goals does not open the tour', () => {
    expect(
      landingDecision({
        planId: 'first-roi',
        landingTab: 'goals',
        state: NEVER_SEEN,
      })
    ).toEqual({ opens: false, at: 0 })
  })

  it('a customer who left on a Goals step reloads onto Goals and resumes there', () => {
    expect(
      landingDecision({
        planId: 'first-roi',
        landingTab: 'goals',
        state: stored({ step: 4 }),
      })
    ).toEqual({ opens: true, at: 4 })
  })

  it('the same customer landing on Summary still resumes on that step', () => {
    expect(
      landingDecision({
        planId: 'first-roi',
        landingTab: 'summary',
        state: stored({ step: 4 }),
      })
    ).toEqual({ opens: true, at: 4 })
  })

  it.each(ROI_TABS.map((tab) => tab.id))(
    'a dismissed tour never comes back, landing on %s',
    (landingTab) => {
      expect(
        landingDecision({
          planId: 'first-roi',
          landingTab,
          state: stored({ dismissed: true, step: 4 }),
        })
      ).toEqual({ opens: false, at: 0 })
    }
  )

  it('a step left in another plan does not open this one on Goals', () => {
    expect(
      landingDecision({
        planId: 'first-roi',
        landingTab: 'goals',
        state: stored({ plan: 'read-numbers', step: 3 }),
      })
    ).toEqual({ opens: false, at: 0 })
  })

  it('a step index past the end of the plan cannot land off the plan', () => {
    const { opens, at } = landingDecision({
      planId: 'first-roi',
      landingTab: 'summary',
      state: stored({ step: 99 }),
    })
    expect(at).toBe(TOUR_PLANS['first-roi'].steps.length - 1)
    expect(opens).toBe(true)
  })
})

// Source-asserted (dashboard jest is node-only), so these read the structure
// the rule needs, never the line it is written on: the capture may become a ref
// without the guarantee changing.
const ruleCall = hookSrc.indexOf('tourAutoOpensOnLanding({')
const autoOpenEffect = hookSrc.slice(
  hookSrc.lastIndexOf('useEffect(', ruleCall),
  hookSrc.indexOf('useEffect(', ruleCall)
)
const ruleArguments = autoOpenEffect.slice(
  autoOpenEffect.indexOf('tourAutoOpensOnLanding({'),
  autoOpenEffect.indexOf(
    '})',
    autoOpenEffect.indexOf('tourAutoOpensOnLanding({')
  )
)
const launcherStart = hookSrc.indexOf('const start = useCallback')

describe('use-roi-tour.ts — the landing tab', () => {
  it('asks the rule before the auto-open runs', () => {
    expect(ruleCall).toBeGreaterThan(-1)
    expect(autoOpenEffect).toMatch(/tourAutoOpensOnLanding/)
  })

  it('decides on the tab it landed on, never on the tab the tour is showing', () => {
    expect(hookSrc).toMatch(/landingTab[\s\S]{0,40}activeTab/)
    expect(autoOpenEffect).toMatch(/landingTab/)
    expect(autoOpenEffect).not.toMatch(/\bactiveTab\b/)
  })

  it('reads the stored resume point before it asks whether to open', () => {
    const read = autoOpenEffect.indexOf('readTourState')
    const resume = autoOpenEffect.indexOf('resumeStep')
    expect(read).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(read)
    expect(autoOpenEffect.indexOf('tourAutoOpensOnLanding')).toBeGreaterThan(
      resume
    )
  })

  it('hands the resume index to the rule, so the Goals steps can reopen', () => {
    expect(ruleArguments).toMatch(/\bat\b/)
  })

  it('settles the auto-open instead of waiting, so a later tab click is the customer’s', () => {
    const gate = autoOpenEffect.slice(
      autoOpenEffect.indexOf('tourAutoOpensOnLanding'),
      autoOpenEffect.indexOf('let timer')
    )
    expect(gate).toMatch(/settled\.current = true/)
  })

  it('leaves the launcher alone: the landing rule never reaches start()', () => {
    expect(launcherStart).toBeGreaterThan(-1)
    const startFn = hookSrc.slice(
      launcherStart,
      hookSrc.indexOf('useEffect(', launcherStart)
    )
    expect(startFn).toMatch(/open\(/)
    expect(startFn).toMatch(/autoPlan/)
    expect(startFn).toMatch(/source/)
    expect(startFn).not.toMatch(/tourAutoOpensOnLanding|landingTab/)
  })
})
