/**
 * The role select shows only the role name: description lines would spill out
 * of the 130px select. Node-only jest can't render the client component, so
 * we assert against SOURCE.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(
  join(__dirname, '..', 'member-role-select.tsx'),
  'utf8'
)

describe('member-role-select role names', () => {
  it.each(['member', 'finance', 'developer', 'admin', 'owner'])(
    'offers a <SelectItem value="%s">',
    (role) => {
      expect(SRC).toContain(`value='${role}'`)
    }
  )

  it.each([
    ['member', 'Member'],
    ['finance', 'Finance'],
    ['developer', 'Developer'],
    ['admin', 'Admin'],
    ['owner', 'Owner'],
  ])('%s renders as the bare role name, no description line', (role, label) => {
    expect(SRC).toContain(`<SelectItem value='${role}'>${label}</SelectItem>`)
  })

  it('renders no role description copy', () => {
    for (const removed of [
      /Views all financials/,
      /Manages build/,
      /no money/,
      /no team/,
    ]) {
      expect(SRC).not.toMatch(removed)
    }
  })

  it('the developer cast union includes developer (writes the role column)', () => {
    expect(SRC).toMatch(/'developer'/)
  })
})
