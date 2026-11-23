/**
 * The pure key-row view
 * model, tested for real. Pins the rule: a secret key's
 * display value is the server's stub passed through UNTOUCHED (never
 * sliced, never copyable), and only publishable plaintext ever becomes a
 * reveal/copy payload.
 */

import {
  KEY_STATUS_CHIPS,
  keyCellModel,
  keyTypeLabel,
  lastUsedLabel,
} from '../components/api-key-display'

describe('keyCellModel — key masking reproduced exactly', () => {
  it('secret key: the server stub renders verbatim, no slicing, no copy value', () => {
    const cell = keyCellModel({
      keyType: 'secret',
      apiKeyPlaintext: 'mf_sk_...91cd',
    })
    expect(cell.masked).toBe('mf_sk_...91cd')
    expect(cell.full).toBeNull()
  })

  it('secret key with no stored value (hash-only at rest) → em dash, no copy', () => {
    const cell = keyCellModel({ keyType: 'secret', apiKeyPlaintext: undefined })
    expect(cell.masked).toBe('—')
    expect(cell.full).toBeNull()
  })

  it('publishable key: masks for display but carries the full plaintext for copy', () => {
    const plaintext = 'mf_pk_AbCdEfGhIjKlMnOpQrStUvWxYz012345'
    const cell = keyCellModel({
      keyType: 'publishable',
      apiKeyPlaintext: plaintext,
    })
    expect(cell.full).toBe(plaintext)
    expect(cell.masked).not.toBe(plaintext)
    expect(cell.masked.startsWith('mf_pk_')).toBe(true)
    expect(cell.masked).toContain('•')
    expect(cell.masked.endsWith(plaintext.slice(-4))).toBe(true)
  })

  it('publishable key whose random half contains underscores stays masked', () => {
    // base64url includes '_', so a lastIndexOf('_') cut would put the random
    // half on screen. Fixture is obviously fake.
    const plaintext = 'mf_pk_AAAA_BBBB_CCCC_DDDD_EEEE_FFFF_GH12'
    const cell = keyCellModel({
      keyType: 'publishable',
      apiKeyPlaintext: plaintext,
    })
    expect(cell.masked.startsWith('mf_pk_')).toBe(true)
    expect(cell.masked).toBe(`mf_pk_${'•'.repeat(12)}GH12`)
    expect(cell.masked).not.toContain('AAAA')
    expect(cell.masked).not.toContain('FFFF')
  })

  it('publishable key ending in an underscore does not render unmasked', () => {
    const plaintext = 'mf_pk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH_'
    const cell = keyCellModel({
      keyType: 'publishable',
      apiKeyPlaintext: plaintext,
    })
    expect(cell.masked).not.toBe(plaintext)
    expect(cell.masked).toBe(`mf_pk_${'•'.repeat(12)}HHH_`)
  })

  it('an unrecognized value masks entirely rather than guessing a prefix', () => {
    const cell = keyCellModel({
      keyType: 'publishable',
      apiKeyPlaintext: 'no_known_prefix_here_at_all',
    })
    expect(cell.masked).toBe('•'.repeat(20))
  })

  it('publishable key with no stored value → em dash, no copy', () => {
    const cell = keyCellModel({
      keyType: 'publishable',
      apiKeyPlaintext: undefined,
    })
    expect(cell.masked).toBe('—')
    expect(cell.full).toBeNull()
  })
})

describe('keyTypeLabel — the honest Type column', () => {
  it('pins both labels', () => {
    expect(keyTypeLabel('secret')).toBe('Secret · server-side')
    expect(keyTypeLabel('publishable')).toBe('Publishable · frontend-safe')
  })

  it("invents no live/test segment and no read-write scope — real keys don't have them", () => {
    for (const label of [keyTypeLabel('secret'), keyTypeLabel('publishable')]) {
      expect(label).not.toMatch(/live|test/i)
      expect(label).not.toMatch(/read/i)
    }
  })
})

describe('lastUsedLabel — honest when null', () => {
  it("null → 'Never used', not a fabricated date", () => {
    expect(lastUsedLabel(null)).toBe('Never used')
  })

  it('a real timestamp renders relative', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    expect(lastUsedLabel(twoHoursAgo)).toMatch(/ago$/)
  })
})

describe('KEY_STATUS_CHIPS — only the states the database can hold', () => {
  it('offers exactly the two enum_api_keys_status values', () => {
    expect(Object.keys(KEY_STATUS_CHIPS).sort()).toEqual(['active', 'revoked'])
  })

  it('offers no expired chip — the enum has no such value to render', () => {
    expect('expired' in KEY_STATUS_CHIPS).toBe(false)
  })
})
