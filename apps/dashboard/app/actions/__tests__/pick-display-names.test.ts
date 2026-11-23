/**
 * The org-facing spelling pick. When an org's
 * window spend arrives under TWO catalog spellings of one canonical model id
 * ('claude-opus-4.1' and 'claude-opus-4-1-20250805' both remap to
 * 'anthropic/claude-opus-4-1'), the card must name the incumbent by the spelling
 * the customer mostly USES (most window spend), not the lexicographic accident —
 * '-' < '.', so a plain lexicographic pick would always show the dash/date form
 * and defeat the customer-spelling intent. Lexicographic order survives only as
 * the final tie-break on exactly equal spend, so the pick stays deterministic.
 */

import { pickDisplayNames } from '../_shared/pick-display-names'

const CANONICAL = 'anthropic/claude-opus-4-1'
const DOT = 'claude-opus-4.1'
const DATED_DASH = 'claude-opus-4-1-20250805'

describe('pickDisplayNames — most-spend wins, lexicographic only on ties', () => {
  it('two spellings of one model: the one carrying MORE window spend wins (dot with $90 beats dated dash with $10)', () => {
    const picked = pickDisplayNames(
      new Map([
        [
          CANONICAL,
          new Map([
            [DATED_DASH, 10],
            [DOT, 90],
          ]),
        ],
      ])
    )
    expect(picked.get(CANONICAL)).toBe(DOT)
  })

  it('the pick is insertion-order independent', () => {
    const picked = pickDisplayNames(
      new Map([
        [
          CANONICAL,
          new Map([
            [DOT, 90],
            [DATED_DASH, 10],
          ]),
        ],
      ])
    )
    expect(picked.get(CANONICAL)).toBe(DOT)
  })

  it('exactly equal spend falls back to lexicographic (deterministic, never random)', () => {
    const picked = pickDisplayNames(
      new Map([
        [
          CANONICAL,
          new Map([
            [DOT, 50],
            [DATED_DASH, 50],
          ]),
        ],
      ])
    )
    // '-' (0x2D) sorts before '.' (0x2E) — the dated dash is the deterministic tie pick.
    expect(picked.get(CANONICAL)).toBe(DATED_DASH)
  })

  it('a single spelling passes straight through, and zero-spend spellings still resolve', () => {
    const picked = pickDisplayNames(
      new Map([
        ['openai/gpt-5', new Map([['gpt-5', 0]])],
        [CANONICAL, new Map([[DOT, 12.34]])],
      ])
    )
    expect(picked.get('openai/gpt-5')).toBe('gpt-5')
    expect(picked.get(CANONICAL)).toBe(DOT)
  })

  it('an empty input yields an empty pick (no invented names)', () => {
    expect(pickDisplayNames(new Map()).size).toBe(0)
  })
})
