/**
 * WHAT THIS FILE DOES: Pins the Month-End Close page copy:
 *     - the "Coverage score" headline card has an InfoTooltip, like its
 *       two sibling cards.
 *     - the two "uncategorized" explainer strings use an explicit {' '}
 *       between the dollar amount and the next word, so the space can't be
 *       collapsed by the build toolchain ("$6.11is still ..." with the space
 *       missing).
 *   Also asserts the tooltipDefinitions.defensibilityScore copy exists.
 * WHY IT IS A SOURCE-ASSERTION TEST: the
 *   dashboard jest suite is node-only (no jsdom/RTL), so we read the source as
 *   text rather than rendering. The tooltip-definitions check imports the real
 *   record (pure data, no DOM) and asserts the key + key phrases.
 *
 * CONNECTS TO: ../index.tsx (the Month-End Close page) and
 *   ../../../../lib/tooltip-definitions.ts (the shared tooltip record).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

const pageSource = readFileSync(join(__dirname, '../index.tsx'), 'utf8')

describe('Defensibility score has a tooltip', () => {
  it('renders the defensibilityScore InfoTooltip on the card', () => {
    expect(pageSource).toContain(
      'InfoTooltip {...tooltipDefinitions.defensibilityScore}'
    )
  })

  it('defines the defensibilityScore tooltip with the 60/25/15 weighting', () => {
    const def = tooltipDefinitions.defensibilityScore
    expect(def).toBeDefined()
    // The title reads "Coverage score" while the object key stays
    // defensibilityScore, which the InfoTooltip assertion above relies on.
    expect(def.title).toMatch(/coverage/i)
    expect(def.description).toContain('60%')
    expect(def.description).toContain('25%')
    expect(def.description).toContain('15%')
  })
})

describe('uncategorized explainers use an explicit space', () => {
  it('makes the space explicit before "still" (AI gross margin card)', () => {
    expect(pageSource).toContain("unclassifiedCost)}{' '}still")
  })

  it('makes the space explicit before "is still" (P&L category card)', () => {
    expect(pageSource).toContain("unclassifiedCost)}{' '}is still")
  })

  it('never relies on an implicit JSX space after the amount', () => {
    expect(pageSource).not.toMatch(/unclassifiedCost\)}\s+still/)
    expect(pageSource).not.toMatch(/unclassifiedCost\)}\s+is still/)
  })
})
