/**
 * Key masking cuts at the FIXED prefix, never at the last underscore.
 *
 * Keys are prefix + base64url(randomBytes(24)), and base64url's alphabet
 * includes '_'. A lastIndexOf('_') cut would leak random characters whenever
 * the random half contains an underscore, and leak the entire key when it
 * ends in one. Every fixture below is obviously fake.
 */

import { keyPrefix, maskKeyForPreview } from '@/lib/api-key-mask'

// The shapes that break an underscore cut: underscores inside the random
// half, and a trailing underscore, which makes lastIndexOf return the very end.
const KEY_WITH_UNDERSCORES = 'mf_sk_AAAA_BBBB_'
const KEY_TRAILING_UNDERSCORE = 'mf_sk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH_'
const PLAIN_KEY = 'mf_pk_AbCdEfGhIjKlMnOpQrStUvWxYz012345'

describe('keyPrefix', () => {
  it.each([
    ['mf_sk_ANYTHING', 'mf_sk_'],
    ['mf_pk_ANYTHING', 'mf_pk_'],
    ['prtl_ANYTHING', 'prtl_'],
  ])('returns the fixed prefix of %s', (input, expected) => {
    expect(keyPrefix(input)).toBe(expected)
  })

  it('returns nothing for an unrecognized string, rather than guessing', () => {
    expect(keyPrefix('not_a_key_at_all')).toBe('')
    expect(keyPrefix('')).toBe('')
  })

  it('never returns more than the prefix, even when the key is full of underscores', () => {
    expect(keyPrefix(KEY_WITH_UNDERSCORES)).toBe('mf_sk_')
    expect(keyPrefix(KEY_TRAILING_UNDERSCORE)).toBe('mf_sk_')
  })
})

describe('maskKeyForPreview — the SDK snippet value', () => {
  it('shows the prefix and asterisks only, for a key whose random half has underscores', () => {
    expect(maskKeyForPreview(KEY_WITH_UNDERSCORES)).toBe('mf_sk_********')
  })

  it('leaks nothing when the random half ENDS in an underscore (the total-leak case)', () => {
    expect(maskKeyForPreview(KEY_TRAILING_UNDERSCORE)).toBe('mf_sk_********')
  })

  it.each([KEY_WITH_UNDERSCORES, KEY_TRAILING_UNDERSCORE, PLAIN_KEY])(
    'emits nothing beyond the prefix and literal asterisks for %s',
    (key) => {
      const prefix = keyPrefix(key)
      const masked = maskKeyForPreview(key)
      expect(masked).toBe(`${prefix}********`)
      // Everything past the prefix is asterisks — no random-half run survives.
      expect(masked.slice(prefix.length)).toMatch(/^\*+$/)
      expect(masked).not.toContain(key.slice(prefix.length, prefix.length + 4))
    }
  )

  it('masks an unrecognized string entirely rather than inventing a prefix', () => {
    expect(maskKeyForPreview('garbage-paste')).toBe('********')
  })
})
