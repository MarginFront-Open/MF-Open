/**
 * WHAT THIS FILE DOES: lets a control on the ROI page tell the tour that the
 * real thing happened, without that control knowing the tour exists.
 *
 * WHY IT EXISTS: a step that asks the customer to save their numbers has to
 * advance when the numbers save, not when they click Next to say they did.
 * Threading a callback from the page down through the report, the Without AI
 * block and the goal dialog would put tour wiring in four components that have
 * nothing to do with the tour. One module-level subscription instead: the
 * controls call notifyRoiTour, the tour hook is the only subscriber.
 */

export type RoiTourSignal =
  | { kind: 'numbers-saved' }
  | { kind: 'goal-created'; initiativeId: string }
  | { kind: 'print-opened' }

type RoiTourListener = (signal: RoiTourSignal) => void

const listeners = new Set<RoiTourListener>()

export function notifyRoiTour(signal: RoiTourSignal): void {
  // Copied first: a listener that unsubscribes itself while advancing would
  // otherwise mutate the set mid-iteration.
  for (const listener of [...listeners]) listener(signal)
}

export function subscribeToRoiTour(listener: RoiTourListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
