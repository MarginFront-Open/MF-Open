/**
 * Two clicks in the same JS tick must not create two customers: React Query's
 * isPending (and any setState-based flag) hasn't flushed within the tick, so
 * only a synchronous ref can close the race (the pricing-plan form uses the
 * same guard). Source assertions: node-only jest, no RTL.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const formSource = readFileSync(
  join(__dirname, '..', 'create-customer-form.tsx'),
  'utf8'
)

describe('create-customer-form double-submit guard', () => {
  it('declares a synchronous submitting ref', () => {
    expect(formSource).toMatch(/const submittingRef = useRef\(false\)/)
  })

  it('bails synchronously before any submit work', () => {
    const guard = formSource.indexOf('if (submittingRef.current) return')
    const setTrue = formSource.indexOf('submittingRef.current = true')
    const mutateCall = formSource.indexOf('createCustomer(submissionData')
    expect(guard).toBeGreaterThan(-1)
    expect(setTrue).toBeGreaterThan(guard)
    expect(mutateCall).toBeGreaterThan(setTrue)
  })

  it('resets the guard on validation failure and when the mutation settles', () => {
    const resets = formSource.match(/submittingRef\.current = false/g) ?? []
    expect(resets.length).toBeGreaterThanOrEqual(2)
    expect(formSource).toMatch(
      /onSettled: \(\) => \{\s*submittingRef\.current = false/
    )
  })
})
