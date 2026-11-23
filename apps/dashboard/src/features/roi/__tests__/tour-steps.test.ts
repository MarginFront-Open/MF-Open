/**
 * The guided tour's copy, pinned string by string.
 *
 * WHY IT EXISTS: a tour card is the most-read copy on the page, it is the
 * first thing a new customer sees, and it is written far from every other
 * copy registry. Left unpinned it drifts into the two failure modes this
 * copy keeps out: the vertical's vocabulary, and a
 * pointer that says "above" to a reader whose screen has no above.
 */

import { WORK_ITEM_NOUN } from '@/lib/work-item-noun'
import { WITHOUT_AI_COPY } from '../report-derivation'
import {
  BODY_MAX_CHARS,
  TITLE_MAX_CHARS,
  TOUR_BUTTONS,
  TOUR_CLOSE_LABEL,
  TOUR_FOOTER_LINE,
  TOUR_LAUNCHER_ACCESSIBLE_NAME,
  TOUR_LAUNCHER_LABEL,
  TOUR_MENU_ITEMS,
  TOUR_PLANS,
  TOUR_STORAGE_KEY,
  TOUR_VERSION,
  everyTourStep,
  tourProgressLine,
  type TourStep,
} from '../tour/tour-steps'
import {
  VERTICAL_WORD,
  isWayfindingOffense,
  sentenceCount,
  uncontractedForms,
} from './support/copy-gates'

const steps = everyTourStep()

const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== '')

/** Every string a customer reads, from every plan, plus the fixed chrome. */
function everyTourString(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const step of steps) {
    out.push([`${step.id} title`, step.title])
    out.push([`${step.id} body`, step.body])
    out.push([`${step.id} action`, step.action])
    out.push([`${step.id} missingTargetText`, step.missingTargetText])
  }
  for (const plan of Object.values(TOUR_PLANS)) {
    out.push([`${plan.id} label`, plan.label])
  }
  for (const item of TOUR_MENU_ITEMS) out.push(['menu item', item.label])
  for (const [key, label] of Object.entries(TOUR_BUTTONS)) {
    out.push([`button ${key}`, label])
  }
  out.push(['close label', TOUR_CLOSE_LABEL])
  out.push(['footer', TOUR_FOOTER_LINE])
  out.push(['launcher label', TOUR_LAUNCHER_LABEL])
  out.push(['launcher name', TOUR_LAUNCHER_ACCESSIBLE_NAME])
  out.push(['progress line', tourProgressLine(0, 6)])
  return out
}

const ALL_STRINGS = everyTourString()

