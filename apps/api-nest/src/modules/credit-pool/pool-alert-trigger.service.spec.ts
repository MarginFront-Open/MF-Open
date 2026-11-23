/**
 * The ingest-side pool-alert trigger, clone of the cap-alert
 * trigger proofs. What this pins, each red against a missing/broken impl:
 *   1. Only credit-pool events trigger — the caller's resolved membership is
 *      the whole gate, so a non-pool event costs zero queries here.
 *   2. Debounce is keyed PER SUBSCRIPTION (unlike the per-org cap trigger):
 *      sibling subscriptions are independent; a fresh window re-arms.
 *   3. The evaluation is scoped to the triggering subscription.
 *   4. A rejecting evaluator can never throw into the ingest hot path.
 */

import { PoolAlertTriggerService } from './pool-alert-trigger.service';

const flush = () => new Promise((r) => setTimeout(r, 0));

function build() {
  const evaluatePoolAlerts = jest
    .fn()
    .mockResolvedValue({ evaluated: 1, alertsSent: 0, skipped: 0, errors: [], durationMs: 1 });
  const service = new PoolAlertTriggerService({ evaluatePoolAlerts } as any);
  return { service, evaluatePoolAlerts };
}

const T0 = 1_750_000_000_000;

describe('PoolAlertTriggerService.maybeTrigger — credit-pool events only', () => {
  it('triggers for a credit-pool event, scoped to the subscription', async () => {
    const { service, evaluatePoolAlerts } = build();
    expect(service.maybeTrigger('sub-a', true, T0)).toBe(true);
    await flush();
    expect(evaluatePoolAlerts).toHaveBeenCalledTimes(1);
    expect(evaluatePoolAlerts.mock.calls[0][1]).toBe('sub-a');
  });

  it('ignores non-credit-pool events and missing subscription ids without touching the evaluator', async () => {
    const { service, evaluatePoolAlerts } = build();
    expect(service.maybeTrigger('sub-a', false, T0)).toBe(false);
    expect(service.maybeTrigger(null, true, T0)).toBe(false);
    expect(service.maybeTrigger(undefined, true, T0)).toBe(false);
    await flush();
    expect(evaluatePoolAlerts).not.toHaveBeenCalled();
  });
});

describe('PoolAlertTriggerService.maybeTrigger — debounce per SUBSCRIPTION', () => {
  it('collapses repeat events on one subscription inside the window to one evaluation', async () => {
    const { service, evaluatePoolAlerts } = build();
    expect(service.maybeTrigger('sub-a', true, T0)).toBe(true);
    expect(service.maybeTrigger('sub-a', true, T0 + 1_000)).toBe(false);
    expect(service.maybeTrigger('sub-a', true, T0 + 60_000)).toBe(false);
    await flush();
    expect(evaluatePoolAlerts).toHaveBeenCalledTimes(1);
  });

  it('keeps sibling subscriptions independent and re-arms after the window', async () => {
    const { service, evaluatePoolAlerts } = build();
    service.maybeTrigger('sub-a', true, T0);
    // Same org, different subscription: must NOT be debounced away.
    expect(service.maybeTrigger('sub-b', true, T0 + 1_000)).toBe(true);
    expect(service.maybeTrigger('sub-a', true, T0 + PoolAlertTriggerService.DEBOUNCE_MS + 1)).toBe(
      true,
    );
    await flush();
    expect(evaluatePoolAlerts).toHaveBeenCalledTimes(3);
  });
});

describe('PoolAlertTriggerService.maybeTrigger — hot-path containment', () => {
  it('never throws when the evaluator rejects', async () => {
    const evaluatePoolAlerts = jest.fn().mockRejectedValue(new Error('db down'));
    const service = new PoolAlertTriggerService({ evaluatePoolAlerts } as any);
    expect(() => service.maybeTrigger('sub-a', true, T0)).not.toThrow();
    await flush();
    expect(evaluatePoolAlerts).toHaveBeenCalledTimes(1);
  });
});
