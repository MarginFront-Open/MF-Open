/**
 * Session-replay secret masking. Sentry replay masks every input, and masks
 * text too unless the operator sets NEXT_PUBLIC_SENTRY_REPLAY_UNMASK. With text
 * unmasked, a secret rendered as TEXT is captured verbatim unless its element
 * carries sentry-mask (one of Sentry replay's default mask selectors).
 * Source-assertion (this repo's jest is node-only, no RTL): a refactor that
 * drops one has to fail here, not in a replay six weeks later.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const read = (...segments: string[]) =>
  readFileSync(join(__dirname, '..', ...segments), 'utf8')

const createKeyPairSheetSrc = read(
  'features',
  'developer-zone',
  'api-keys',
  'create-key-pair-sheet.tsx'
)
const sdkSimulatorSrc = read(
  'features',
  'developer-zone',
  'sdk-simulator',
  'index.tsx'
)
const portalLinkDialogSrc = read(
  'features',
  'customer-portal',
  'SendPortalLinkDialog.tsx'
)
const apiKeysTabSrc = read(
  'features',
  'build',
  'components',
  'api-keys-tab.tsx'
)

describe('create-key-pair-sheet.tsx — the one-time secret reveal', () => {
  it('masks the element that renders the full mf_sk_ secret', () => {
    expect(createKeyPairSheetSrc).toMatch(
      /<code className='sentry-mask[^']*'>\s*\{createdPair\.secretKey\.apiKeyPlaintext\}/
    )
  })

  it('still renders the secret as TEXT, which is why an input-level mask would not have covered it', () => {
    // Guards the premise of the text mask: if this ever becomes an <input>, the
    // maskInputOptions config becomes relevant and this test should be revisited.
    expect(createKeyPairSheetSrc).toMatch(
      /<code[^>]*>\s*\{createdPair\.secretKey\.apiKeyPlaintext\}\s*<\/code>/
    )
  })

  it('masks the publishable key too — mf_pk_ caps WRITES only, so every org read is open to it', () => {
    expect(createKeyPairSheetSrc).toMatch(
      /<code className='sentry-mask[^']*'>\s*\{createdPair\.publishableKey\.apiKeyPlaintext\}/
    )
  })

  it('never echoes a key value in the copy-confirmation toast', () => {
    expect(createKeyPairSheetSrc).toMatch(
      /description: 'API key has been copied to your clipboard\.'/
    )
    expect(createKeyPairSheetSrc).not.toMatch(
      /description: `[^`]*apiKeyPlaintext/
    )
  })
})

describe('sdk-simulator — the pasted secret key input', () => {
  it('masks the key input, which the eye toggle flips to type=text', () => {
    expect(sdkSimulatorSrc).toMatch(
      /id='sdk-secret-key'\s*\n\s*type=\{showApiKey \? 'text' : 'password'\}\s*\n\s*className='sentry-mask/
    )
  })

  it('keeps the generated snippet on the masked key, never the pasted one', () => {
    expect(sdkSimulatorSrc).toMatch(/apiKey: '\$\{maskedKey\}'/)
  })

  it('derives the mask from the fixed prefix, never lastIndexOf on an underscore', () => {
    // An underscore cut can land inside base64url random data. maskKeyForPreview
    // is the tested primitive; see api-key-mask.test.ts for the behavior.
    expect(sdkSimulatorSrc).toMatch(
      /maskedKey = trimmedKey\s*\?\s*maskKeyForPreview\(trimmedKey\)/
    )
    expect(sdkSimulatorSrc).not.toMatch(/lastIndexOf\('_'\)/)
  })

  it('masks the code preview, which embeds that mask on a recorded route', () => {
    expect(sdkSimulatorSrc).toMatch(
      /<pre className='sentry-mask[^']*'>\s*<code>\{codePreview\}<\/code>/
    )
  })
})

describe('api-keys-tab.tsx — the /build key table reveal', () => {
  it('masks the key cell, which the reveal button swaps to the full publishable key', () => {
    expect(apiKeysTabSrc).toMatch(
      /<code className='sentry-mask[^']*'>\s*\{cell\.full && revealedKeyId === key\.id/
    )
  })

  it('never offers a reveal for secret keys — keyCellModel returns full:null for them', () => {
    const displaySrc = read(
      'features',
      'build',
      'components',
      'api-key-display.ts'
    )
    expect(displaySrc).toMatch(
      /if \(key\.keyType === 'secret'\) \{\s*return \{ masked: key\.apiKeyPlaintext, full: null \}/
    )
  })
})

describe('SendPortalLinkDialog.tsx — the single-use portal link', () => {
  it('masks the container holding the tokenized portal URL', () => {
    expect(portalLinkDialogSrc).toMatch(
      /className='sentry-mask[^']*'>\s*<span[^>]*>\{portalUrl\}<\/span>/
    )
  })
})
