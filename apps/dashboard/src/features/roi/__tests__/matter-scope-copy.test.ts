/**
 * The scope copy, pinned. Dashboard jest is node-only with no
 * React Testing Library, so the rendered strings are pinned by asserting on
 * source (the card-copy-single-source idiom in this directory) and the
 * builder itself is exercised as the pure function it is.
 *
 * Two sentences carry the whole honesty story here:
 *   - scoped:  "<number>, this goal's window" — the Matters page shows a work
 *              item all-time, a goal is windowed, so the subtitle says which
 *              window you are looking at.
 *   - orphaned: the work item was deleted, the goal fell back to org-wide
 *              reads, and the card says so instead of quietly changing what
 *              it means.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { matterScopeLabel, SCOPE_HELPER_COPY } from '../progress-derivation'
import {
  WORK_ITEM_NOUN,
  WORK_ITEM_NOUN_SENTENCE_CASE,
} from '@/lib/work-item-noun'

const FEATURE_DIR = join(__dirname, '..')
const read = (...parts: string[]) =>
  readFileSync(join(FEATURE_DIR, ...parts), 'utf8')

const dialogSrc = read('components', 'initiative-dialog.tsx')
const cardSrc = read('components', 'initiative-card.tsx')
const detailSrc = read('detail.tsx')
const printSrc = read('components', 'board-ready-export.tsx')

const flat = (src: string) => src.replace(/\s+/g, ' ')

describe('matterScopeLabel — the one builder behind every scope subtitle', () => {
  it('names the work item and the window when the scope is live', () => {
    expect(
      matterScopeLabel({
        matterId: 'matter-1',
        matterNumber: '2026-0031',
        scopedMatterNumber: '2026-0031',
      })
    ).toBe("Work item 2026-0031, this goal's window")
  })

  it('says the work item was deleted when only the recorded number is left', () => {
    expect(
      matterScopeLabel({
        matterId: null,
        matterNumber: null,
        scopedMatterNumber: '2026-0031',
      })
    ).toBe(
      'Whole organization (the work item this goal pointed at was deleted)'
    )
  })

  it('a goal that never had a scope gets no subtitle at all', () => {
    expect(
      matterScopeLabel({
        matterId: null,
        matterNumber: null,
        scopedMatterNumber: null,
      })
    ).toBeNull()
  })

  it('reads the live number, not the recorded one, when the work item was renumbered', () => {
    expect(
      matterScopeLabel({
        matterId: 'matter-1',
        matterNumber: '2026-0099',
        scopedMatterNumber: '2026-0031',
      })
    ).toBe("Work item 2026-0099, this goal's window")
  })

  it('spends the shared noun so a later rename is one line', () => {
    expect(WORK_ITEM_NOUN).toBe('work item')
    expect(WORK_ITEM_NOUN_SENTENCE_CASE).toBe('Work item')
    expect(
      matterScopeLabel({
        matterId: null,
        matterNumber: null,
        scopedMatterNumber: '2026-0031',
      })
    ).toContain(WORK_ITEM_NOUN)
  })

  it('the scoped line says what the number IS, so a board reader is not guessing', () => {
    const scoped = matterScopeLabel({
      matterId: 'matter-1',
      matterNumber: '2026-0031',
      scopedMatterNumber: '2026-0031',
    })!
    expect(scoped.startsWith(`${WORK_ITEM_NOUN_SENTENCE_CASE} `)).toBe(true)
    expect(scoped).not.toMatch(/^\d/)
  })
})

describe('the dialog offers the scope select with an honest default', () => {
  it('the default option names the whole organization in plain English', () => {
    expect(flat(dialogSrc)).toContain('Whole organization')
    expect(flat(dialogSrc)).not.toContain('No matter (whole organization)')
  })

  it('the select is fed by the shipped getMatters action, not a new read', () => {
    expect(dialogSrc).toMatch(/getMatters/)
    expect(dialogSrc).toMatch(/from '@\/app\/actions\/matters'/)
  })

  it('the field names what survives a scope, not just what does not', () => {
    expect(SCOPE_HELPER_COPY).toBe(
      "Narrowed to one work item, you get that work item's cost, usage events and average cost per usage event. Everything else, including revenue, margin, MRR, customer counts, unmapped items and the internal/external cost split, can't be broken out per work item, so it shows a dash."
    )
    expect(dialogSrc).toContain('{SCOPE_HELPER_COPY}')
  })

  it('does not promise that "the cost numbers" survive, plural and unqualified', () => {
    expect(flat(dialogSrc)).not.toContain(
      'the cost numbers count only that matter'
    )
    expect(SCOPE_HELPER_COPY).not.toMatch(
      /\b(matter|matters|legal|law|firm|firms|case|cases)\b/i
    )
  })
})

describe('card, detail and print all render the subtitle through the builder', () => {
  const surfaces: Array<[string, string]> = [
    ['components/initiative-card.tsx', cardSrc],
    ['detail.tsx', detailSrc],
    ['components/board-ready-export.tsx', printSrc],
  ]

  it.each(surfaces)('%s calls matterScopeLabel', (_name, src) => {
    expect(src).toMatch(/matterScopeLabel\(/)
  })

  it.each(surfaces)('%s never inlines either sentence itself', (_name, src) => {
    expect(flat(src)).not.toContain("this goal's window")
    expect(flat(src)).not.toContain('was deleted)')
  })
})
