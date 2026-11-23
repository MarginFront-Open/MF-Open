/**
 * Validation tests for every date-taking analytics DTO.
 *
 * Two things are proven here:
 *   1. Every DTO that carries `@MaxWindowDays` rejects a > 366-day window
 *      and accepts an exactly-366-day window.
 *   2. The four typed query DTOs (customer, agent, profitability,
 *      events/aggregate) 400 on malformed dates and non-UUID ids instead of
 *      silently building a `NaN Date` query. `QuerySubscriptionAnalyticsDto`
 *      keeps its dates optional but caps the window when both are present.
 */

import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { QueryCustomerAnalyticsDto } from './query-customer-analytics.dto';
import { QueryAgentAnalyticsDto } from './query-agent-analytics.dto';
import { QueryProfitabilityAnalyticsDto } from './query-profitability-analytics.dto';
import { QueryAggregateEventsDto } from './query-aggregate-events.dto';
import { QuerySubscriptionAnalyticsDto } from './query-subscription-analytics.dto';
import { QueryUsageAnalyticsDto } from './query-usage-analytics.dto';
import { QueryCostAnalyticsDto } from './query-cost-analytics.dto';
import { QueryCostMetricsDto } from './query-cost-metrics.dto';
import { QueryRevenueMetricsDto } from './query-revenue-metrics.dto';
import { ANALYTICS_MAX_WINDOW_DAYS } from '../analytics-bounds';

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, days: number): string {
  return isoDate(new Date(new Date(iso).getTime() + days * MS_PER_DAY));
}

function collectMessages(errors: ValidationError[]): string[] {
  const out: string[] = [];
  const walk = (errs: ValidationError[]) => {
    for (const err of errs) {
      if (err.constraints) out.push(...Object.values(err.constraints));
      if (err.children?.length) walk(err.children);
    }
  };
  walk(errors);
  return out;
}

async function validateDto<T extends object>(cls: new () => T, payload: unknown) {
  const instance = plainToInstance(cls, payload as object);
  return validate(instance as object);
}

// ─── Boundary sweep: every date-taking DTO honors the 366-day cap ─────────

const START = '2026-01-01';

describe('every date-taking analytics DTO caps the window at 366 days', () => {
  const cases: Array<{ name: string; cls: new () => object; base: Record<string, unknown> }> = [
    { name: 'QueryUsageAnalyticsDto', cls: QueryUsageAnalyticsDto, base: {} },
    { name: 'QueryCostAnalyticsDto', cls: QueryCostAnalyticsDto, base: {} },
    { name: 'QueryCostMetricsDto', cls: QueryCostMetricsDto, base: {} },
    { name: 'QueryRevenueMetricsDto', cls: QueryRevenueMetricsDto, base: {} },
    {
      name: 'QueryCustomerAnalyticsDto',
      cls: QueryCustomerAnalyticsDto,
      base: { customerId: VALID_UUID },
    },
    { name: 'QueryAgentAnalyticsDto', cls: QueryAgentAnalyticsDto, base: { agentId: VALID_UUID } },
    { name: 'QueryProfitabilityAnalyticsDto', cls: QueryProfitabilityAnalyticsDto, base: {} },
    { name: 'QueryAggregateEventsDto', cls: QueryAggregateEventsDto, base: {} },
  ];

  it.each(cases)('$name: 366-day window passes', async ({ cls, base }) => {
    const endDate = addDays(START, ANALYTICS_MAX_WINDOW_DAYS);
    const errors = await validateDto(cls, { ...base, startDate: START, endDate });
    const messages = collectMessages(errors);
    expect(messages.some((m) => /Date window too large/.test(m))).toBe(false);
  });

  it.each(cases)(
    '$name: 367-day window is rejected with the window message',
    async ({ cls, base }) => {
      const endDate = addDays(START, ANALYTICS_MAX_WINDOW_DAYS + 1);
      const errors = await validateDto(cls, { ...base, startDate: START, endDate });
      const messages = collectMessages(errors);
      expect(
        messages.some((m) => /Date window too large/.test(m) && /maximum is 366/.test(m)),
      ).toBe(true);
    },
  );
});

// ─── QuerySubscriptionAnalyticsDto — dates stay optional (shape-compat) ───

describe('QuerySubscriptionAnalyticsDto — optional dates, capped only when both present', () => {
  it('passes with no dates at all (existing callers keep working)', async () => {
    const errors = await validateDto(QuerySubscriptionAnalyticsDto, {});
    expect(errors).toEqual([]);
  });

  it('passes with only billingPeriodStart (no window to measure)', async () => {
    const errors = await validateDto(QuerySubscriptionAnalyticsDto, {
      billingPeriodStart: START,
    });
    expect(errors).toEqual([]);
  });

  it('passes when both dates are present and within the 366-day cap', async () => {
    const errors = await validateDto(QuerySubscriptionAnalyticsDto, {
      billingPeriodStart: START,
      billingPeriodEnd: addDays(START, 30),
    });
    expect(errors).toEqual([]);
  });

  it('rejects when both dates are present and the window exceeds the cap', async () => {
    const errors = await validateDto(QuerySubscriptionAnalyticsDto, {
      billingPeriodStart: START,
      billingPeriodEnd: addDays(START, ANALYTICS_MAX_WINDOW_DAYS + 1),
    });
    const messages = collectMessages(errors);
    expect(messages.some((m) => /Date window too large/.test(m))).toBe(true);
  });
});

