import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The customer edit form must not require Email: real customers can have a
 * null email, and once set an email must be clearable back to null. jest
 * here is node-only (no RTL),
 * so this is a source-assertion plus a check on the server action that empty
 * clears to null.
 */
const formSrc = readFileSync(
  join(__dirname, '..', 'update-customer-form.tsx'),
  'utf8'
)

// The email <Input …/> block, isolated from the rest of the form.
const emailInputBlock = (() => {
  const start = formSrc.indexOf("id='email'")
  if (start === -1) throw new Error('email input not found in the form')
  const end = formSrc.indexOf('/>', start)
  return formSrc.slice(start, end)
})()

describe('UpdateCustomerForm: email is optional', () => {
  it('the email input has no `required` attribute', () => {
    expect(emailInputBlock).not.toMatch(/\brequired\b/)
  })

  it('still validates format when non-empty (keeps type="email")', () => {
    expect(emailInputBlock).toMatch(/type='email'/)
  })

  it('Name stays required; only Email is optional', () => {
    const nameStart = formSrc.indexOf("id='name'")
    const nameBlock = formSrc.slice(nameStart, formSrc.indexOf('/>', nameStart))
    expect(nameBlock).toMatch(/\brequired\b/)
  })
})

describe('updateCustomer server action — empty email clears to null, not ""', () => {
  // __dirname → src/features/customers/components/__tests__; five levels up is
  // apps/dashboard, where app/ sits as a sibling of src/.
  const actionSrc = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'app',
      'actions',
      'customers.ts'
    ),
    'utf8'
  )

  it('normalizes an empty email to null while skipping an absent key', () => {
    expect(actionSrc).toMatch(
      /email:\s*data\.email\s*!==\s*undefined\s*\?\s*data\.email\s*\|\|\s*null\s*:\s*undefined/
    )
  })
})
