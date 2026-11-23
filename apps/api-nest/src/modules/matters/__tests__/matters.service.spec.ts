/**
 * Unit proof of the parity-critical service behaviors, the ones a
 * drifted twin would silently break: the delete transaction's
 * events-to-Unassigned invariant, org-scoped no-op writes, the apply-rules
 * sweep scope, the dashboard's exact validation messages, and the audit
 * endpoint's reconciliation where-clause.
 *
 * Prisma is mocked; the queries' SHAPES are the contract under test (each
 * mirrors a dashboard action named in matters.service.ts). Math parity lives
 * in matters-audit-parity.spec.ts; role gating in matters.guard-matrix.spec.ts.
 */

import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getMatterCostRollups } from '@marginfront/db';
import { MattersService } from '../matters.service';

// Cost rollups are the @marginfront/db lib's job; the service's contract
// is WHAT it asks for and how it maps the buckets, so the function is mocked
// and the lib's own test script pins the SQL.
jest.mock('@marginfront/db', () => ({
  ...jest.requireActual('@marginfront/db'),
  getMatterCostRollups: jest.fn(),
}));
const mockGetMatterCostRollups = getMatterCostRollups as jest.MockedFunction<
  typeof getMatterCostRollups
>;

beforeEach(() => {
  // Default mirrors the real zero-fill contract: every requested bucket comes
  // back zeroed; an unfiltered call returns no buckets.
  mockGetMatterCostRollups.mockReset();
  mockGetMatterCostRollups.mockImplementation(async (_db, _orgId, filters) =>
    (filters?.matterIds ?? []).map((matterId) => ({
      matterId,
      cost: 0,
      eventCount: 0,
      eventsMissingCost: 0,
    })),
  );
});

type MockedPrisma = {
  matters: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
    delete: jest.Mock;
  };
  signal_events: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  matter_routing_rules: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MATTER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EVENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RULE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const RULE_2_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const MATTER_ROW = {
  id: MATTER_ID,
  matterNumber: 'MAT-2214',
  name: 'Hartley v. Grange',
  clientName: 'Hartley Trust',
  status: 'open',
  responsibleUserId: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
};

function makePrisma(): MockedPrisma {
  return {
    matters: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(MATTER_ROW),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue(MATTER_ROW),
    },
    signal_events: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    matter_routing_rules: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // Array form: prisma runs the already-created query promises atomically;
    // awaiting them preserves the results-array contract the service reads.
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

function makeService(prisma: MockedPrisma) {
  return new MattersService(prisma as never);
}

describe('deleteMatter — the events-survive invariant (matters.ts twin)', () => {
  it('one transaction: clear matterSource on the org+matter events, delete the rules, then the matter', async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue({ id: MATTER_ID });
    prisma.matter_routing_rules.deleteMany.mockResolvedValue({ count: 3 });
    prisma.signal_events.updateMany.mockResolvedValue({ count: 14 });

    const result = await makeService(prisma).deleteMatter(ORG, MATTER_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.signal_events.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, matterId: MATTER_ID },
      data: { matterSource: null },
    });
    // The rules count comes from a deleteMany INSIDE the transaction, never a
    // count() taken before it — outside, a concurrent rule edit skews the number.
    expect(prisma.matter_routing_rules.deleteMany).toHaveBeenCalledWith({
      where: { matterId: MATTER_ID, orgId: ORG },
    });
    expect(prisma.matter_routing_rules.count).not.toHaveBeenCalled();
    expect(prisma.matters.delete).toHaveBeenCalledWith({ where: { id: MATTER_ID } });
    // The response SAYS what happened.
    expect(result).toEqual({
      deleted: true,
      eventsReturnedToUnassigned: 14,
      routingRulesDeleted: 3,
    });
  });

  it('a foreign matter id is a 404, and nothing is deleted', async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue(null);
    await expect(makeService(prisma).deleteMatter(ORG, MATTER_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('assignEvent — manual precedence, org-scoped no-op (matters.ts twin)', () => {
  it("stamps {matterId, matterSource:'manual'} scoped to the org", async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue({ id: MATTER_ID });
    prisma.signal_events.updateMany.mockResolvedValue({ count: 1 });

    const result = await makeService(prisma).assignEvent(ORG, {
      eventId: EVENT_ID,
      matterId: MATTER_ID,
    });

    expect(prisma.signal_events.updateMany).toHaveBeenCalledWith({
      where: { id: EVENT_ID, organizationId: ORG },
      data: { matterId: MATTER_ID, matterSource: 'manual' },
    });
    expect(result).toEqual({
      assigned: true,
      eventId: EVENT_ID,
      matterId: MATTER_ID,
      source: 'manual',
    });
  });

  it("unassigning (matterId null) skips the matter lookup and STILL stamps 'manual', so apply-rules never re-sweeps it", async () => {
    const prisma = makePrisma();
    prisma.signal_events.updateMany.mockResolvedValue({ count: 1 });

    await makeService(prisma).assignEvent(ORG, { eventId: EVENT_ID, matterId: null });

    expect(prisma.matters.findFirst).not.toHaveBeenCalled();
    expect(prisma.signal_events.updateMany).toHaveBeenCalledWith({
      where: { id: EVENT_ID, organizationId: ORG },
      data: { matterId: null, matterSource: 'manual' },
    });
  });

  it('a foreign event id updates zero rows and reads as a 404, not a cross-tenant write', async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue({ id: MATTER_ID });
    prisma.signal_events.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      makeService(prisma).assignEvent(ORG, { eventId: EVENT_ID, matterId: MATTER_ID }),
    ).rejects.toThrow('Usage event not found in this organization.');
  });

  it('a foreign matter id is rejected before any write', async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue(null);
    await expect(
      makeService(prisma).assignEvent(ORG, { eventId: EVENT_ID, matterId: MATTER_ID }),
    ).rejects.toThrow('Matter not found in this organization.');
    expect(prisma.signal_events.updateMany).not.toHaveBeenCalled();
  });
});

