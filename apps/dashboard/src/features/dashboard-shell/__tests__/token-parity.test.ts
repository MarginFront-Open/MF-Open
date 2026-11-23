/**
 * Src/index.css is the runtime source of
 * truth for the --mf-* tokens; mf-tokens.ts's MF_THEME_DARK/MF_THEME_LIGHT/
 * MF_RADII are its TS twin, kept only for the preview route's swatch sheet
 * and this test. Parses the CSS block directly and
 * asserts byte-for-byte equality against the twin, so a hex tweak on either
 * side without the other fails here instead of drifting silently.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  MF_RADII,
  MF_THEME_DARK,
  MF_THEME_LIGHT,
  MF_TOKEN_NAMES,
} from '../mf-tokens'

const CSS = readFileSync(join(__dirname, '..', '..', '..', 'index.css'), 'utf8')

// The --mf-* block follows this comment marker in index.css. Slicing from
// here reads that block, not the hsl()-based :root/.dark tokens earlier in
// the same file.
const MARKER = 'MF SHELL TOKENS'
const markerIndex = CSS.indexOf(MARKER)
if (markerIndex === -1) {
  throw new Error(
    `token-parity.test.ts: could not find the "${MARKER}" marker in src/index.css. Has the token block moved or been renamed?`
  )
}
const SHELL_CSS = CSS.slice(markerIndex)

function parseVars(cssBlock: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /--mf-([\w-]+):\s*([^;]+);/g
  let match: RegExpExecArray | null
  while ((match = re.exec(cssBlock))) {
    out[match[1]] = match[2].trim()
  }
  return out
}

const lightBlockMatch = SHELL_CSS.match(/:root,\s*\.light\s*\{([^}]*)\}/)
const darkBlockMatch = SHELL_CSS.match(/\.dark\s*\{([^}]*)\}/)

if (!lightBlockMatch || !darkBlockMatch) {
  throw new Error(
    'token-parity.test.ts: could not find the ":root, .light { ... }" / ".dark { ... }" --mf-* blocks in src/index.css.'
  )
}

const cssLight = parseVars(lightBlockMatch[1])
const cssDark = parseVars(darkBlockMatch[1])

const RADIUS_CSS_TO_TS: Array<[string, keyof typeof MF_RADII]> = [
  ['radius-card', 'card'],
  ['radius-inner', 'inner'],
  ['radius-seg', 'seg'],
  ['radius-seg-item', 'segItem'],
]

describe('key-set parity', () => {
  it('MF_THEME_DARK and MF_THEME_LIGHT declare exactly MF_TOKEN_NAMES', () => {
    expect(Object.keys(MF_THEME_DARK).sort()).toEqual(
      [...MF_TOKEN_NAMES].sort()
    )
    expect(Object.keys(MF_THEME_LIGHT).sort()).toEqual(
      [...MF_TOKEN_NAMES].sort()
    )
  })

  it('index.css :root,.light declares the MF_TOKEN_NAMES colors plus the 4 radii', () => {
    const expectedKeys = [
      ...MF_TOKEN_NAMES,
      ...RADIUS_CSS_TO_TS.map(([cssKey]) => cssKey),
    ]
    expect(Object.keys(cssLight).sort()).toEqual(expectedKeys.sort())
  })

  it('index.css .dark declares exactly the MF_TOKEN_NAMES colors (radii are theme-invariant, not repeated)', () => {
    expect(Object.keys(cssDark).sort()).toEqual([...MF_TOKEN_NAMES].sort())
  })
})

describe('CSS ↔ TS byte-for-byte value parity', () => {
  it.each(MF_TOKEN_NAMES)('--mf-%s matches MF_THEME_LIGHT verbatim', (name) => {
    expect(cssLight[name]).toBe(MF_THEME_LIGHT[name])
  })

  it.each(MF_TOKEN_NAMES)('--mf-%s matches MF_THEME_DARK verbatim', (name) => {
    expect(cssDark[name]).toBe(MF_THEME_DARK[name])
  })
})

describe('radii parity', () => {
  it.each(RADIUS_CSS_TO_TS)(
    '--mf-%s matches MF_RADII.%s verbatim',
    (cssKey, tsKey) => {
      expect(cssLight[cssKey]).toBe(MF_RADII[tsKey])
    }
  )
})
