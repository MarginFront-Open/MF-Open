/**
 * The single-cron wiring proof.
 *
 * The cap ladder-alert, staged pool-alert, and customer-watch evaluations all
 * ride the one dispatch route (no extra vercel.json cron). This
 * pins that cronDispatch: (1) runs the invoice pass AND all three alert
 * passes, (2) merges the summaries into the response (additive `capAlerts` +
 * `poolAlerts` + `customerAlerts` keys), and (3) isolates each alert job so
 * its failure can never sink the billing run or a sibling job, including a
 * table-not-yet-migrated transient (this route can be live before migrations
 * have created the alert tables).
 */

import { SubscriptionController } from './subscription.controller';

function build(
  overrides: {
    alerts?: () => Promise<any>;
    poolAlerts?: () => Promise<any>;
    customerAlerts?: () => Promise<any>;
  } = {},
) {
  const dispatchUsageInvoices = jest
    .fn()
    .mockResolvedValue({ issuedCount: 2, customerEmailsSent: 2 });
  const evaluateCapAlerts = jest
    .fn()
    .mockImplementation(
      overrides.alerts ?? (() => Promise.resolve({ evaluated: 3, alertsSent: 1 })),
    );
  const evaluatePoolAlerts = jest
    .fn()
    .mockImplementation(
      overrides.poolAlerts ??
        (() => Promise.resolve({ evaluated: 2, alertsSent: 1, sweep: { swept: 0 } })),
    );
  const evaluateCustomerAlerts = jest
    .fn()
    .mockImplementation(
      overrides.customerAlerts ?? (() => Promise.resolve({ evaluated: 1, alertsSent: 1 })),
    );

  const controller = new SubscriptionController(
    {} as any, // SubscriptionService — unused by cronDispatch
    {} as any, // RevenueMetricsService — unused
    { dispatchUsageInvoices } as any,
    { evaluateCapAlerts } as any,
    { evaluatePoolAlerts } as any,
    { evaluateCustomerAlerts } as any,
  );
  return {
    controller,
    dispatchUsageInvoices,
    evaluateCapAlerts,
    evaluatePoolAlerts,
    evaluateCustomerAlerts,
  };
}

describe('SubscriptionController.cronDispatch — one cron, four jobs', () => {
  it('runs the invoice dispatch and all three alert passes, merged into one response', async () => {
    const {
      controller,
      dispatchUsageInvoices,
      evaluateCapAlerts,
      evaluatePoolAlerts,
      evaluateCustomerAlerts,
    } = build();

    const res: any = await controller.cronDispatch();

    expect(dispatchUsageInvoices).toHaveBeenCalledTimes(1);
    expect(evaluateCapAlerts).toHaveBeenCalledTimes(1);
    expect(evaluatePoolAlerts).toHaveBeenCalledTimes(1);
    expect(evaluateCustomerAlerts).toHaveBeenCalledTimes(1);
    // The full-sweep contract: the cron passes NO orgId (every org, every watch).
    expect(evaluateCustomerAlerts).toHaveBeenCalledWith();
    expect(res.issuedCount).toBe(2);
    expect(res.capAlerts).toEqual({ evaluated: 3, alertsSent: 1 });
    expect(res.poolAlerts).toEqual({ evaluated: 2, alertsSent: 1, sweep: { swept: 0 } });
    expect(res.customerAlerts).toEqual({ evaluated: 1, alertsSent: 1 });
  });

  it('a cap-alert failure is isolated — the invoice result and the pool pass still land', async () => {
    const { controller, dispatchUsageInvoices, evaluatePoolAlerts } = build({
      alerts: () => Promise.reject(new Error('resend down')),
    });

    const res: any = await controller.cronDispatch();

    expect(dispatchUsageInvoices).toHaveBeenCalledTimes(1);
    expect(evaluatePoolAlerts).toHaveBeenCalledTimes(1);
    expect(res.issuedCount).toBe(2); // billing run survived
    expect(res.capAlerts).toEqual({ error: 'resend down' });
    expect(res.poolAlerts).toEqual({ evaluated: 2, alertsSent: 1, sweep: { swept: 0 } });
  });

  it('a pool-alert failure is isolated — the invoice result and the cap pass still land', async () => {
    const { controller, dispatchUsageInvoices, evaluateCapAlerts } = build({
      poolAlerts: () => Promise.reject(new Error('ledger query died')),
    });

    const res: any = await controller.cronDispatch();

    expect(dispatchUsageInvoices).toHaveBeenCalledTimes(1);
    expect(evaluateCapAlerts).toHaveBeenCalledTimes(1);
    expect(res.issuedCount).toBe(2); // billing run survived
    expect(res.capAlerts).toEqual({ evaluated: 3, alertsSent: 1 });
    expect(res.poolAlerts).toEqual({ error: 'ledger query died' });
  });

  it('the pool pass runs AFTER the invoice dispatch (the boundary rule depends on job order)', async () => {
    const { controller, dispatchUsageInvoices, evaluatePoolAlerts } = build();

    await controller.cronDispatch();

    expect(dispatchUsageInvoices.mock.invocationCallOrder[0]).toBeLessThan(
      evaluatePoolAlerts.mock.invocationCallOrder[0],
    );
  });

  it('a customer-watch failure is isolated — invoices, caps, and pools still land', async () => {
    // The load-bearing case is the table-not-yet-migrated transient: api-nest
    // can run before migrations are applied, so this
    // exact error shape ("relation does not exist") must never sink billing.
    const { controller, dispatchUsageInvoices, evaluateCapAlerts, evaluatePoolAlerts } = build({
      customerAlerts: () => Promise.reject(new Error('relation "customer_alerts" does not exist')),
    });

    const res: any = await controller.cronDispatch();

    expect(dispatchUsageInvoices).toHaveBeenCalledTimes(1);
    expect(evaluateCapAlerts).toHaveBeenCalledTimes(1);
    expect(evaluatePoolAlerts).toHaveBeenCalledTimes(1);
    expect(res.issuedCount).toBe(2); // billing run survived
    expect(res.capAlerts).toEqual({ evaluated: 3, alertsSent: 1 });
    expect(res.poolAlerts).toEqual({ evaluated: 2, alertsSent: 1, sweep: { swept: 0 } });
    expect(res.customerAlerts).toEqual({ error: 'relation "customer_alerts" does not exist' });
  });

  it('a cap-alert failure never blocks the customer-watch pass (sibling isolation both ways)', async () => {
    const { controller, evaluateCustomerAlerts } = build({
      alerts: () => Promise.reject(new Error('resend down')),
    });

    const res: any = await controller.cronDispatch();

    expect(evaluateCustomerAlerts).toHaveBeenCalledTimes(1);
    expect(res.customerAlerts).toEqual({ evaluated: 1, alertsSent: 1 });
  });
});
