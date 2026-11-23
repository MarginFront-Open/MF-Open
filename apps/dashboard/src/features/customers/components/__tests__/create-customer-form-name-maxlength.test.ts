import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * customers.name is VARCHAR(255) (packages/db/prisma/schema.prisma), so
 * the create form's Name input carries maxLength 255. Without it, a
 * 2,000-char name fails only at the DB with a generic "Failed to create..."
 * toast. Source
 * assertion (this repo's jest is node-only, no RTL), same isolated-input-
 * block idiom as update-customer-form-email-optional.test.ts.
 */
const formSrc = readFileSync(
  join(__dirname, '..', 'create-customer-form.tsx'),
  'utf8'
)

const nameInputBlock = (() => {
  const start = formSrc.indexOf("id='name'")
  if (start === -1) throw new Error('name input not found in the form')
  return formSrc.slice(start, formSrc.indexOf('/>', start))
})()

describe('CreateCustomerForm — Name input is capped to the DB column width', () => {
  it('carries maxLength={255}, matching customers.name VARCHAR(255)', () => {
    expect(nameInputBlock).toMatch(/maxLength=\{255\}/)
  })
})
