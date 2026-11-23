/**
 * WHAT THIS FILE DOES: holds the ONE customer-facing noun for the thing AI
 * spend is billed against, so changing the word is a one-line edit here
 * rather than a hunt through the ROI and Matters surfaces.
 *
 * WHY IT EXISTS: "matter" reads as a law-firm word to every customer who is
 * not a law firm. Keeping the noun in one place makes renaming it cheap.
 *
 * SCOPE: display copy only. matterId on the wire, the matters table, the /law
 * route and the 'legal' API role all stay exactly as they are — renaming any
 * of those is a schema or route change, not a copy fix.
 *
 * Lives in apps/dashboard/lib/ (not src/lib/): the Next build resolves
 * @/lib/* against this directory only.
 */

export const WORK_ITEM_NOUN = 'work item'
export const WORK_ITEM_NOUN_PLURAL = 'work items'

/** Derived, never typed a second time, so renaming the noun stays one edit. */
export const WORK_ITEM_NOUN_SENTENCE_CASE =
  WORK_ITEM_NOUN[0].toUpperCase() + WORK_ITEM_NOUN.slice(1)
