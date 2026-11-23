import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The deactivate/reactivate
 * confirmation dialog. Source-assertion for the JSX wiring; the actual
 * "what's linked" logic (planHasLinkedRecords/linkedRecordsSummary) is pure
 * and covered with real assertions in plans-derivation.test.ts.
 */
describe('plan-activation-dialog.tsx — wiring', () => {
  const src = readFileSync(
    join(__dirname, '..', 'plan-activation-dialog.tsx'),
    'utf8'
  )

  it('uses the shared AlertDialog primitive, not a bespoke modal', () => {
    expect(src).toMatch(/from '@\/components\/ui\/alert-dialog'/)
  })

  it('derives destructive messaging from the shared plans-derivation helpers, not inline duplication', () => {
    expect(src).toMatch(
      /import \{\s*linkedRecordsSummary,\s*planHasLinkedRecords,/
    )
    expect(src).toMatch(/planHasLinkedRecords\(row\)/)
    expect(src).toMatch(/linkedRecordsSummary\(row\)/)
  })

  it('styles the confirm action destructively only for a deactivate with linked records', () => {
    expect(src).toMatch(/!nextActive && hasLinkedRecords/)
    expect(src).toMatch(/bg-destructive/)
  })

  it('never disables the confirm action just because records are linked — this warns, it does not block', () => {
    // The only `disabled` on the confirm action is the in-flight `pending`
    // flag — no `hasLinkedRecords` gate that would make deactivate
    // impossible (that's deletePricingPlan's job, not this dialog's).
    const actionBlock = src.slice(
      src.indexOf('<AlertDialogAction'),
      src.indexOf('</AlertDialogAction>')
    )
    expect(actionBlock).toMatch(/disabled=\{pending\}/)
    expect(actionBlock).not.toMatch(/disabled=\{[^}]*hasLinkedRecords/)
  })
})
