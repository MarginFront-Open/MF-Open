/**
 * Invoice write actions (Finalize, Mark as Paid, Void) render only for roles
 * that can manage money, so a plain member never clicks into a server
 * refusal toast. Source-assertion (this repo's jest is node-only, no RTL):
 * canManageMoney() must gate all three mutating buttons. PrintButton is non-mutating and must stay ungated. Cosmetic
 * only — assertMoneyManager stays the real enforcer.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', 'InvoiceActions.tsx'), 'utf8')

describe('InvoiceActions.tsx — money-write actions gated by canManageMoney', () => {
  it('imports canManageMoney and reads the role via useCurrentOrganization', () => {
    expect(src).toMatch(
      /import \{ canManageMoney \} from '@\/lib\/permissions'/
    )
    expect(src).toMatch(
      /import \{ useCurrentOrganization \} from '@\/hooks\/use-auth'/
    )
  })

  it.each(['MarkPaidButton', 'VoidButton', 'FinalizeButton'])(
    '%s early-returns null when canManageMoney(organization?.role) is false',
    (componentName) => {
      const start = src.indexOf(`export function ${componentName}(`)
      expect(start).toBeGreaterThan(-1)
      const nextComponent = src.indexOf('export function', start + 1)
      const body = src.slice(
        start,
        nextComponent === -1 ? undefined : nextComponent
      )
      expect(body).toMatch(/useCurrentOrganization\(\)/)
      expect(body).toMatch(/!canManageMoney\(organization\?\.role\)/)
    }
  )

  it('PrintButton stays ungated — printing does not mutate the invoice', () => {
    const start = src.indexOf('export function PrintButton(')
    const nextComponent = src.indexOf('export function InvoiceActions(', start)
    const body = src.slice(start, nextComponent)
    expect(body).not.toMatch(/canManageMoney/)
  })
})
