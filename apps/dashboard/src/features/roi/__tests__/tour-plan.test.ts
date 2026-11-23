/**
 * Which tour a customer gets.
 *
 * Two states of the same page: an organization with numbers, and one whose
 * first usage event has not landed. Picking the wrong plan walks someone
 * through steps that have nothing to point at.
 */

import { ROI_TABS } from '../roi-tabs'
import {
  TOUR_PLANS,
  resolveTourPlan,
  tourStepKey,
  tourTabSwitch,
} from '../tour/tour-steps'

describe('resolveTourPlan', () => {
  it('an organization with numbers gets the core tour', () => {
    expect(resolveTourPlan({ hasEvents: true })).toBe(TOUR_PLANS['first-roi'])
  })

  it('an organization with no usage events gets the first-numbers tour', () => {
    expect(resolveTourPlan({ hasEvents: false })).toBe(
      TOUR_PLANS['first-numbers']
    )
  })

  it('an unanswered first-event read is not a claim of zero — the core tour stands', () => {
    expect(resolveTourPlan({ hasEvents: null })).toBe(TOUR_PLANS['first-roi'])
  })

  it('only auto plans are resolvable — a chapter is never handed out by itself', () => {
    for (const inputs of [
      { hasEvents: true },
      { hasEvents: false },
      { hasEvents: null },
    ]) {
      expect(resolveTourPlan(inputs).auto).toBe(true)
    }
  })
})

describe('tourTabSwitch', () => {
  const key = tourStepKey('first-roi', 3)

  it('moves the tab once for a step whose control lives on another one', () => {
    expect(
      tourTabSwitch({
        stepKey: key,
        stepTab: 'goals',
        activeTab: 'summary',
        switchedFor: null,
      })
    ).toEqual({ switchTo: 'goals', switchedFor: key })
  })

  it('leaves a customer who clicks a different tab where they clicked', () => {
    // The tour moves the tab once per step. Re-running the move on every tab
    // change would snap Summary back to Goals, and the only way to browse the
    // page would be to close the tour, which never opens itself again.
    expect(
      tourTabSwitch({
        stepKey: key,
        stepTab: 'goals',
        activeTab: 'summary',
        switchedFor: key,
      }).switchTo
    ).toBeNull()
  })

  it('moves again as soon as the step itself changes', () => {
    const next = tourStepKey('first-roi', 5)
    expect(
      tourTabSwitch({
        stepKey: next,
        stepTab: 'summary',
        activeTab: 'goals',
        switchedFor: key,
      })
    ).toEqual({ switchTo: 'summary', switchedFor: next })
  })

  it('asks for no move at all when the step is already on the right tab', () => {
    const decision = tourTabSwitch({
      stepKey: key,
      stepTab: 'goals',
      activeTab: 'goals',
      switchedFor: null,
    })
    expect(decision.switchTo).toBeNull()
    // Still remembered, so the customer's next click is theirs to keep.
    expect(decision.switchedFor).toBe(key)
  })

  it('a step key names one step of one tour', () => {
    expect(tourStepKey('first-roi', 0)).not.toBe(
      tourStepKey('first-numbers', 0)
    )
    expect(tourStepKey('first-roi', 0)).not.toBe(tourStepKey('first-roi', 1))
  })

  it('every step of every plan names a tab the page really has', () => {
    // Read from the page's own registry, not a copy of it: a fourth ROI tab
    // must not be able to leave a step pointing at a panel nobody renders.
    const tabs = new Set(ROI_TABS.map((tab) => tab.id))
    for (const plan of Object.values(TOUR_PLANS)) {
      for (const step of plan.steps) expect(tabs.has(step.tab)).toBe(true)
    }
  })
})
