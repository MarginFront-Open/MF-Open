import { internalEmailDomains, isInternalEmail } from '../internal-email'

describe('internalEmailDomains', () => {
  test('is empty when nothing is configured', () => {
    expect(internalEmailDomains(undefined)).toEqual([])
    expect(internalEmailDomains(' , ')).toEqual([])
  })

  test('trims, lowercases and drops a leading @', () => {
    expect(internalEmailDomains(' Team.Example, @ops.example ')).toEqual([
      'team.example',
      'ops.example',
    ])
  })
})

describe('isInternalEmail', () => {
  const domains = ['team.example']

  test('marks nobody internal when no domains are configured', () => {
    expect(isInternalEmail('someone@team.example', [])).toBe(false)
  })

  test('matches the domain and its subdomains, any case', () => {
    expect(isInternalEmail('someone@team.example', domains)).toBe(true)
    expect(isInternalEmail('Someone@Mail.Team.Example', domains)).toBe(true)
  })

  test('does not match lookalike domains or empty input', () => {
    expect(isInternalEmail('someone@notteam.example', domains)).toBe(false)
    expect(isInternalEmail('someone@team.example.net', domains)).toBe(false)
    expect(isInternalEmail(null, domains)).toBe(false)
    expect(isInternalEmail('no-at-sign', domains)).toBe(false)
  })
})
