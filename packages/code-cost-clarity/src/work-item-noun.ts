// work-item-noun.ts - the one spelling of what a customer's spend is attached to.
//
// A LEAF on purpose: the dashboard's Jest loads finished-work.ts as CommonJS, so
// nothing may be added here that reaches import.meta, the filesystem or the clock.

// One constant, so renaming what printed copy calls this is one line, not a hunt.
export const WORK_ITEM_NOUN = "work item";

// The plain-English spelling of the same thing, beside the label spelling, so a
// rename moves both and the printed copy cannot split into two vocabularies.
export const WORK_ITEM_NOUN_PLAIN = "piece of work";
