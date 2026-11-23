import { readFileSync } from 'fs'
import { join } from 'path'

describe('brand names in src/config', () => {
  it('base.json app/company display names say MarginFront', () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, '..', 'environments', 'base.json'), 'utf8')
    )
    expect(json.app.name).toBe('MarginFront Dashboard')
    expect(json.company.name).toBe('MarginFront')
  })

  it('names the persisted auth token storage key after MarginFront', () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, '..', 'environments', 'base.json'), 'utf8')
    )
    expect(json.auth.tokenStorageKey).toBe('marginfront_access_token')
  })
})
