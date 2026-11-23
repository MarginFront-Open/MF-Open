/**
 * Node-env unit tests for the ceiling pre-check. Proves the
 * dashboard surfaces the SERVER's ceiling rule client-side before submit — the
 * helper wraps the same shared @marginfront/db rule the api-nest write path uses.
 */
import {
  preValidateCapCeiling,
  resolveCeilingForProvider,
} from '../cap-ceiling-precheck'

describe('preValidateCapCeiling', () => {
  const orgCeilings = [{ providerScope: 'all', amountUsd: 200 }]

  it('rejects a dev cap above the applicable org ceiling BEFORE the write', () => {
    const r = preValidateCapCeiling({
      scope: 'dev',
      providerScope: 'anthropic',
      amountUsd: 300,
      orgCeilings,
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('org ceiling')
    expect(r.message).toContain('$200')
  })

  it('allows a dev cap at or below the ceiling', () => {
    expect(
      preValidateCapCeiling({
        scope: 'dev',
        providerScope: 'anthropic',
        amountUsd: 150,
        orgCeilings,
      }).ok
    ).toBe(true)
  })

  it('never constrains an org ceiling itself (nothing sits above it)', () => {
    expect(
      preValidateCapCeiling({
        scope: 'org',
        providerScope: 'all',
        amountUsd: 999999,
        orgCeilings,
      }).ok
    ).toBe(true)
  })

  it('has no ceiling to violate when the org has set none', () => {
    expect(
      preValidateCapCeiling({
        scope: 'dev',
        providerScope: 'anthropic',
        amountUsd: 999999,
        orgCeilings: [],
      }).ok
    ).toBe(true)
  })
})

describe('resolveCeilingForProvider', () => {
  it('prefers a same-provider ceiling over the all fallback', () => {
    const ceilings = [
      { providerScope: 'all', amountUsd: 500 },
      { providerScope: 'anthropic', amountUsd: 200 },
    ]
    expect(resolveCeilingForProvider('anthropic', ceilings)).toBe(200)
  })

  it('falls back to the all ceiling for a provider with no specific ceiling', () => {
    const ceilings = [{ providerScope: 'all', amountUsd: 500 }]
    expect(resolveCeilingForProvider('openai', ceilings)).toBe(500)
  })

  it('returns null when nothing applies', () => {
    expect(resolveCeilingForProvider('openai', [])).toBeNull()
  })
})