// ─── Typed analytics endpoints: malformed dates/ids 400 ──────────────────

describe('QueryCustomerAnalyticsDto', () => {
  const VALID = { customerId: VALID_UUID, startDate: START, endDate: addDays(START, 10) };

  it('accepts a well-formed request', async () => {
    expect(await validateDto(QueryCustomerAnalyticsDto, VALID)).toEqual([]);
  });

  it('rejects a malformed startDate', async () => {
    const errors = await validateDto(QueryCustomerAnalyticsDto, {
      ...VALID,
      startDate: 'not-a-date',
    });
    expect(errors.some((e) => e.property === 'startDate')).toBe(true);
  });

  it('rejects a malformed endDate', async () => {
    const errors = await validateDto(QueryCustomerAnalyticsDto, {
      ...VALID,
      endDate: 'not-a-date',
    });
    expect(errors.some((e) => e.property === 'endDate')).toBe(true);
  });

  it('rejects a non-UUID customerId', async () => {
    const errors = await validateDto(QueryCustomerAnalyticsDto, {
      ...VALID,
      customerId: 'not-a-uuid',
    });
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });

  it('rejects a missing customerId (required)', async () => {
    const { customerId: _drop, ...rest } = VALID;
    const errors = await validateDto(QueryCustomerAnalyticsDto, rest);
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });
});

describe('QueryAgentAnalyticsDto', () => {
  const VALID = { agentId: VALID_UUID, startDate: START, endDate: addDays(START, 10) };

  it('accepts a well-formed request', async () => {
    expect(await validateDto(QueryAgentAnalyticsDto, VALID)).toEqual([]);
  });

  it('rejects a malformed startDate', async () => {
    const errors = await validateDto(QueryAgentAnalyticsDto, { ...VALID, startDate: 'garbage' });
    expect(errors.some((e) => e.property === 'startDate')).toBe(true);
  });

  it('rejects a non-UUID agentId', async () => {
    const errors = await validateDto(QueryAgentAnalyticsDto, { ...VALID, agentId: '123' });
    expect(errors.some((e) => e.property === 'agentId')).toBe(true);
  });
});

describe('QueryProfitabilityAnalyticsDto', () => {
  const VALID = { startDate: START, endDate: addDays(START, 10) };

  it('accepts a well-formed request with no filters', async () => {
    expect(await validateDto(QueryProfitabilityAnalyticsDto, VALID)).toEqual([]);
  });

  it('accepts optional customerId/agentId when they are valid UUIDs', async () => {
    const errors = await validateDto(QueryProfitabilityAnalyticsDto, {
      ...VALID,
      customerId: VALID_UUID,
      agentId: VALID_UUID,
    });
    expect(errors).toEqual([]);
  });

  it('rejects a malformed endDate', async () => {
    const errors = await validateDto(QueryProfitabilityAnalyticsDto, { ...VALID, endDate: 'nope' });
    expect(errors.some((e) => e.property === 'endDate')).toBe(true);
  });

  it('rejects a non-UUID customerId filter', async () => {
    const errors = await validateDto(QueryProfitabilityAnalyticsDto, {
      ...VALID,
      customerId: 'nope',
    });
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });

  it('rejects a non-UUID agentId filter', async () => {
    const errors = await validateDto(QueryProfitabilityAnalyticsDto, { ...VALID, agentId: 'nope' });
    expect(errors.some((e) => e.property === 'agentId')).toBe(true);
  });

  it('rejects a missing startDate/endDate (required)', async () => {
    const errors = await validateDto(QueryProfitabilityAnalyticsDto, {});
    expect(errors.some((e) => e.property === 'startDate')).toBe(true);
    expect(errors.some((e) => e.property === 'endDate')).toBe(true);
  });
});

describe('QueryAggregateEventsDto', () => {
  const VALID = { startDate: START, endDate: addDays(START, 10) };

  it('accepts a well-formed request with no filters', async () => {
    expect(await validateDto(QueryAggregateEventsDto, VALID)).toEqual([]);
  });

  it('accepts every optional filter when well-formed', async () => {
    const errors = await validateDto(QueryAggregateEventsDto, {
      ...VALID,
      customerId: VALID_UUID,
      agentId: VALID_UUID,
      signalId: VALID_UUID,
      customerExternalId: 'ext-123',
      dimension: 'agent',
      groupBy: 'daily',
    });
    expect(errors).toEqual([]);
  });

  it('rejects a malformed startDate', async () => {
    const errors = await validateDto(QueryAggregateEventsDto, {
      ...VALID,
      startDate: 'not-a-date',
    });
    expect(errors.some((e) => e.property === 'startDate')).toBe(true);
  });

  it('rejects a non-UUID customerId', async () => {
    const errors = await validateDto(QueryAggregateEventsDto, { ...VALID, customerId: 'nope' });
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });

  it('rejects a non-UUID agentId', async () => {
    const errors = await validateDto(QueryAggregateEventsDto, { ...VALID, agentId: 'nope' });
    expect(errors.some((e) => e.property === 'agentId')).toBe(true);
  });

  it('rejects a non-UUID signalId', async () => {
    const errors = await validateDto(QueryAggregateEventsDto, { ...VALID, signalId: 'nope' });
    expect(errors.some((e) => e.property === 'signalId')).toBe(true);
  });
});
