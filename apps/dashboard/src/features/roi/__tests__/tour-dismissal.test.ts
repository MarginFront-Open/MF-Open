/**
 * "every time someone lands here until they dismiss it".
 *
 * The whole of that sentence lives in these four pure functions. A customer
 * who closes the tour never sees that tour open itself again; a customer who
 * wanders off mid-tour comes back to the card they left; a material redesign
 * bumps the version and the tour returns once. Garbage in the key reads as a
 * customer who has never seen it, never as a crash on a money page.
 *
 * The dismissal names its plan. One flag shared by three different tours would
 * let skipping the three-step no-data tour cancel the six-step one forever,
 * for exactly the customer who had nothing on the page the first time and
 * most needs the tour once numbers land.
 */

import {
  TOUR_VERSION,
  isTourDismissed,
  readTourState,
  resumeStep,
  runWritesDismissal,
  runWritesResumeStep,
  writeTourState,
  type TourState,
} from '../tour/tour-steps'

const state = (over: Partial<TourState> = {}): TourState => ({
  version: TOUR_VERSION,
  dismissed: false,
  plan: 'first-roi',
  step: 0,
  ...over,
})

const roundTrip = (over: Partial<TourState> = {}): TourState =>
  readTourState(writeTourState(state(over)))

describe('readTourState', () => {
  it('a missing key is a customer who has never seen the tour', () => {
    const stored = readTourState(null)
    expect(stored.dismissed).toBe(false)
    expect(stored.step).toBe(0)
    expect(stored.plan).toBeNull()
    expect(isTourDismissed(stored, 'first-roi')).toBe(false)
  })

  it('garbage reads as never seen rather than throwing on a money page', () => {
    for (const raw of ['', 'not json', '{', '[]', 'null', '42', '"1"']) {
      const stored = readTourState(raw)
      expect(isTourDismissed(stored, 'first-roi')).toBe(false)
      expect(stored.step).toBe(0)
    }
  })

  it('a step that is not a whole number is ignored', () => {
    expect(roundTrip({ step: 2.5 }).step).toBe(0)
    expect(roundTrip({ step: -3 }).step).toBe(0)
  })

  it('a plan name that is not a plan reads as no plan', () => {
    const raw = JSON.stringify({
      version: TOUR_VERSION,
      dismissed: true,
      plan: 'whatever-this-is',
      step: 2,
    })
    expect(readTourState(raw).plan).toBeNull()
    expect(isTourDismissed(readTourState(raw), 'first-roi')).toBe(false)
  })
})

describe('isTourDismissed', () => {
  it('dismissed at the current version, on this plan, means dismissed', () => {
    expect(
      isTourDismissed(roundTrip({ dismissed: true, step: 3 }), 'first-roi')
    ).toBe(true)
  })

  it('dismissed at an older version shows the tour once more', () => {
    expect(
      isTourDismissed(
        roundTrip({ version: '0', dismissed: true, step: 3 }),
        'first-roi'
      )
    ).toBe(false)
  })

  it('a stored state that was never dismissed is not dismissed', () => {
    expect(isTourDismissed(roundTrip({ step: 2 }), 'first-roi')).toBe(false)
  })

  it('skipping the no-data tour leaves the real tour still to be shown', () => {
    const stored = roundTrip({
      dismissed: true,
      plan: 'first-numbers',
      step: 0,
    })
    expect(isTourDismissed(stored, 'first-numbers')).toBe(true)
    expect(isTourDismissed(stored, 'first-roi')).toBe(false)
  })
})

describe('resumeStep', () => {
  it('the step round-trips through write and read', () => {
    const stored = roundTrip({ step: 2 })
    expect(stored.step).toBe(2)
    expect(resumeStep(stored, 'first-roi')).toBe(2)
  })

  it('a dismissed tour has no step to resume', () => {
    expect(
      resumeStep(roundTrip({ dismissed: true, step: 4 }), 'first-roi')
    ).toBe(0)
  })

  it('a step saved against an older version starts over', () => {
    expect(resumeStep(roundTrip({ version: '0', step: 4 }), 'first-roi')).toBe(
      0
    )
  })

  it('a step saved on another plan starts over', () => {
    // A step saved by the three-step no-data tour must not resume the
    // six-step tour part way through, skipping its step one.
    const stored = roundTrip({ plan: 'first-numbers', step: 1 })
    expect(resumeStep(stored, 'first-numbers')).toBe(1)
    expect(resumeStep(stored, 'first-roi')).toBe(0)
  })
})

describe('who may write the key', () => {
  it('a run that opened by itself owns both the resume point and the dismissal', () => {
    expect(runWritesResumeStep({ planIsAuto: true, startedBy: 'auto' })).toBe(
      true
    )
    for (const reason of ['done', 'skip', 'escape', 'close'] as const) {
      expect(
        runWritesDismissal({
          planIsAuto: true,
          startedBy: 'auto',
          reason,
        })
      ).toBe(true)
    }
  })

  it('Show me around never un-dismisses the tour it reopens', () => {
    // A customer who closed the tour and later picks Start the tour is
    // reading it, not asking for it back on every landing, so leaving the run
    // mid-way must not write dismissed false.
    expect(runWritesResumeStep({ planIsAuto: true, startedBy: 'button' })).toBe(
      false
    )
    for (const reason of ['skip', 'escape', 'close'] as const) {
      expect(
        runWritesDismissal({
          planIsAuto: true,
          startedBy: 'button',
          reason,
        })
      ).toBe(false)
    }
  })

  it('reaching Done still dismisses, whichever door opened the tour', () => {
    expect(
      runWritesDismissal({
        planIsAuto: true,
        startedBy: 'button',
        reason: 'done',
      })
    ).toBe(true)
  })

  it('a chapter writes nothing at all', () => {
    for (const startedBy of ['auto', 'button'] as const) {
      expect(runWritesResumeStep({ planIsAuto: false, startedBy })).toBe(false)
      for (const reason of ['done', 'skip', 'escape', 'close'] as const) {
        expect(
          runWritesDismissal({ planIsAuto: false, startedBy, reason })
        ).toBe(false)
      }
    }
  })
})
