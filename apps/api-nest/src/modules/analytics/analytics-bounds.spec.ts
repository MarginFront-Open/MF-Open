/**
 * Unit tests for the `@MaxWindowDays` constraint.
 *
 * A window wider than ANALYTICS_MAX_WINDOW_DAYS is rejected with a 400, with a
 * message naming the max and pointing the caller at the operator's SUPPORT_EMAIL
 * when one is set. These tests exercise the decorator directly on a minimal DTO via
 * class-validator's `validate()`, with no HTTP, no Nest bootstrap and no DB.
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ANALYTICS_MAX_WINDOW_DAYS, ANALYTICS_MAX_ROWS, MaxWindowDays } from './analytics-bounds';
import { ANALYTICS_MAX_ROWS as DB_ANALYTICS_MAX_ROWS } from '@marginfront/db';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return isoDate(new Date(new Date(iso).getTime() + days * MS_PER_DAY));
}

class TestWindowDto {
  startDate!: unknown;

  @MaxWindowDays(ANALYTICS_MAX_WINDOW_DAYS)
  endDate!: unknown;
}

async function validateWindow(startDate: unknown, endDate: unknown) {
  const instance = plainToInstance(TestWindowDto, { startDate, endDate });
  return validate(instance);
}

function maxWindowMessage(errors: Awaited<ReturnType<typeof validate>>): string | undefined {
  const err = errors.find((e) => e.property === 'endDate');
  return err?.constraints?.maxWindowDays;
}

describe('ANALYTICS_MAX_WINDOW_DAYS / ANALYTICS_MAX_ROWS constants', () => {
  it('window cap is 366 days (one leap year)', () => {
    expect(ANALYTICS_MAX_WINDOW_DAYS).toBe(366);
  });

  it('row cap is 500, re-exported from the single @marginfront/db home', () => {
    expect(ANALYTICS_MAX_ROWS).toBe(500);
    // Same constant, not a redeclared copy that could drift.
    expect(ANALYTICS_MAX_ROWS).toBe(DB_ANALYTICS_MAX_ROWS);
  });
});

describe('MaxWindowDays — boundary semantics', () => {
  const START = '2026-01-01';

  it('accepts a window of exactly 366 days (the cap, inclusive)', async () => {
    const end = addDays(START, ANALYTICS_MAX_WINDOW_DAYS);
    const errors = await validateWindow(START, end);
    expect(maxWindowMessage(errors)).toBeUndefined();
  });

  it('rejects a window of 367 days with the exact window message', async () => {
    const end = addDays(START, ANALYTICS_MAX_WINDOW_DAYS + 1);
    const errors = await validateWindow(START, end);
    const message = maxWindowMessage(errors);
    expect(message).toBeDefined();
    expect(message).toContain('367 days');
    expect(message).toContain('maximum is 366');
    expect(message).toMatch(/Date window too large/);
  });

  it('names the operator support address from SUPPORT_EMAIL when it is set', async () => {
    process.env.SUPPORT_EMAIL = 'help@billing.example.com';
    try {
      const errors = await validateWindow(START, addDays(START, ANALYTICS_MAX_WINDOW_DAYS + 1));
      expect(maxWindowMessage(errors)).toContain('contact help@billing.example.com');
    } finally {
      delete process.env.SUPPORT_EMAIL;
    }
  });

  it('names no contact address when SUPPORT_EMAIL is unset, and suggests splitting the request', async () => {
    delete process.env.SUPPORT_EMAIL;
    const errors = await validateWindow(START, addDays(START, ANALYTICS_MAX_WINDOW_DAYS + 1));
    const message = maxWindowMessage(errors);
    expect(message).toContain('split it into several smaller requests');
    expect(message).not.toMatch(/@/);
  });

  it('rejects a window one day over the cap (368 days) too — not just the +1 edge', async () => {
    const end = addDays(START, ANALYTICS_MAX_WINDOW_DAYS + 2);
    const errors = await validateWindow(START, end);
    expect(maxWindowMessage(errors)).toBeDefined();
  });

  it('accepts a small window well under the cap', async () => {
    const end = addDays(START, 30);
    const errors = await validateWindow(START, end);
    expect(maxWindowMessage(errors)).toBeUndefined();
  });
});

describe("MaxWindowDays — malformed/missing dates pass through (not this decorator's job)", () => {
  const START = '2026-01-01';

  it('a malformed endDate passes the window check (IsDateString catches format)', async () => {
    const errors = await validateWindow(START, 'not-a-date');
    expect(maxWindowMessage(errors)).toBeUndefined();
  });

  it('a malformed startDate passes the window check', async () => {
    const errors = await validateWindow('not-a-date', addDays(START, 30));
    expect(maxWindowMessage(errors)).toBeUndefined();
  });

  it('a missing startDate passes the window check', async () => {
    const errors = await validateWindow(undefined, addDays(START, 30));
    expect(maxWindowMessage(errors)).toBeUndefined();
  });

  it('a missing endDate passes the window check', async () => {
    const errors = await validateWindow(START, undefined);
    expect(maxWindowMessage(errors)).toBeUndefined();
  });
});
