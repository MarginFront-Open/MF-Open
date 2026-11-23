/**
 * Which element a step is looking for.
 *
 * Step five follows the create, and every goal on the page wears the same
 * goal-card anchor. The grid is ordered by start date, so the goal the
 * customer just made is rarely the first one, and its card cannot exist at all
 * until the refetch behind the create lands. Looking up the anchor alone
 * would point the step at an older goal.
 */

import { GOAL_CARD_ANCHOR, tourTargetSelector } from '../tour/tour-steps'

describe('tourTargetSelector', () => {
  it('a plain anchor is looked up by the attribute alone', () => {
    expect(
      tourTargetSelector({ anchor: 'date-range', pinnedGoalId: null })
    ).toBe("[data-tour='date-range']")
  })

  it('the goal card names the goal that was created', () => {
    expect(
      tourTargetSelector({ anchor: GOAL_CARD_ANCHOR, pinnedGoalId: 'abc-123' })
    ).toBe("[data-tour='goal-card'][data-tour-id='abc-123']")
  })

  it('a known id leaves no way to match any other card', () => {
    // With the id in the selector there is nothing else
    // for a search to settle on while the created card is still on its way.
    const selector = tourTargetSelector({
      anchor: GOAL_CARD_ANCHOR,
      pinnedGoalId: 'abc-123',
    })
    expect(selector).toContain('data-tour-id')
    expect(selector).not.toBe("[data-tour='goal-card']")
  })

  it('no id yet means the plain anchor, so the step still has something to point at', () => {
    // The chapters reach this step without a create.
    expect(
      tourTargetSelector({ anchor: GOAL_CARD_ANCHOR, pinnedGoalId: null })
    ).toBe("[data-tour='goal-card']")
  })

  it('only the goal card is narrowed — a pin never rewrites another anchor', () => {
    expect(
      tourTargetSelector({ anchor: 'print-report', pinnedGoalId: 'abc-123' })
    ).toBe("[data-tour='print-report']")
  })

  it('quotes and backslashes are taken out of the id before it reaches the selector', () => {
    expect(
      tourTargetSelector({
        anchor: GOAL_CARD_ANCHOR,
        pinnedGoalId: "a'b\\c",
      })
    ).toBe("[data-tour='goal-card'][data-tour-id='abc']")
  })
})
