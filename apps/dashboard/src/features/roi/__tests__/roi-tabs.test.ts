/**
 * The ROI page's three child tabs and the resolver behind the
 * `?tab=` param.
 *
 * WHY IT EXISTS: a stale bookmark, a typo'd URL or any unknown tab id
 * must land the reader on Summary, not on a blank panel. The
 * resolver is the only place that decision is made, so it is the only place
 * that has to be pinned.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_ROI_TAB,
  ROI_TABS,
  resolveRoiTab,
  type RoiTabId,
} from '../roi-tabs'

describe('the registry answers the three reader questions, in order', () => {
  it('lists Summary, Finished work and Goals', () => {
    expect(ROI_TABS.map((tab) => tab.id)).toEqual([
      'summary',
      'finished',
      'goals',
    ])
    expect(ROI_TABS.map((tab) => tab.label)).toEqual([
      'Summary',
      'Finished work',
      'Goals',
    ])
  })

  it('opens on Summary — the tab that answers "did AI pay for itself"', () => {
    expect(DEFAULT_ROI_TAB).toBe('summary')
    expect(ROI_TABS[0].id).toBe(DEFAULT_ROI_TAB)
  })
})

describe('resolveRoiTab falls back rather than rendering a blank panel', () => {
  it('returns every shipped id unchanged', () => {
    for (const tab of ROI_TABS) {
      expect(resolveRoiTab(tab.id)).toBe(tab.id)
    }
  })

  it.each([
    ['an unknown id', 'agents'],
    ['an empty string', ''],
    ['whitespace', '  '],
    ['a near miss in the wrong case', 'Summary'],
    ['a tab id we have not shipped', 'forecast'],
  ])('falls back to Summary on %s', (_name, value) => {
    expect(resolveRoiTab(value)).toBe(DEFAULT_ROI_TAB)
  })

  it('falls back on null and on undefined — no param is not a broken param', () => {
    expect(resolveRoiTab(null)).toBe(DEFAULT_ROI_TAB)
    expect(resolveRoiTab(undefined)).toBe(DEFAULT_ROI_TAB)
  })

  it('the fallback is typed, so a fourth tab cannot be added without a label', () => {
    const resolved: RoiTabId = resolveRoiTab('goals')
    expect(ROI_TABS.some((tab) => tab.id === resolved)).toBe(true)
  })
})

describe('the module stays pure, the way build-tabs.ts is', () => {
  const src = readFileSync(join(__dirname, '..', 'roi-tabs.ts'), 'utf8')

  it('imports nothing — no React, no Next, no derivation module', () => {
    expect(src).not.toMatch(/^import /m)
  })
})
