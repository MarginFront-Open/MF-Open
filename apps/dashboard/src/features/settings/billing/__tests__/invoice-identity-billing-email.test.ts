import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Exactly ONE user-visible billing email — the
 * "Billing email" field on the Invoice identity card (billingIdentity.email).
 * There is no second field writing organizations.billing_email. Source
 * assertions, not a render test (dashboard jest is node-only, no RTL).
 */
describe('/settings/billing — ONE Billing email field', () => {
  const cardSrc = readFileSync(
    join(__dirname, '..', 'invoice-identity-card.tsx'),
    'utf8'
  )
  // JSX wraps prose across lines; collapse whitespace so copy assertions
  // survive reformatting.
  const cardCopy = cardSrc.replace(/\s+/g, ' ')
  const pageSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('the Invoice identity card carries the one Billing email field', () => {
    expect(cardSrc).toMatch(/label: 'Billing email'/)
  })

  it('helper text explains both jobs of the address in plain English', () => {
    expect(cardCopy).toMatch(
      /shown to your customers on invoices as the contact address/i
    )
    expect(cardCopy).toMatch(
      /where MarginFront sends you billing notifications/i
    )
  })

  it('there is no second Billing email card', () => {
    expect(pageSrc).not.toMatch(/BillingEmailCard/)
    expect(existsSync(join(__dirname, '..', 'billing-email-card.tsx'))).toBe(
      false
    )
    expect(
      existsSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          '..',
          'app',
          'actions',
          'org-billing-email.ts'
        )
      )
    ).toBe(false)
  })
})
