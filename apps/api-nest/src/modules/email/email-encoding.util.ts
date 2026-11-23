/**
 * Render-time output encoding for the transactional email templates.
 *
 * `escapeHtml` encodes the five HTML metacharacters so customer/org-derived
 * free text is inert when interpolated into HTML. `&` is encoded first so the
 * entities we emit aren't re-escaped by the later passes. Encoding happens at
 * render time only — stored data is never mutated.
 *
 * `singleLineSubject` strips CR/LF so a dynamic value can't inject extra lines
 * into the Subject header.
 */

export function escapeHtml(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function singleLineSubject(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/[\r\n]+/g, ' ');
}
