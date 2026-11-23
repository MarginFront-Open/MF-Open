/**
 * WHAT THIS FILE DOES: the two ROI copy gates, as regexes, in one place.
 *
 * WHY IT EXISTS: tasks-copy-honesty.test.ts scans the ROI feature directory,
 * and roi-tooltip-inventory.test.ts scans the hover copy in
 * apps/dashboard/lib/tooltip-definitions.ts, which sits outside that directory.
 * Two suites with two copies of these patterns is two gates that drift apart.
 *
 * Not a suite itself: jest's testMatch takes `*.test.ts` only, and the feature
 * scan in tasks-copy-honesty.test.ts skips `__tests__`.
 */

/** The vertical's vocabulary. No ROI surface may carry any of it. */
export const VERTICAL_WORD =
  /\b(matter|matters|legal|law|laws|firm|firms|case|cases)\b/i

/**
 * "Above" and "below" are true on one screen and false in the print, on a
 * phone, to a screen reader and after a tab moves.
 */
export const LAYOUT_DIRECTION =
  /\b(above|below)\b|\b(top|bottom|left|right)\s+of\s+(the|this)\s+(page|screen|report)\b|\bon\s+the\s+(left|right)\b/i

/** There is no Agents page. There is Build's Agents tab. */
export const DEAD_PAGE_NAME = /\bthe Agents page\b/i

/** `npx` counts: when the surface is a terminal, the command IS the spot. */
export const SURFACE_WORD =
  /\b(terminal|dashboard|MarginFront|API|left menu|npx)\b/i

/** Imperatives only. "Opens your browser's print window" describes a control,
 * and is not a place the reader is being sent. */
export const MOVES_THE_READER = /\b(open|go to|run)\b/i

/** True when a finished sentence sends the reader somewhere unfindable. */
export function isWayfindingOffense(sentence: string): boolean {
  return (
    LAYOUT_DIRECTION.test(sentence) ||
    DEAD_PAGE_NAME.test(sentence) ||
    (MOVES_THE_READER.test(sentence) && !SURFACE_WORD.test(sentence))
  )
}

/**
 * The ROI page contracts everywhere: "We don't show hours
 * saved", "isn't", "won't", "can't". A hover written long ("It is never an
 * estimate", "so it is always yours") splits the voice inside one page.
 * These are the long forms whose contraction is the
 * one a person would actually write; "it is" on its own is the loudest of
 * them, so the list stays to the forms with no ambiguity.
 */
export const UNCONTRACTED =
  /\b(it is|we cannot|you cannot|cannot|does not|do not|did not|is not|are not|was not|were not|has not|have not|had not|there is|will not|would not|could not|should not)\b/i

/** The uncontracted forms in one sentence, for a failure message that names
 *  them rather than printing the whole paragraph back. */
export function uncontractedForms(text: string): string[] {
  return [...text.matchAll(new RegExp(UNCONTRACTED, 'gi'))].map(
    (match) => match[0]
  )
}

/** Sentence count for the hover cap. Abbreviations are not a risk here: this
 * copy is plain English by rule. */
export function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== '').length
}