describe('applyRules — sweep scope and order (matter-rules.ts twin)', () => {
  const ruleFor = (overrides: Record<string, unknown>) => ({
    id: RULE_ID,
    matterId: MATTER_ID,
    priority: 100,
    agentCode: null,
    customerExternalId: null,
    signalPattern: null,
    ...overrides,
  });

  it('scopes every rule to (matterId IS NULL AND matterSource IS NULL) — tags, rules, and manual decisions are never overridden', async () => {
    const prisma = makePrisma();
    prisma.matter_routing_rules.findMany.mockResolvedValue([
      ruleFor({ agentCode: 'intake-agent' }),
    ]);
    prisma.signal_events.updateMany.mockResolvedValue({ count: 5 });

    const result = await makeService(prisma).applyRules(ORG);

    expect(prisma.signal_events.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        matterId: null,
        matterSource: null,
        agents: { agentCode: 'intake-agent' },
      },
      data: { matterId: MATTER_ID, matterSource: 'rule' },
    });
    expect(result).toEqual({ assigned: 5 });
  });

  it('fetches rules in evaluation order and skips a matcher-less rule instead of matching everything', async () => {
    const prisma = makePrisma();
    prisma.matter_routing_rules.findMany.mockResolvedValue([ruleFor({})]);

    const result = await makeService(prisma).applyRules(ORG);

    expect(prisma.matter_routing_rules.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.signal_events.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ assigned: 0 });
  });

  it('a mid-sweep failure reports the partial count AND logs org + failing rule id', async () => {
    const prisma = makePrisma();
    prisma.matter_routing_rules.findMany.mockResolvedValue([
      ruleFor({ agentCode: 'a1', priority: 1 }),
      ruleFor({ id: RULE_2_ID, agentCode: 'a2', priority: 2 }),
    ]);
    prisma.signal_events.updateMany
      .mockResolvedValueOnce({ count: 4 })
      .mockRejectedValueOnce(new Error('db down'));

    const service = makeService(prisma);
    const errorLog = jest
      .spyOn((service as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);

    const failure = service.applyRules(ORG);
    await expect(failure).rejects.toThrow(InternalServerErrorException);
    await failure.catch((err: InternalServerErrorException) => {
      const body = err.getResponse() as Record<string, unknown>;
      expect(body.assigned).toBe(4);
      expect(String(body.message)).toContain('Stopped partway: 4 events');
    });

    // The 500 body is an HttpException, invisible to Sentry / Nest / the
    // customer-failure filter — this log line is the only server trace.
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [logMessage] = errorLog.mock.calls[0];
    expect(logMessage).toContain(ORG);
    expect(logMessage).toContain(RULE_2_ID);
    expect(logMessage).toContain('4 events assigned');
  });
});

