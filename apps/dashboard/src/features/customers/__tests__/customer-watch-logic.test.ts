/**
 * The customer page's Alerts logic, pinned in node jest because
 * the page that mounts it is @ts-nocheck (the compiler can't catch a
 * UUID-vs-externalId mix-up there — that is the exact failure mode
 * and makes this test mandatory).
 */

import {
  EMPTY_WATCH_FORM,
  buildWatchWriteInput,
  customRangeLine,
  validateWatchForm,
  watchSentence,
  watchToForm,
} from '../customer-watch-logic'
import type { CustomerWatchView } from '@/app/actions/customer-alerts'

const INTERNAL_UUID = '3f2a8c1e-0000-4000-8000-000000000001'

const watch = (over: Partial<CustomerWatchView> = {}): CustomerWatchView => ({
  id: 'watch-1',
  customerId: INTERNAL_UUID,
  metric: 'cost',
  thresholdUsd: 500,
  windowMode: 'month',
  customStartDate: null,
  customEndDate: null,
  recipientEmail: 'me@org.test',
  createdAt: '2026-08-26T12:00:00.000Z',
  ...over,
})

describe('buildWatchWriteInput — the payload the REST authority receives', () => {
  it('carries metric, a NUMERIC threshold, and the window mode', () => {
    const input = buildWatchWriteInput({
      ...EMPTY_WATCH_FORM,
      metric: 'revenue',
      threshold: '750.50',
      windowMode: 'rolling',
    })
    expect(input).toEqual({
      metric: 'revenue',
      thresholdUsd: 750.5,
      windowMode: 'rolling',
    })
  })

  it('NEVER carries a customer identifier — the caller passes the route UUID separately, so externalId cannot leak into the payload', () => {
    const input = buildWatchWriteInput({
      ...EMPTY_WATCH_FORM,
      threshold: '100',
    })
    expect('customerId' in input).toBe(false)
    expect('customerExternalId' in input).toBe(false)
  })

  it('custom mode converts yyyy-mm-dd to UTC instants, end-of-day inclusive', () => {
    const input = buildWatchWriteInput({
      metric: 'cost',
      threshold: '100',
      windowMode: 'custom',
      customStartDate: '2026-08-01',
      customEndDate: '2026-08-31',
    })
    expect(input.customStartDate).toBe('2026-08-01T00:00:00.000Z')
    expect(input.customEndDate).toBe('2026-08-31T23:59:59.999Z')
  })

  it('non-custom modes send NO dates (api-nest refuses stray dates)', () => {
    const input = buildWatchWriteInput({
      ...EMPTY_WATCH_FORM,
      threshold: '100',
      customStartDate: '2026-08-01', // stale UI state from a mode flip
      customEndDate: '2026-08-31',
    })
    expect(input.customStartDate).toBeUndefined()
    expect(input.customEndDate).toBeUndefined()
  })
})

describe('validateWatchForm', () => {
  it('accepts a complete month form', () => {
    expect(
      validateWatchForm({ ...EMPTY_WATCH_FORM, threshold: '500' })
    ).toBeNull()
  })

  it.each([
    ['', 'empty'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['abc', 'non-numeric'],
  ])('rejects a %s threshold (%s)', (threshold) => {
    expect(validateWatchForm({ ...EMPTY_WATCH_FORM, threshold })).toMatch(
      /dollar amount above zero/
    )
  })

  it('custom mode requires both dates, ordered', () => {
    const base = {
      ...EMPTY_WATCH_FORM,
      threshold: '100',
      windowMode: 'custom',
    }
    expect(validateWatchForm(base)).toMatch(/both a start and an end date/)
    expect(
      validateWatchForm({
        ...base,
        customStartDate: '2026-08-31',
        customEndDate: '2026-08-01',
      })
    ).toMatch(/before the end date/)
    expect(
      validateWatchForm({
        ...base,
        customStartDate: '2026-08-01',
        customEndDate: '2026-08-31',
      })
    ).toBeNull()
  })
})

describe('display composition', () => {
  it('watchSentence names metric, money (formatted once, canon R4), and window label', () => {
    expect(watchSentence(watch())).toBe(
      'Email when cost passes $500.00 (This month)'
    )
    expect(
      watchSentence(watch({ metric: 'revenue', windowMode: 'rolling' }))
    ).toBe('Email when revenue passes $500.00 (Last 30 days)')
  })

  it('customRangeLine renders only for custom windows, in UTC', () => {
    expect(customRangeLine(watch())).toBeNull()
    expect(
      customRangeLine(
        watch({
          windowMode: 'custom',
          customStartDate: '2026-08-01T00:00:00.000Z',
          customEndDate: '2026-08-31T23:59:59.999Z',
        })
      )
    ).toBe('Aug 1, 2026 to Aug 31, 2026 (UTC)')
  })

  it('watchToForm round-trips a custom watch back to yyyy-mm-dd inputs', () => {
    const form = watchToForm(
      watch({
        windowMode: 'custom',
        customStartDate: '2026-08-01T00:00:00.000Z',
        customEndDate: '2026-08-31T23:59:59.999Z',
      })
    )
    expect(form.customStartDate).toBe('2026-08-01')
    expect(form.customEndDate).toBe('2026-08-31')
    expect(form.threshold).toBe('500')
  })
})
