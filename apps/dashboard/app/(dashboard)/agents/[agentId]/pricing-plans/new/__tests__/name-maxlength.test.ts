import { readFileSync } from 'fs'
import path from 'path'

/**
 * pricing_plans.name is VARCHAR(255) (packages/db/prisma/schema.prisma).
 * Without a maxLength on the create form's Plan Name input, a longer name
 * fails only at the DB with a generic "Failed to create..." toast.
 * Source-assertion (this repo's jest is node-only, no RTL).
 */
const pageSource = readFileSync(path.join(__dirname, '../page.tsx'), 'utf-8')

const nameInputBlock = (() => {
  const start = pageSource.indexOf("id='name'")
  if (start === -1) throw new Error('name input not found on the page')
  return pageSource.slice(start, pageSource.indexOf('/>', start))
})()

describe('pricing-plans/new page — Plan Name input is capped to the DB column width', () => {
  it('carries maxLength={255}, matching pricing_plans.name VARCHAR(255)', () => {
    expect(nameInputBlock).toMatch(/maxLength=\{255\}/)
  })
})
