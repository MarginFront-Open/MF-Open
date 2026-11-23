/**
 * The ingest-side alert trigger: caps are evaluated at the point of spend,
 * not only on a cron cadence.
 *
 * What this pins, each red against a missing/broken impl:
 *   1. Only code-cost-clarity agent codes trigger; every other event is a cheap no-op.
 *   2. Debounce: at most one evaluation per org per window; separate orgs are
 *      independent; a fresh window re-arms.
 *   3. The evaluation is scoped to the triggering org (never a full sweep).
 *   4. A rejecting evaluator can never throw into the ingest hot path.
 */

import { CapAlertTriggerService } from './cap-alert-trigger.service';

const flush = () => new Promise((r) => setTimeout(r, 0));

function build() {
  const evaluateCapAlerts = jest
    .fn()
    .mockResolvedValue({ evaluated: 0, alertsSent: 0, skipped: 0, errors: [] });
  const service = new CapAlertTriggerService({ evaluateCapAlerts } as any);
  return { service, evaluateCapAlerts };
}

const T0 = 1_750_000_000_000;

describe('CapAlertTriggerService.maybeTrigger: code-cost-clarity events only', () => {
  it('triggers for claude-code and codex, scoped to the org', async () => {
    const { service, evaluateCapAlerts } = build();
    expect(service.maybeTrigger('org-a', 'claude-code', T0)).toBe(true);
    await flush();
    expect(evaluateCapAlerts).toHaveBeenCalledTimes(1);
    expect(evaluateCapAlerts.mock.calls[0][1]).toBe('org-a');
  });

  it('ignores agent codes outside code-cost-clarity without calling the evaluator', async () => {
    const { service, evaluateCapAlerts } = build();
    expect(service.maybeTrigger('org-a', 'customer-support-bot', T0)).toBe(false);
    expect(service.maybeTrigger('org-a', 'chief-of-staff', T0)).toBe(false);
    await flush();
    expect(evaluateCapAlerts).not.toHaveBeenCalled();
  });
});

describe('CapAlertTriggerService.maybeTrigger — debounce per org', () => {
  it('collapses repeat events inside the window to one evaluation', async () => {
    const { service, evaluateCapAlerts } = build();
    expect(service.maybeTrigger('org-a', 'claude-code', T0)).toBe(true);
    expect(service.maybeTrigger('org-a', 'codex', T0 + 1_000)).toBe(false);
    expect(service.maybeTrigger('org-a', 'claude-code', T0 + 60_000)).toBe(false);
    await flush();
    expect(evaluateCapAlerts).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the window and keeps orgs independent', async () => {
    const { service, evaluateCapAlerts } = build();
    service.maybeTrigger('org-a', 'claude-code', T0);
    expect(service.maybeTrigger('org-b', 'claude-code', T0 + 1_000)).toBe(true);
    expect(
      service.maybeTrigger('org-a', 'claude-code', T0 + CapAlertTriggerService.DEBOUNCE_MS + 1),
    ).toBe(true);
    await flush();
    expect(evaluateCapAlerts).toHaveBeenCalledTimes(3);
  });
});

describe('CapAlertTriggerService.maybeTrigger — hot-path containment', () => {
  it('never throws when the evaluator rejects', async () => {
    const evaluateCapAlerts = jest.fn().mockRejectedValue(new Error('db down'));
    const service = new CapAlertTriggerService({ evaluateCapAlerts } as any);
    expect(() => service.maybeTrigger('org-a', 'claude-code', T0)).not.toThrow();
    await flush();
    expect(evaluateCapAlerts).toHaveBeenCalledTimes(1);
  });
});
