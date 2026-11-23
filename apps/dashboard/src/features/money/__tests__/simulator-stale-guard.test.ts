import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The debounced real-time recompute calls the async projectPricing action, so
 * an out-of-order resolve (a slow earlier request finishing after a fast later
 * one) must NOT overwrite the current projection with a stale number, or the
 * user would read a price that doesn't match the inputs on screen. Node-only
 * source-assertion (no RTL);
 * pins the `cancelled` guard so a future edit can't silently drop it.
 */
describe('money-simulator-tab — recompute stale-response guard', () => {
  const src = readFileSync(
    join(__dirname, '..', 'components', 'money-simulator-tab.tsx'),
    'utf8'
  )

  it('guards the projectPricing response on `cancelled` before writing state', () => {
    const start = src.indexOf('projectPricing({ plans: selectedPlans')
    const end = src.indexOf('}, [selectedPlans, activity, actualCost])')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const effect = src.slice(start, end)

    const guardIdx = effect.indexOf('if (cancelled) return')
    const writeIdx = effect.indexOf('setProjections(res.data)')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(-1)
    // the guard must come before the state write
    expect(guardIdx).toBeLessThan(writeIdx)
    // and the cleanup must flip it
    expect(effect).toMatch(/cancelled = true/)
  })
})
