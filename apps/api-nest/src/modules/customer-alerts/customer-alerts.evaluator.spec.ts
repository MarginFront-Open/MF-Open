/**
 * EvaluateCustomerAlerts proofs.
 *
 * Same mock discipline as cost-control.alerts.spec.ts: the real evaluator
 * logic runs; only the DB, email, and canonical-metrics boundaries are
 * stubbed (the metrics functions have their own proofs in packages/db). What
 * this pins, each red against a broken impl:
 *   1. Over threshold fires ONE email to the STORED recipientEmail and writes
 *      the ledger row + notification row together; under stays silent.
 *   2. Dedup idempotency: a re-run at the same value re-sends nothing; a fresh
 *      calendar month re-arms a month watch.
 *   3. The `sent === null` invariant: an unconfigured-Resend "send" burns NO
 *      ledger row, NO notification row, NO latch — the same window delivers
 *      once email config lands.
 *   4. The rolling latch: over -> fire + latch; still-over next day -> silent;
 *      back-under -> silent re-arm; over again -> fire again.
 *   5. Custom windows: not-started and expired skip; inside fires once ever.
 *   6. Evaluation-time re-check: a customer flipped internal or soft-deleted
 *      AFTER the watch was created stops alerting.
 *   7. The evaluator reads the CANONICAL path with the customerId filter and
 *      the mode's exact window — never hand-rolled math.
 *   8. Org scoping (ingest trigger) vs full sweep (cron), and per-alert error
 *      isolation.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { CustomerAlertsService } from './customer-alerts.service';

const ORG = 'org-1';
const CUSTOMER = 'cust-1';
const RECIPIENT_USER = 'user-recipient';

interface AlertSeed {
  id: string;
  orgId: string;
  customerId: string;
  metric: 'cost' | 'revenue';
  thresholdUsd: number;
  windowMode: 'month' | 'rolling' | 'custom';
  customStartDate?: Date | null;
  customEndDate?: Date | null;
  recipientEmail?: string;
  recipientUserId?: string;
  triggeredAt?: Date | null;
}

interface CustomerSeed {
  id: string;
  name: string;
  isInternal?: boolean;
  deletedAt?: Date | null;
}

function build(opts: {
  alerts: AlertSeed[];
  customers?: CustomerSeed[];
  costByCustomer?: Record<string, number>;
  revenueByCustomer?: Record<string, number>;
}) {
  const customers = opts.customers ?? [{ id: CUSTOMER, name: 'Acme' }];
  const costByCustomer = opts.costByCustomer ?? {};
  const revenueByCustomer = opts.revenueByCustomer ?? {};

  // The Prisma where-semantics these specs exercise (orgId), implemented as
  // real filter logic rather than a pattern-match of the service's query.
  const matchesWhere = (row: any, cond: any): boolean =>
    cond.orgId === undefined || row.orgId === cond.orgId;

  const alertRows: any[] = opts.alerts.map((a) => ({
    customStartDate: null,
    customEndDate: null,
    recipientEmail: 'recipient@org.test',
    recipientUserId: RECIPIENT_USER,
    triggeredAt: null,
    ...a,
    thresholdUsd: new Decimal(a.thresholdUsd),
  }));
  const ledgerRows: any[] = [];
  const notificationRows: any[] = [];

  const models: any = {
    customer_alerts: {
      findMany: ({ where }: any = {}) =>
        Promise.resolve(
          alertRows
            .filter((a) => matchesWhere(a, where ?? {}))
            .map((a) => ({
              ...a,
              customers: (() => {
                const c = customers.find((x) => x.id === a.customerId);
                return c
                  ? {
                      id: c.id,
                      name: c.name,
                      isInternal: c.isInternal ?? false,
                      deletedAt: c.deletedAt ?? null,
                    }
                  : null;
              })(),
            })),
        ),
      update: ({ where, data }: any) => {
        const row = alertRows.find((a) => a.id === where.id);
        if (row) Object.assign(row, data);
        return Promise.resolve(row);
      },
    },
    customer_alert_events: {
      findFirst: ({ where }: any) =>
        Promise.resolve(
          ledgerRows.find(
            (r) =>
              r.alertId === where.alertId &&
              r.windowStart.getTime() === new Date(where.windowStart).getTime(),
          ) ?? null,
        ),
      create: ({ data }: any) => {
        const dup = ledgerRows.find(
          (r) =>
            r.alertId === data.alertId &&
            r.windowStart.getTime() === new Date(data.windowStart).getTime(),
        );
        if (dup) {
          const err: any = new Error('unique violation');
          err.code = 'P2002';
          return Promise.reject(err);
        }
        const row = { ...data, windowStart: new Date(data.windowStart) };
        ledgerRows.push(row);
        return Promise.resolve(row);
      },
    },
    customer_alert_notifications: {
      create: ({ data }: any) => {
        notificationRows.push({ readAt: null, ...data });
        return Promise.resolve(data);
      },
    },
  };
  const prisma: any = {
    ...models,
    $transaction: (fn: any) => fn(models),
  };

  const email = {
    sendCustomerAlertEmail: jest.fn().mockResolvedValue({ id: 'sent' }),
    sendCustomerAlertConfirmationEmail: jest.fn().mockResolvedValue({ id: 'sent' }),
  };
  const revenueMetrics = {
    getCostMetrics: jest.fn((_orgId: string, _window: any, filters: any) =>
      Promise.resolve({ cost: costByCustomer[filters.customerId] ?? 0 }),
    ),
    getRevenueMetrics: jest.fn((_orgId: string, _window: any, filters: any) =>
      Promise.resolve({ revenue: revenueByCustomer[filters.customerId] ?? 0 }),
    ),
  };

  const service = new CustomerAlertsService(prisma, email as any, revenueMetrics as any);
  return {
    service,
    email,
    revenueMetrics,
    alertRows,
    ledgerRows,
    notificationRows,
    costByCustomer,
    revenueByCustomer,
  };
}

const NOW = new Date('2026-08-26T09:00:00.000Z');

const monthCostAlert = (over: Partial<AlertSeed> = {}): AlertSeed => ({
  id: 'watch-1',
  orgId: ORG,
  customerId: CUSTOMER,
  metric: 'cost',
  thresholdUsd: 500,
  windowMode: 'month',
  ...over,
});

describe('evaluateCustomerAlerts — over fires once, under stays silent', () => {
  it('over threshold: one email to the STORED address, one ledger row, one notification row', async () => {
    const { service, email, ledgerRows, notificationRows } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 512.4 },
    });

    const res = await service.evaluateCustomerAlerts(NOW);

    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
    const arg = email.sendCustomerAlertEmail.mock.calls[0][0];
    expect(arg.to).toBe('recipient@org.test');
    expect(arg.valueUsd).toBeCloseTo(512.4, 6);
    expect(arg.thresholdUsd).toBeCloseTo(500, 6);
    expect(arg.customerName).toBe('Acme');
    expect(arg.customerId).toBe(CUSTOMER);
    expect(res.alertsSent).toBe(1);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].windowStart.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(notificationRows).toHaveLength(1);
    expect(notificationRows[0].userId).toBe(RECIPIENT_USER);
    expect(notificationRows[0].customerId).toBe(CUSTOMER);
    expect(notificationRows[0].metric).toBe('cost');
  });

  it('under threshold: silence — no email, no rows', async () => {
    const { service, email, ledgerRows, notificationRows } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 499.999999 },
    });

    const res = await service.evaluateCustomerAlerts(NOW);

    expect(email.sendCustomerAlertEmail).not.toHaveBeenCalled();
    expect(res.alertsSent).toBe(0);
    expect(ledgerRows).toHaveLength(0);
    expect(notificationRows).toHaveLength(0);
  });

  it('exactly AT threshold does not fire (the rule is passed, not reached)', async () => {
    const { service, email } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 500 },
    });
    await service.evaluateCustomerAlerts(NOW);
    expect(email.sendCustomerAlertEmail).not.toHaveBeenCalled();
  });
});

describe('evaluateCustomerAlerts — dedup idempotency and month re-arm', () => {
  it('a second sweep at the same value re-sends nothing (ledger dedup)', async () => {
    const { service, email, ledgerRows, notificationRows } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });

    await service.evaluateCustomerAlerts(NOW);
    await service.evaluateCustomerAlerts(NOW);

    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
    expect(ledgerRows).toHaveLength(1);
    expect(notificationRows).toHaveLength(1);
  });

  it('a fresh calendar month re-arms the watch (new windowStart, second email)', async () => {
    const { service, email, ledgerRows } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });

    await service.evaluateCustomerAlerts(new Date('2026-08-26T09:00:00.000Z'));
    await service.evaluateCustomerAlerts(new Date('2026-09-02T09:00:00.000Z'));

    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(2);
    expect(ledgerRows.map((r) => r.windowStart.toISOString())).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ]);
  });
});

describe('evaluateCustomerAlerts — the sent === null invariant (nothing burns)', () => {
  it('a null send (Resend unconfigured) writes NO ledger row, NO notification, NO latch', async () => {
    const { service, email, ledgerRows, notificationRows, alertRows } = build({
      alerts: [monthCostAlert(), monthCostAlert({ id: 'watch-rolling', windowMode: 'rolling' })],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    email.sendCustomerAlertEmail.mockResolvedValue(null);

    const res = await service.evaluateCustomerAlerts(NOW);

    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(2);
    expect(res.alertsSent).toBe(0);
    expect(res.skipped).toBeGreaterThanOrEqual(2);
    expect(res.errors).toHaveLength(0);
    expect(ledgerRows).toHaveLength(0);
    expect(notificationRows).toHaveLength(0);
    expect(alertRows.find((a) => a.id === 'watch-rolling')!.triggeredAt).toBeNull();
  });

  it('after email config lands, the SAME window delivers (nothing was burned)', async () => {
    const { service, email, ledgerRows } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    email.sendCustomerAlertEmail.mockResolvedValueOnce(null);

    await service.evaluateCustomerAlerts(NOW);
    expect(ledgerRows).toHaveLength(0);

    const res = await service.evaluateCustomerAlerts(NOW);

    expect(res.alertsSent).toBe(1);
    expect(ledgerRows).toHaveLength(1);
  });

  it('a THROWING send records nothing and lands in errors (next sweep retries)', async () => {
    const { service, email, ledgerRows, notificationRows } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    email.sendCustomerAlertEmail.mockRejectedValue(new Error('mailbox unavailable'));

    const res = await service.evaluateCustomerAlerts(NOW);

    expect(res.alertsSent).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(ledgerRows).toHaveLength(0);
    expect(notificationRows).toHaveLength(0);
  });
});

describe('evaluateCustomerAlerts — the rolling latch (one email per crossing episode)', () => {
  const rollingAlert = () =>
    monthCostAlert({ id: 'watch-r', windowMode: 'rolling', thresholdUsd: 100 });

  it('over -> fire + latch; still-over NEXT DAY -> silent (the latch, not the day-belt)', async () => {
    const { service, email, alertRows } = build({
      alerts: [rollingAlert()],
      costByCustomer: { [CUSTOMER]: 150 },
    });

    await service.evaluateCustomerAlerts(new Date('2026-08-26T09:00:00.000Z'));
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
    expect(alertRows[0].triggeredAt).not.toBeNull();

    await service.evaluateCustomerAlerts(new Date('2026-08-27T09:00:00.000Z'));
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1); // still one
  });

  it('back under -> silent re-arm; over again -> a second fire', async () => {
    const { service, email, alertRows, costByCustomer, ledgerRows } = build({
      alerts: [rollingAlert()],
      costByCustomer: { [CUSTOMER]: 150 },
    });

    await service.evaluateCustomerAlerts(new Date('2026-08-26T09:00:00.000Z')); // fire
    costByCustomer[CUSTOMER] = 50;
    await service.evaluateCustomerAlerts(new Date('2026-08-27T09:00:00.000Z')); // re-arm
    expect(alertRows[0].triggeredAt).toBeNull();
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1); // re-arm is silent

    costByCustomer[CUSTOMER] = 200;
    await service.evaluateCustomerAlerts(new Date('2026-08-28T09:00:00.000Z')); // fire again
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(2);
    expect(ledgerRows).toHaveLength(2);
  });

  it('the UTC-day belt: a drop-and-recross the SAME day sends no second email row', async () => {
    const { service, email, alertRows, costByCustomer, ledgerRows } = build({
      alerts: [rollingAlert()],
      costByCustomer: { [CUSTOMER]: 150 },
    });

    await service.evaluateCustomerAlerts(new Date('2026-08-26T09:00:00.000Z')); // fire
    costByCustomer[CUSTOMER] = 50;
    await service.evaluateCustomerAlerts(new Date('2026-08-26T12:00:00.000Z')); // re-arm same day
    expect(alertRows[0].triggeredAt).toBeNull();
    costByCustomer[CUSTOMER] = 200;
    await service.evaluateCustomerAlerts(new Date('2026-08-26T15:00:00.000Z')); // recross same day

    // The latch is open, but the (alertId, utc-day) ledger row already exists:
    // the belt stops the second same-day email.
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
    expect(ledgerRows).toHaveLength(1);
  });
});

describe('evaluateCustomerAlerts — custom windows', () => {
  const customAlert = () =>
    monthCostAlert({
      id: 'watch-c',
      windowMode: 'custom',
      customStartDate: new Date('2026-08-01T00:00:00.000Z'),
      customEndDate: new Date('2026-08-31T23:59:59.000Z'),
    });

  it('before the range: skip, no metrics read', async () => {
    const { service, email, revenueMetrics } = build({
      alerts: [customAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    const res = await service.evaluateCustomerAlerts(new Date('2026-07-15T00:00:00.000Z'));
    expect(res.skipped).toBe(1);
    expect(email.sendCustomerAlertEmail).not.toHaveBeenCalled();
    expect(revenueMetrics.getCostMetrics).not.toHaveBeenCalled();
  });

  it('after the range: expired, skip forever', async () => {
    const { service, email } = build({
      alerts: [customAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    const res = await service.evaluateCustomerAlerts(new Date('2026-09-15T00:00:00.000Z'));
    expect(res.skipped).toBe(1);
    expect(email.sendCustomerAlertEmail).not.toHaveBeenCalled();
  });

  it('inside the range: fires exactly once ever (windowStart = range start)', async () => {
    const { service, email, ledgerRows } = build({
      alerts: [customAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    await service.evaluateCustomerAlerts(new Date('2026-08-10T00:00:00.000Z'));
    await service.evaluateCustomerAlerts(new Date('2026-08-20T00:00:00.000Z'));
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].windowStart.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('evaluateCustomerAlerts — evaluation-time customer re-check', () => {
  it('a customer flipped INTERNAL after the watch was created stops alerting', async () => {
    const { service, email } = build({
      alerts: [monthCostAlert()],
      customers: [{ id: CUSTOMER, name: 'dev@co.example', isInternal: true }],
      costByCustomer: { [CUSTOMER]: 999999 },
    });
    const res = await service.evaluateCustomerAlerts(NOW);
    expect(email.sendCustomerAlertEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it('a customer soft-deleted after the watch was created stops alerting', async () => {
    const { service, email } = build({
      alerts: [monthCostAlert()],
      customers: [{ id: CUSTOMER, name: 'Gone', deletedAt: new Date('2026-08-20') }],
      costByCustomer: { [CUSTOMER]: 999999 },
    });
    const res = await service.evaluateCustomerAlerts(NOW);
    expect(email.sendCustomerAlertEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });
});

describe('evaluateCustomerAlerts — the canonical path, with the exact window and filter', () => {
  it('a cost watch reads getCostMetrics(orgId, month-window, { customerId }) — never revenue', async () => {
    const { service, revenueMetrics } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    await service.evaluateCustomerAlerts(NOW);

    expect(revenueMetrics.getCostMetrics).toHaveBeenCalledTimes(1);
    expect(revenueMetrics.getRevenueMetrics).not.toHaveBeenCalled();
    const [orgId, window, filters] = revenueMetrics.getCostMetrics.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(window.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(window.end.toISOString()).toBe(NOW.toISOString());
    expect(filters).toEqual({ customerId: CUSTOMER });
  });

  it('a revenue watch reads getRevenueMetrics(...).revenue — never cost', async () => {
    const { service, email, revenueMetrics } = build({
      alerts: [monthCostAlert({ id: 'watch-rev', metric: 'revenue', thresholdUsd: 1000 })],
      revenueByCustomer: { [CUSTOMER]: 1200 },
      costByCustomer: { [CUSTOMER]: 0 },
    });
    await service.evaluateCustomerAlerts(NOW);

    expect(revenueMetrics.getRevenueMetrics).toHaveBeenCalledTimes(1);
    expect(revenueMetrics.getCostMetrics).not.toHaveBeenCalled();
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendCustomerAlertEmail.mock.calls[0][0].valueUsd).toBeCloseTo(1200, 6);
  });

  it('a rolling watch reads the exact 30-day window ending at now', async () => {
    const { service, revenueMetrics } = build({
      alerts: [monthCostAlert({ id: 'watch-r', windowMode: 'rolling' })],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    await service.evaluateCustomerAlerts(NOW);
    const [, window] = revenueMetrics.getCostMetrics.mock.calls[0];
    expect(window.start.toISOString()).toBe('2026-07-27T09:00:00.000Z');
    expect(window.end.toISOString()).toBe(NOW.toISOString());
  });
});

describe('evaluateCustomerAlerts — scoping and isolation', () => {
  it('with an orgId, evaluates ONLY that org (the ingest trigger is never a full sweep)', async () => {
    const { service, email } = build({
      alerts: [
        monthCostAlert({ id: 'watch-a' }),
        monthCostAlert({ id: 'watch-b', orgId: 'org-other', customerId: 'cust-other' }),
      ],
      customers: [
        { id: CUSTOMER, name: 'Acme' },
        { id: 'cust-other', name: 'Other Co' },
      ],
      costByCustomer: { [CUSTOMER]: 600, 'cust-other': 600 },
    });

    const res = await service.evaluateCustomerAlerts(NOW, ORG);

    expect(res.evaluated).toBe(1);
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('without an orgId, sweeps every org (the daily backstop path)', async () => {
    const { service, email } = build({
      alerts: [
        monthCostAlert({ id: 'watch-a' }),
        monthCostAlert({ id: 'watch-b', orgId: 'org-other', customerId: 'cust-other' }),
      ],
      customers: [
        { id: CUSTOMER, name: 'Acme' },
        { id: 'cust-other', name: 'Other Co' },
      ],
      costByCustomer: { [CUSTOMER]: 600, 'cust-other': 600 },
    });

    const res = await service.evaluateCustomerAlerts(NOW);

    expect(res.evaluated).toBe(2);
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(2);
  });

  it('one watch blowing up never kills the run — the sibling still fires', async () => {
    const { service, email, revenueMetrics } = build({
      alerts: [
        monthCostAlert({ id: 'watch-bad' }),
        monthCostAlert({ id: 'watch-good', customerId: 'cust-2' }),
      ],
      customers: [
        { id: CUSTOMER, name: 'Acme' },
        { id: 'cust-2', name: 'Beta Inc' },
      ],
      costByCustomer: { [CUSTOMER]: 600, 'cust-2': 600 },
    });
    revenueMetrics.getCostMetrics.mockImplementation((_o: string, _w: any, filters: any) =>
      filters.customerId === CUSTOMER
        ? Promise.reject(new Error('db exploded'))
        : Promise.resolve({ cost: 600 }),
    );

    const res = await service.evaluateCustomerAlerts(NOW);

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].alertId).toBe('watch-bad');
    expect(res.alertsSent).toBe(1);
    expect(email.sendCustomerAlertEmail).toHaveBeenCalledTimes(1);
    expect(email.sendCustomerAlertEmail.mock.calls[0][0].customerName).toBe('Beta Inc');
  });

  it('reports how long the evaluation took', async () => {
    const { service } = build({
      alerts: [monthCostAlert()],
      costByCustomer: { [CUSTOMER]: 600 },
    });
    const res = await service.evaluateCustomerAlerts(NOW);
    expect(typeof res.durationMs).toBe('number');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});
