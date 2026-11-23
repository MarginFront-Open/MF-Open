/**
 * Two clicks dispatched in the same JS tick both run handleSubmit and
 * would create TWO plans. A state-based `if (isSubmitting)
 * return` guard doesn't close this because setState hasn't flushed within
 * the same tick. Source-assertion (this repo's jest is node-only, no RTL),
 * same idiom as minimum-commitment-render.test.ts in the sibling [planId]
 * page: reads the real source and pins the synchronous ref guard plus the
 * disabled wiring on the submit button.
 */

import { readFileSync } from 'fs'
import path from 'path'

const pageSource = readFileSync(path.join(__dirname, '../page.tsx'), 'utf-8')

describe('pricing-plans/new page — handleSubmit re-entrancy guard', () => {
  it('declares a synchronous submittingRef, not just the isSubmitting state', () => {
    expect(pageSource).toMatch(/useRef\(false\)/)
    expect(pageSource).toMatch(/submittingRef\.current/)
  })

  it('handleSubmit bails out synchronously when submittingRef is already set', () => {
    const start = pageSource.indexOf('const handleSubmit')
    expect(start).toBeGreaterThan(-1)
    const nextFn = pageSource.indexOf('\n  const ', start + 1)
    const body = pageSource.slice(start, nextFn === -1 ? undefined : nextFn)
    expect(body).toMatch(/if \(submittingRef\.current\) return/)
    expect(body).toMatch(/submittingRef\.current = true/)
  })

  it('resets submittingRef on the validation-fail early-return and in the finally block', () => {
    const start = pageSource.indexOf('const handleSubmit')
    const nextFn = pageSource.indexOf('\n  const ', start + 1)
    const body = pageSource.slice(start, nextFn === -1 ? undefined : nextFn)
    const resets = body.match(/submittingRef\.current = false/g) || []
    expect(resets.length).toBeGreaterThanOrEqual(2)
    expect(body).toMatch(/finally \{\s*setIsSubmitting\(false\)\s*submittingRef\.current = false/)
  })

  it('wires the submit button disabled prop to isSubmitting', () => {
    expect(pageSource).toMatch(/type='submit'[\s\S]{0,120}disabled=\{isSubmitting/)
  })
})