describe('the plans have the intended shape', () => {
  it('the core plan runs six steps and ends on the print', () => {
    const core = TOUR_PLANS['first-roi']
    expect(core.steps).toHaveLength(6)
    expect(core.steps.map((step) => step.anchor)).toEqual([
      'date-range',
      'estimate-without-ai',
      'net-line',
      'new-goal',
      'goal-card',
      'print-report',
    ])
    expect(core.steps[5].advanceOn).toBe('print-opened')
    expect(core.auto).toBe(true)
  })

  it('the no-data plan runs two steps and auto-opens', () => {
    const plan = TOUR_PLANS['first-numbers']
    expect(plan.steps).toHaveLength(2)
    expect(plan.auto).toBe(true)
    expect(plan.steps.map((step) => step.anchor)).toEqual([
      'getting-started-nudge',
      'show-me-around',
    ])
  })

  it('the three chapters are short, opt-in, and land on their own tab', () => {
    expect(TOUR_PLANS['read-numbers'].steps).toHaveLength(4)
    expect(TOUR_PLANS['finished-work'].steps).toHaveLength(2)
    expect(TOUR_PLANS['get-it-out'].steps).toHaveLength(2)
    for (const id of ['read-numbers', 'finished-work', 'get-it-out'] as const) {
      const plan = TOUR_PLANS[id]
      expect(plan.auto).toBe(false)
      for (const step of plan.steps) expect(step.advanceOn).toBe('next')
    }
    expect(
      TOUR_PLANS['finished-work'].steps.every((s) => s.tab === 'finished')
    ).toBe(true)
    expect(
      TOUR_PLANS['read-numbers'].steps.every((s) => s.tab === 'summary')
    ).toBe(true)
    expect(
      TOUR_PLANS['get-it-out'].steps.every((s) => s.tab === 'summary')
    ).toBe(true)
  })

  it('no sequence runs past six cards', () => {
    for (const plan of Object.values(TOUR_PLANS)) {
      expect(plan.steps.length).toBeLessThanOrEqual(6)
    }
  })

  it('every step id is unique across every plan', () => {
    const ids = steps.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every step carries an anchor, an action, an advance rule and a fallback', () => {
    for (const step of steps) {
      expect(step.anchor).toMatch(/^[a-z][a-z-]*$/)
      expect(step.action.trim().length).toBeGreaterThan(0)
      expect([
        'next',
        'numbers-saved',
        'goal-created',
        'print-opened',
      ]).toContain(step.advanceOn)
      expect(step.missingTargetText.trim().length).toBeGreaterThan(0)
      expect(['summary', 'finished', 'goals']).toContain(step.tab)
    }
  })

  it('each step names the plan it belongs to, so analytics cannot mislabel it', () => {
    for (const [id, plan] of Object.entries(TOUR_PLANS)) {
      for (const step of plan.steps) expect(step.plan).toBe(id)
    }
  })

  it('the menu offers the tour plus the three chapters, in that order', () => {
    expect(TOUR_MENU_ITEMS.map((item) => item.label)).toEqual([
      'Start the tour',
      'Read the numbers',
      'Finished work',
      'Get it out',
    ])
    // The first item has no fixed plan: which tour starts depends on whether
    // the organization has numbers yet.
    expect(TOUR_MENU_ITEMS[0].planId).toBeNull()
    expect(TOUR_MENU_ITEMS.slice(1).map((item) => item.planId)).toEqual([
      'read-numbers',
      'finished-work',
      'get-it-out',
    ])
  })

  it('the buttons and the progress line are fixed chrome, not per-step copy', () => {
    expect(TOUR_BUTTONS).toEqual({
      back: 'Back',
      next: 'Next',
      skip: 'Skip',
      done: 'Done',
    })
    expect(tourProgressLine(0, 6)).toBe('Step 1 of 6')
    expect(tourProgressLine(5, 6)).toBe('Step 6 of 6')
  })

  it('the last card says how to get the tour back', () => {
    expect(TOUR_FOOTER_LINE).toContain(TOUR_LAUNCHER_LABEL)
    expect(TOUR_FOOTER_LINE).toContain('page header')
  })

  it('the storage key and the version are exported for the dismissal rule', () => {
    expect(TOUR_STORAGE_KEY).toBe('mf_tour_roi')
    expect(TOUR_VERSION).toBe('1')
  })
})