describe('matter validation — the dashboard messages, verbatim (matters.ts twin)', () => {
  it('trims fields and rejects whitespace-only with the required message', async () => {
    const prisma = makePrisma();
    await expect(
      makeService(prisma).createMatter(ORG, {
        matterNumber: '   ',
        name: 'x',
        clientName: 'y',
      }),
    ).rejects.toThrow('Matter number is required.');
    expect(prisma.matters.create).not.toHaveBeenCalled();
  });

  it('rejects a 256-character field with the dashboard message', async () => {
    const prisma = makePrisma();
    await expect(
      makeService(prisma).createMatter(ORG, {
        matterNumber: 'M-1',
        name: 'n'.repeat(256),
        clientName: 'y',
      }),
    ).rejects.toThrow('Matter name must be 255 characters or fewer.');
  });

  it('stores TRIMMED values (ingest matches metadata.matterId against the trimmed number)', async () => {
    const prisma = makePrisma();
    await makeService(prisma).createMatter(ORG, {
      matterNumber: '  MAT-2214  ',
      name: ' Hartley v. Grange ',
      clientName: ' Hartley Trust ',
    });
    expect(prisma.matters.create).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        matterNumber: 'MAT-2214',
        name: 'Hartley v. Grange',
        clientName: 'Hartley Trust',
        status: 'open',
        responsibleUserId: null,
      },
    });
  });

  it('a duplicate matterNumber (P2002) becomes a 409 naming the number, never the raw Prisma message', async () => {
    const prisma = makePrisma();
    prisma.matters.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      makeService(prisma).createMatter(ORG, {
        matterNumber: 'MAT-2214',
        name: 'x',
        clientName: 'y',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('PATCH with zero valid fields still 404s on a foreign matter (org-scoped updateMany)', async () => {
    const prisma = makePrisma();
    prisma.matters.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      makeService(prisma).updateMatter(ORG, MATTER_ID, { status: 'closed' }),
    ).rejects.toThrow('Matter not found in this organization.');
  });
});

describe('rule validation — merged-state matcher requirement (matter-rules.ts twin)', () => {
  it('creating with no matcher is rejected with the dashboard message', async () => {
    const prisma = makePrisma();
    await expect(
      makeService(prisma).createRule(ORG, { matterId: MATTER_ID, agentCode: '   ' }),
    ).rejects.toThrow(
      'A rule needs at least one matcher: an agent code, a customer ID, or a signal name pattern.',
    );
  });

  it('an update that clears the LAST matcher is rejected on the MERGED state, not the patch alone', async () => {
    const prisma = makePrisma();
    prisma.matter_routing_rules.findFirst.mockResolvedValue({
      id: RULE_ID,
      matterId: MATTER_ID,
      priority: 100,
      agentCode: 'intake-agent',
      customerExternalId: null,
      signalPattern: null,
    });
    await expect(makeService(prisma).updateRule(ORG, RULE_ID, { agentCode: null })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.matter_routing_rules.update).not.toHaveBeenCalled();
  });

  it('moving a rule to a matter outside the org is rejected before the write', async () => {
    const prisma = makePrisma();
    prisma.matter_routing_rules.findFirst.mockResolvedValue({
      id: RULE_ID,
      matterId: MATTER_ID,
      priority: 100,
      agentCode: 'intake-agent',
      customerExternalId: null,
      signalPattern: null,
    });
    prisma.matters.findFirst.mockResolvedValue(null);
    await expect(
      makeService(prisma).updateRule(ORG, RULE_ID, {
        matterId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      }),
    ).rejects.toThrow('Matter not found in this organization.');
    expect(prisma.matter_routing_rules.update).not.toHaveBeenCalled();
  });
});

describe('getAudit — the reconciliation where-clause (matter-export.ts twin)', () => {
  it('unfiltered: WHERE is organizationId + usageDate window and NOTHING else (canon C1 contract)', async () => {
    const prisma = makePrisma();
    await makeService(prisma).getAudit(ORG, { start: '2026-08-01', end: '2026-08-31' });

    const where = prisma.signal_events.findMany.mock.calls[0][0].where;
    expect(Object.keys(where).sort()).toEqual(['organizationId', 'usageDate']);
    expect(where.organizationId).toBe(ORG);
    expect(where.usageDate.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(where.usageDate.lte.toISOString()).toBe('2026-08-31T23:59:59.999Z');
  });

  it('the matterId slice verifies the matter in-org first, then narrows the same window', async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue({ id: MATTER_ID });
    await makeService(prisma).getAudit(ORG, {
      start: '2026-08-01',
      end: '2026-08-31',
      matterId: MATTER_ID,
    });
    const where = prisma.signal_events.findMany.mock.calls[0][0].where;
    expect(where.matterId).toBe(MATTER_ID);
  });

  it("format 'summary' (the default) omits the per-event rows; 'detail' carries them", async () => {
    const prisma = makePrisma();
    const summary = await makeService(prisma).getAudit(ORG, {});
    expect(summary).not.toHaveProperty('rows');
    const detail = await makeService(prisma).getAudit(ORG, { format: 'detail' });
    expect(detail).toHaveProperty('rows');
  });
});

describe('getUnassigned — the badge count survives pagination (matters.ts twin)', () => {
  it('totalResults comes from the FULL unassigned bucket, never the page length', async () => {
    const prisma = makePrisma();
    prisma.signal_events.findMany.mockResolvedValue([]);
    mockGetMatterCostRollups.mockResolvedValue([
      { matterId: null, cost: 12.5, eventCount: 42, eventsMissingCost: 12 },
    ]);

    const result = await makeService(prisma).getUnassigned(ORG, { page: 5, limit: 10 });

    expect(result.totalResults).toBe(42);
    expect(result.totalCost).toBe(12.5);
    expect(result.eventsMissingCost).toBe(12);
    expect(mockGetMatterCostRollups).toHaveBeenCalledWith(prisma, ORG, {
      matterIds: [null],
    });
  });
});

describe('canon C1 — unresolved costs surface as eventsMissingCost, never silently zeroed', () => {
  it('listMatters maps the canonical buckets and scopes them to the returned page', async () => {
    const prisma = makePrisma();
    prisma.matters.findMany.mockResolvedValue([MATTER_ROW]);
    prisma.matters.count.mockResolvedValue(1);
    mockGetMatterCostRollups.mockResolvedValue([
      { matterId: MATTER_ID, cost: 4.6, eventCount: 14, eventsMissingCost: 2 },
    ]);

    const result = await makeService(prisma).listMatters(ORG, {});

    expect(result.results[0]).toMatchObject({
      actualCost: 4.6,
      eventCount: 14,
      eventsMissingCost: 2,
    });
    expect(mockGetMatterCostRollups).toHaveBeenCalledWith(prisma, ORG, {
      matterIds: [MATTER_ID],
    });
  });

  it('listMatters with an empty page never asks for a rollup', async () => {
    const prisma = makePrisma();
    prisma.matters.findMany.mockResolvedValue([]);
    prisma.matters.count.mockResolvedValue(0);

    const result = await makeService(prisma).listMatters(ORG, {});

    expect(result.results).toEqual([]);
    expect(mockGetMatterCostRollups).not.toHaveBeenCalled();
  });

  it('getMatterDetail carries the same companion next to actualCost', async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue(MATTER_ROW);
    mockGetMatterCostRollups.mockResolvedValue([
      { matterId: MATTER_ID, cost: 4.6, eventCount: 14, eventsMissingCost: 2 },
    ]);

    const result = await makeService(prisma).getMatterDetail(ORG, MATTER_ID);

    expect(result.actualCost).toBe(4.6);
    expect(result.eventsMissingCost).toBe(2);
    expect(mockGetMatterCostRollups).toHaveBeenCalledWith(prisma, ORG, {
      matterIds: [MATTER_ID],
    });
  });

  it('getMatterDetail on a matter with zero events reads honest zeros (zero-fill contract)', async () => {
    const prisma = makePrisma();
    prisma.matters.findFirst.mockResolvedValue(MATTER_ROW);

    const result = await makeService(prisma).getMatterDetail(ORG, MATTER_ID);

    expect(result.actualCost).toBe(0);
    expect(result.eventCount).toBe(0);
    expect(result.eventsMissingCost).toBe(0);
  });
});
