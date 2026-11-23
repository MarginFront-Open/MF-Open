/**
 * The revoke confirm dialog must tell the truth about the blast
 * radius. Revoking a SECRET key signs every customer out of the org's
 * billing portal; a dialog that only promises "apps stop authenticating" would
 * turn that into a surprise support ticket. Source-assertion (this repo's jest
 * is node-only, no RTL): the portal-consequence sentence exists, is gated on
 * keyType === 'secret' (a publishable revoke signs nobody out, so it must not
 * threaten to), and carries no em dash or exclamation point.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const tabSrc = readFileSync(
  join(__dirname, '..', 'components', 'api-keys-tab.tsx'),
  'utf8'
)
const serviceSrc = readFileSync(
  join(__dirname, '..', '..', '..', 'services', 'api-keys-service.ts'),
  'utf8'
)

function dialogDescription(): string {
  const start = tabSrc.indexOf('<AlertDialogDescription>')
  const end = tabSrc.indexOf('</AlertDialogDescription>')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return tabSrc.slice(start, end)
}

describe('api-keys-tab.tsx — revoke dialog copy owns the portal blast radius', () => {
  it('warns that portal customers get signed out and need a fresh link', () => {
    const description = dialogDescription()
    expect(description).toMatch(/signed out/)
    expect(description).toMatch(/fresh portal link/)
  })

  it('gates the portal warning on the secret key type (publishable revokes sign nobody out)', () => {
    const description = dialogDescription()
    expect(description).toMatch(/revokeTarget\?\.keyType === 'secret'/)
    const gateIndex = description.indexOf("keyType === 'secret'")
    const warningIndex = description.indexOf('signed out')
    expect(gateIndex).toBeGreaterThan(-1)
    expect(warningIndex).toBeGreaterThan(gateIndex)
  })

  it('keeps the dialog copy free of em dashes and exclamation points', () => {
    const description = dialogDescription()
    expect(description).not.toMatch(/[–—]/)
    expect(description).not.toContain('!')
  })
})

describe('api-keys-service.ts — revoke toast surfaces the honest sign-out count', () => {
  it('reads portalSessionsEnded off the action result, never an invented number', () => {
    expect(serviceSrc).toMatch(/data\.portalSessionsEnded > 0/)
    expect(serviceSrc).toMatch(/Signed out \$\{data\.portalSessionsEnded\}/)
  })

  it('keeps the zero-cascade toast copy unchanged', () => {
    expect(serviceSrc).toContain('API key has been revoked successfully.')
  })
})
