import { safeRedirectPath } from '../safe-redirect'

describe('safeRedirectPath', () => {
  it.each([
    ['/money', '/money'],
    ['/invite/accept/abc-123', '/invite/accept/abc-123'],
    ['/customers?tab=active#top', '/customers?tab=active#top'],
    ['/', '/'],
    ['/customers/../money', '/money'],
    ['/a//b', '/a//b'],
  ])('keeps the same-site path %s', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected)
  })

  it.each([
    ['a full URL to another site', 'https://evil.example/login'],
    ['a protocol-relative URL', '//evil.example/login'],
    ['a backslash variant browsers read as //', '/\\evil.example'],
    ['a backslash later in the path', '/\\/evil.example'],
    ['a tab browsers strip, leaving //', '/\t/evil.example'],
    ['a newline browsers strip, leaving //', '/\n/evil.example'],
    ['a parent segment that collapses to //', '/..//evil.example/login'],
    ['a current-dir segment that collapses to //', '/.//evil.example'],
    ['a later parent segment that collapses to //', '/x/..//evil.example'],
    ['an encoded parent segment that collapses to //', '/%2e%2e//evil.example'],
    ['an encoded current-dir segment', '/%2E//evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a path without a leading slash', 'money'],
    [
      'another site that only mentions the invite path',
      'https://evil.example/invite/accept/abc',
    ],
    ['an empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(safeRedirectPath(input)).toBeNull()
  })

  it('rejects null and undefined', () => {
    expect(safeRedirectPath(null)).toBeNull()
    expect(safeRedirectPath(undefined)).toBeNull()
  })
})