describe('copy caps', () => {
  it.each(steps.map((step): [string, TourStep] => [step.id, step]))(
    '%s: the title is sentence case and at most 28 characters',
    (_id, step) => {
      expect(step.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
      expect(TITLE_MAX_CHARS).toBe(28)
      expect(step.title[0]).toBe(step.title[0].toUpperCase())
      expect(step.title.endsWith('.')).toBe(false)
    }
  )

  it.each(steps.map((step): [string, TourStep] => [step.id, step]))(
    '%s: the body is at most 140 characters and at most two sentences',
    (_id, step) => {
      expect(step.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
      expect(BODY_MAX_CHARS).toBe(140)
      expect(sentenceCount(step.body)).toBeLessThanOrEqual(2)
    }
  )

  it.each(steps.map((step): [string, TourStep] => [step.id, step]))(
    '%s: the action line is one short instruction',
    (_id, step) => {
      expect(step.action.length).toBeLessThanOrEqual(90)
      expect(sentenceCount(step.action)).toBeLessThanOrEqual(2)
    }
  )
})

describe('every tour string passes the shared ROI copy gates', () => {
  it.each(ALL_STRINGS)(
    '%s carries none of the vertical vocabulary',
    (_w, text) => {
      expect(VERTICAL_WORD.test(text)).toBe(false)
    }
  )

  it.each(ALL_STRINGS)('%s sends the reader somewhere findable', (_w, text) => {
    for (const sentence of sentencesOf(text)) {
      expect({ sentence, offends: isWayfindingOffense(sentence) }).toEqual({
        sentence,
        offends: false,
      })
    }
  })

  it.each(ALL_STRINGS)('%s contracts the way the page does', (_w, text) => {
    expect(uncontractedForms(text)).toEqual([])
  })

  it.each(ALL_STRINGS)('%s uses no dash a keyboard cannot type', (_w, text) => {
    expect(text).not.toMatch(/[—–]/)
  })

  it.each(ALL_STRINGS)('%s never says "just"', (_w, text) => {
    expect(text).not.toMatch(/\bjust\b/i)
  })

  it.each(ALL_STRINGS)('%s raises its voice at nobody', (_w, text) => {
    expect(text).not.toContain('!')
  })

  it.each(ALL_STRINGS)('%s calls a goal a goal', (_w, text) => {
    expect(text).not.toMatch(/\binitiatives?\b/i)
  })

  it.each(ALL_STRINGS)('%s names the meter by its command', (_w, text) => {
    expect(text).not.toMatch(/\bccc\b/i)
  })
})

describe('the work-item noun comes from the one registry', () => {
  it('the Finished work chapter names the noun through WORK_ITEM_NOUN', () => {
    const chapter = TOUR_PLANS['finished-work']
    for (const step of chapter.steps) {
      expect(step.body).toContain(WORK_ITEM_NOUN)
    }
  })

  it('no tour string hard-codes a different noun for the same thing', () => {
    for (const [, text] of ALL_STRINGS) {
      expect(text).not.toMatch(/\bmatters?\b/i)
    }
  })
})

describe('the card describes the screen the reader is actually on', () => {
  const step = (planId: keyof typeof TOUR_PLANS, id: string): TourStep => {
    const found = TOUR_PLANS[planId].steps.find((s) => s.id === id)
    if (!found) throw new Error(`no ${id} step in ${planId}`)
    return found
  }

  it('the print steps promise what the export gives, page count and all', () => {
    for (const card of [
      step('first-roi', 'print'),
      step('get-it-out', 'print-again'),
    ]) {
      expect(card.body).toMatch(/every tab in one (board-ready )?document/i)
      expect(card.body).not.toMatch(/one-page|single page|one sheet/i)
    }
  })

  it('the net step points at the info icons, which are the only hover there', () => {
    expect(step('first-roi', 'net').body).toContain('info icon')
    expect(step('first-roi', 'net').body).not.toMatch(/hover any number/i)
  })

  it('the tile steps count nothing, so the copy cannot drift from the grid', () => {
    // MONEY_TILE_METRICS renders four; the disclosure renders eight. A number
    // written here is a number that goes wrong the next time either list moves.
    for (const card of [
      step('read-numbers', 'tiles'),
      step('read-numbers', 'every-metric'),
    ]) {
      expect(card.title).not.toMatch(
        /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i
      )
      expect(card.body).not.toMatch(
        /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i
      )
    }
  })

  it('the no-data tour points at the install command, never a public-registry install', () => {
    const card = step('first-numbers', 'no-data')
    expect(card.action).toContain('meter install command')
    expect(card.missingTargetText).toContain('meter install command')
    expect(card.action).not.toContain('npx')
    expect(card.missingTargetText).not.toContain('npx')
  })

  it('the estimate step names whichever button is on the screen', () => {
    // The one anchored button reads emptyButton until numbers are stored and
    // editButton after, and Show me around restarts the tour from step one.
    const card = step('first-roi', 'estimate')
    expect(card.action).toContain(WITHOUT_AI_COPY.emptyButton)
    expect(card.action).toContain(WITHOUT_AI_COPY.editButton)
  })

  it('the net fallback names both reasons the sentence can be missing', () => {
    // report-derivation returns emptyNoActivity when the window holds no rows,
    // so stored numbers alone do not put the sentence on screen, and step one
    // suggests dates an older organization may have no activity in.
    const card = step('first-roi', 'net')
    expect(card.missingTargetText).toMatch(/Save your numbers/)
    expect(card.missingTargetText).toMatch(/dates that have activity/)
  })

  it('the goal card steps name the three dots, which is what a reader can see', () => {
    // The kebab's only name is its screen-reader label, so "the Actions menu"
    // is a control nobody sighted can find.
    expect(step('first-roi', 'goal-card').body).not.toMatch(/Actions menu/i)
    expect(step('first-roi', 'goal-card').body).toContain('three dots')
  })
})
