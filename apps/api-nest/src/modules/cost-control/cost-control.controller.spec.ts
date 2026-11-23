/**
 * CostControlController write-response proofs.
 *
 * Every cap write echoes the cap as its plain sentence so the human
 * (via SDK/MCP) sees what changed — reusing the shared @marginfront/db sentence rule,
 * never re-deriving it. This pins that the controller attaches that exact sentence
 * to create / update / delete responses (and, for delete, keeps `deleted: true`).
 *
 * The service is stubbed to return known cap rows; the real controller wrapping
 * runs. buildCapSentence is imported here from the SAME shared module the
 * controller uses, so a drift in the rule turns these red — it is the source of
 * truth, not a hand-typed expected string.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { buildCapSentence } from '@marginfront/db';
import { CostControlController } from './cost-control.controller';

const ORG = 'org-uuid';
const USER = 'user-uuid';
const req = { user: { organizationId: ORG, userId: USER } } as any;

const devCap = {
  id: 'cap-1',
  orgId: ORG,
  scope: 'dev',
  scopeValue: 'alice@acme.example',
  providerScope: 'anthropic',
  amountUsd: new Decimal(200),
  period: 'week',
  mode: 'enforce',
  coolOffHours: null,
  alertThresholds: [50, 80, 100],
  createdByUserId: USER,
};

const expectedDevSentence = 'Stop Claude spend at $200 for alice@acme.example per week';

describe('CostControlController — write responses echo the plain sentence', () => {
  it('sentence matches the shared rule (guards the hand-written expectation)', () => {
    expect(
      buildCapSentence({
        providerScope: 'anthropic',
        amountUsd: 200,
        scope: 'dev',
        scopeValue: 'alice@acme.example',
        period: 'week',
      }),
    ).toBe(expectedDevSentence);
  });

  it('createCap returns the cap plus its sentence', async () => {
    const service = { createCap: jest.fn().mockResolvedValue(devCap) } as any;
    const controller = new CostControlController(service);

    const result = (await controller.createCap(req, {
      scope: 'dev',
      scopeValue: 'alice@acme.example',
      providerScope: 'anthropic',
      amountUsd: 200,
      period: 'week',
      mode: 'enforce',
    } as any)) as any;

    expect(result.sentence).toBe(expectedDevSentence);
    expect(result.id).toBe('cap-1'); // the cap itself is still in the response
    // amountUsd comes back as an honest number, never a Decimal-as-string wire wart.
    expect(result.amountUsd).toBe(200);
    expect(typeof result.amountUsd).toBe('number');
  });

  it('updateCap returns the updated cap plus its sentence', async () => {
    const updated = { ...devCap, amountUsd: new Decimal(150) };
    const service = { updateCap: jest.fn().mockResolvedValue(updated) } as any;
    const controller = new CostControlController(service);

    const result = (await controller.updateCap(req, 'cap-1', {
      amountUsd: 150,
    } as any)) as any;

    expect(result.sentence).toBe('Stop Claude spend at $150 for alice@acme.example per week');
    expect(result.id).toBe('cap-1');
  });

  it('deleteCap returns deleted:true plus the removed cap sentence', async () => {
    const service = {
      deleteCap: jest.fn().mockResolvedValue({ deleted: true, cap: devCap }),
    } as any;
    const controller = new CostControlController(service);

    const result = (await controller.deleteCap(req, 'cap-1')) as any;

    expect(result.deleted).toBe(true);
    expect(result.sentence).toBe(expectedDevSentence);
  });
});
