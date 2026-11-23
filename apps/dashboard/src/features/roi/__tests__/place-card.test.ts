/**
 * Where the step card sits.
 *
 * The one rule that matters: the card may never cover the control it is
 * pointing at. Everything else here (flip up when there is no room down,
 * stay inside the viewport, dock at the bottom on a phone) exists to keep
 * that rule true on a real screen.
 */

import { isPointableTarget, placeCard, type TourRect } from '../tour/tour-steps'

const CARD = { width: 320, height: 160 }
const DESKTOP = { width: 1440, height: 900 }

const rect = (
  left: number,
  top: number,
  width: number,
  height: number
): TourRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})

const overlaps = (
  placement: { top: number; left: number; width: number },
  target: TourRect
): boolean => {
  const cardRight = placement.left + placement.width
  const cardBottom = placement.top + CARD.height
  return (
    placement.left < target.right &&
    cardRight > target.left &&
    placement.top < target.bottom &&
    cardBottom > target.top
  )
}

describe('placeCard', () => {
  it('sits below the target when there is room', () => {
    const target = rect(400, 200, 240, 40)
    const placement = placeCard(target, CARD, DESKTOP)
    expect(placement.docked).toBe(false)
    expect(placement.top).toBeGreaterThan(target.bottom)
    expect(overlaps(placement, target)).toBe(false)
  })

  it('flips above the target when the bottom of the screen is too close', () => {
    const target = rect(400, 800, 240, 40)
    const placement = placeCard(target, CARD, DESKTOP)
    expect(placement.docked).toBe(false)
    expect(placement.top + CARD.height).toBeLessThan(target.top)
    expect(overlaps(placement, target)).toBe(false)
  })

  it('clamps inside the viewport horizontally on both edges', () => {
    const farRight = placeCard(rect(1400, 200, 30, 30), CARD, DESKTOP)
    expect(farRight.left + farRight.width).toBeLessThanOrEqual(DESKTOP.width)
    expect(farRight.left).toBeGreaterThanOrEqual(0)

    const farLeft = placeCard(rect(-20, 200, 30, 30), CARD, DESKTOP)
    expect(farLeft.left).toBeGreaterThanOrEqual(0)
  })

  it('never runs off the top or the bottom of the viewport', () => {
    for (const target of [
      rect(400, 0, 240, 20),
      rect(400, 880, 240, 20),
      rect(400, 420, 240, 40),
    ]) {
      const placement = placeCard(target, CARD, DESKTOP)
      expect(placement.top).toBeGreaterThanOrEqual(0)
      expect(placement.top + CARD.height).toBeLessThanOrEqual(DESKTOP.height)
    }
  })

  it('docks to the bottom of the screen under 640px wide', () => {
    const phone = { width: 390, height: 780 }
    const placement = placeCard(rect(16, 300, 300, 40), CARD, phone)
    expect(placement.docked).toBe(true)
    expect(placement.top + CARD.height).toBeLessThanOrEqual(phone.height)
    expect(placement.width).toBeLessThanOrEqual(phone.width - 32)
  })

  it('a tall target with no room above or below goes beside it, never over it', () => {
    const target = rect(200, 40, 240, 820)
    const placement = placeCard(target, CARD, DESKTOP)
    expect(overlaps(placement, target)).toBe(false)
  })

  it('a target too wide for either side docks rather than sit on the control', () => {
    // Neither side has room: pinning the card at the left margin would put it
    // straight over the control the step describes, so it docks instead.
    const target = rect(100, 100, 1240, 700)
    const placement = placeCard(target, CARD, DESKTOP)
    expect(placement.docked).toBe(true)
    expect(placement.left).toBeGreaterThanOrEqual(0)
    expect(placement.left + placement.width).toBeLessThanOrEqual(DESKTOP.width)
    expect(placement.top + CARD.height).toBeLessThanOrEqual(DESKTOP.height)
  })

  it('goes to the left of the target when only the left side has room', () => {
    const target = rect(900, 40, 500, 820)
    const placement = placeCard(target, CARD, DESKTOP)
    expect(placement.docked).toBe(false)
    expect(placement.left + placement.width).toBeLessThanOrEqual(target.left)
    expect(overlaps(placement, target)).toBe(false)
  })

  it('the card is never wider than the screen allows', () => {
    const phone = { width: 360, height: 700 }
    expect(placeCard(rect(10, 10, 100, 30), CARD, phone).width).toBeLessThan(
      phone.width
    )
  })
})

describe('isPointableTarget', () => {
  it('a control that is on screen with a size is pointable', () => {
    expect(
      isPointableTarget({ connected: true, rect: rect(10, 10, 120, 28) })
    ).toBe(true)
  })

  it('a control that has left the document is not', () => {
    // The Estimate without AI button unmounts behind the form it opens. It
    // still answers getBoundingClientRect, with every field zero, so a card
    // placed against it lands in the corner and the spotlight collapses to a
    // hole with no size, which dims the whole page while the customer types.
    expect(
      isPointableTarget({ connected: false, rect: rect(10, 10, 120, 28) })
    ).toBe(false)
  })

  it('a zero-size box is not, even while the node is still attached', () => {
    expect(isPointableTarget({ connected: true, rect: rect(0, 0, 0, 0) })).toBe(
      false
    )
    expect(
      isPointableTarget({ connected: true, rect: rect(10, 10, 120, 0) })
    ).toBe(false)
  })

  it('nothing found is not pointable', () => {
    expect(isPointableTarget(null)).toBe(false)
  })
})
