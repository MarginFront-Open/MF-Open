/**
 * The ingest-side customer-watch trigger, clone of the cap trigger
 * spec with the gate INVERTED.
 *
 * What this pins, each red against a missing/broken impl:
 *   1. code-cost-clarity agent codes (claude-code, codex) are a cheap no-op: internal
 *      coding spend must never evaluate customer watches.
 *   2. Every OTHER agent code triggers — real customer traffic is the point.
 *   3. Debounce: at most one evaluation per org per window; separate orgs are
 *      independent; a fresh window re-arms.
 *   4. The evaluation is scoped to the triggering org (never a full sweep).
 *   5. A rejecting evaluator can never throw into the ingest hot path.
 */

import { CustomerAlertTriggerService } from './customer-alert-trigger.service';

const flush = () => new Promise((r) => setTimeout(r, 0));

function build() {
  const evaluateCustomerAlerts = jest
    .fn()
    .mockResolvedValue({ evaluated: 0, alertsSent: 0, skipped: 0, errors: [], durationMs: 1 });
  const service = new CustomerAlertTriggerService({ evaluateCustomerAlerts } as any);
  return { service, evaluateCustomerAlerts };
}

const T0 = 1_750_000_000_000;

describe('CustomerAlertTriggerService.maybeTrigger — the INVERSE gate of the cap trigger', () => {
  it('triggers for a real customer agent code, scoped to the org', async () => {
    const { service, evaluateCustomerAlerts } = build();
    expect(service.maybeTrigger('org-a', 'customer-support-bot', T0)).toBe(true);
    await flush();
    expect(evaluateCustomerAlerts).toHaveBeenCalledTimes(1);
    expect(evaluateCustomerAlerts.mock.calls[0][1]).toBe('org-a');
  });

  it('ignores code-cost-clarity agent codes without calling the evaluator (caps watch those, not us)', async () => {
    const { service, evaluateCustomerAlerts } = build();
    expect(service.maybeTrigger('org-a', 'claude-code', T0)).toBe(false);
    expect(service.maybeTrigger('org-a', 'codex', T0)).toBe(false);
    await flush();
    expect(evaluateCustomerAlerts).not.toHaveBeenCalled();
  });
});

describe('CustomerAlertTriggerService.maybeTrigger — debounce per org', () => {
  it('collapses repeat events inside the window to one evaluation', async () => {
    const { service, evaluateCustomerAlerts } = build();
    expect(service.maybeTrigger('org-a', 'support-bot', T0)).toBe(true);
    expect(service.maybeTrigger('org-a', 'billing-agent', T0 + 1_000)).toBe(false);
    expect(service.maybeTrigger('org-a', 'support-bot', T0 + 60_000)).toBe(false);
    await flush();
    expect(evaluateCustomerAlerts).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the window and keeps orgs independent', async () => {
    const { service, evaluateCustomerAlerts } = build();
    service.maybeTrigger('org-a', 'support-bot', T0);
    expect(service.maybeTrigger('org-b', 'support-bot', T0 + 1_000)).toBe(true);
    expect(
      service.maybeTrigger(
        'org-a',
        'support-bot',
        T0 + CustomerAlertTriggerService.DEBOUNCE_MS + 1,
      ),
    ).toBe(true);
    await flush();
    expect(evaluateCustomerAlerts).toHaveBeenCalledTimes(3);
  });
});

describe('CustomerAlertTriggerService.maybeTrigger — hot-path containment', () => {
  it('never throws when the evaluator rejects', async () => {
    const evaluateCustomerAlerts = jest.fn().mockRejectedValue(new Error('db down'));
    const service = new CustomerAlertTriggerService({ evaluateCustomerAlerts } as any);
    expect(() => service.maybeTrigger('org-a', 'support-bot', T0)).not.toThrow();
    await flush();
    expect(evaluateCustomerAlerts).toHaveBeenCalledTimes(1);
  });

  it('never throws even on the table-not-yet-migrated transient', async () => {
    const evaluateCustomerAlerts = jest
      .fn()
      .mockRejectedValue(new Error('relation "customer_alerts" does not exist'));
    const service = new CustomerAlertTriggerService({ evaluateCustomerAlerts } as any);
    expect(() => service.maybeTrigger('org-a', 'support-bot', T0)).not.toThrow();
    await flush();
  });
});
