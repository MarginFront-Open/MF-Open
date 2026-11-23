/**
 * WHAT THIS FILE DOES: holds the one honest "where did this number come from"
 * label shown on the Month-End Close audit trail + CSV. There
 * is no provider-invoice linkage, so the label says so in plain words and surface
 * the SAME string in the UI and the export, so the two can never drift.
 *
 * WHY IT'S ITS OWN PLAIN MODULE: journal-export.ts is a 'use server' module,
 * and Next.js only allows a 'use server' file to export async functions. A full
 * `next build` (Turbopack) rejects a non-async export there and fails the WHOLE
 * module ("no exports at all"), and jest, tsc and eslint don't enforce that
 * rule, so only the build catches it. This leaf module is plain (no 'use server'), so the const is legal here and both
 * the server action and the client UI can import it.
 *
 * CONNECTS TO: journal-export.ts (sets sourceLabel from this) and
 * features/month-end-close/index.tsx (renders it as the pre-load fallback).
 */

/** The honest one-liner describing where this data comes from. */
export const AUDIT_SOURCE_LABEL =
  'Source: internal usage events, not linked to provider invoices'
