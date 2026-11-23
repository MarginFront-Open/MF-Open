/**
 * Cap-policy invariants, two pinned:
 *
 *   1. The ceiling holds on the 'all' fallback path, not only the
 *      exact-provider path. A child with no same-provider org ceiling falls
 *      back to the 'all' ceiling (resolveApplicableCeiling), so org-side writes
 *      must re-check those children too. If they re-checked only same-provider
 *      children, lowering the 'all' ceiling, or deleting a provider ceiling
 *      whose children then fall back to a lower 'all', would break the
 *      invariant silently.
 *   2. DTO bounds: amountUsd, coolOffHours, and the string fields carry upper
 *      bounds (numeric @Max, string length caps).
 */

import 'reflect-metadata';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { CostControlService } from './cost-control.service';
import {
  CapModeDto,
  CapPeriodDto,
  CapScopeDto,
  CreateCapPolicyDto,
} from './dto/create-cap-policy.dto';
import { UpdateCapPolicyDto } from './dto/update-cap-policy.dto';
import { QuerySpendDto } from './dto/query-spend.dto';

const ORG = 'org-uuid';
const ACTOR = 'actor-user-uuid';

interface CapRow {
  id: string;
  orgId: string;
  scope: string;
  scopeValue: string | null;
  providerScope: string;
  amountUsd: unknown;
  period: string;
  mode: string;
  coolOffHours: number | null;
  createdByUserId: string | null;
}

let idSeq = 1000;

function buildCapOnlyMockPrisma() {
  const caps: CapRow[] = [];
  const capMatches = (row: CapRow, where: any): boolean => {
    if (where.orgId && row.orgId !== where.orgId) return false;
    if (where.id) {
      if (typeof where.id === 'object' && where.id.not && row.id === where.id.not) return false;
      if (typeof where.id === 'string' && row.id !== where.id) return false;
    }
    if (where.scope) {
      if (typeof where.scope === 'object' && where.scope.in && !where.scope.in.includes(row.scope))
        return false;
      if (typeof where.scope === 'string' && row.scope !== where.scope) return false;
    }
    if (where.providerScope && row.providerScope !== where.providerScope) return false;
    if (where.scopeValue !== undefined && row.scopeValue !== where.scopeValue) return false;
    return true;
  };
  const clone = (r: CapRow): CapRow => ({ ...r });
  const mock: any = {
    cap_policies: {
      findMany: ({ where }: any) =>
        Promise.resolve(caps.filter((c) => capMatches(c, where ?? {})).map(clone)),
      findFirst: ({ where }: any) => {
        const hit = caps.find((c) => capMatches(c, where ?? {}));
        return Promise.resolve(hit ? clone(hit) : null);
      },
      create: ({ data }: any) => {
        const row: CapRow = { id: `cap-${idSeq++}`, ...data };
        caps.push(row);
        return Promise.resolve(clone(row));
      },
      update: ({ where, data }: any) => {
        const row = caps.find((c) => c.id === where.id);
        if (!row) return Promise.reject(new Error('not found'));
        Object.entries(data).forEach(([k, v]) => {
          if (v !== undefined) (row as any)[k] = v;
        });
        return Promise.resolve(clone(row));
      },
      delete: ({ where }: any) => {
        const idx = caps.findIndex((c) => c.id === where.id);
        if (idx === -1) return Promise.reject(new Error('not found'));
        const [row] = caps.splice(idx, 1);
        return Promise.resolve(clone(row));
      },
    },
    cap_policy_events: { create: ({ data }: any) => Promise.resolve(data) },
    $transaction: async (cb: any) => cb(mock),
  };
  return mock;
}

const emailStub = { sendCapAlertEmail: jest.fn() } as any;
const svc = (mock: any) => new CostControlService(mock as any, emailStub);

const org = (providerScope: string, amountUsd: number) => ({
  scope: CapScopeDto.ORG,
  providerScope,
  amountUsd,
  period: CapPeriodDto.WEEK,
  mode: CapModeDto.ENFORCE,
});

const dev = (providerScope: string, amountUsd: number, who = 'dev@co.example') => ({
  scope: CapScopeDto.DEV,
  scopeValue: who,
  providerScope,
  amountUsd,
  period: CapPeriodDto.WEEK,
  mode: CapModeDto.ENFORCE,
});

describe("org-ceiling changes vs children on the 'all' fallback path", () => {
  it("rejects lowering the 'all' ceiling below a provider-specific child that falls back to it", async () => {
    const mock = buildCapOnlyMockPrisma();
    const s = svc(mock);
    const allCeiling = await s.createCap(ORG, ACTOR, org('all', 500));
    await s.createCap(ORG, ACTOR, dev('anthropic', 400));

    await expect(s.updateCap(ORG, allCeiling.id, ACTOR, { amountUsd: 200 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects deleting a provider ceiling when its children would then exceed the 'all' fallback", async () => {
    const mock = buildCapOnlyMockPrisma();
    const s = svc(mock);
    const claudeCeiling = await s.createCap(ORG, ACTOR, org('anthropic', 500));
    await s.createCap(ORG, ACTOR, dev('anthropic', 400));
    await s.createCap(ORG, ACTOR, org('all', 200));

    await expect(s.deleteCap(ORG, claudeCeiling.id, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still allows deleting an org ceiling when no other ceiling would apply to its children', async () => {
    const mock = buildCapOnlyMockPrisma();
    const s = svc(mock);
    const claudeCeiling = await s.createCap(ORG, ACTOR, org('anthropic', 500));
    await s.createCap(ORG, ACTOR, dev('anthropic', 400));

    // deleteCap also returns the removed cap (so the controller can echo a
    // plain sentence). Match the stable field, not exact shape.
    await expect(s.deleteCap(ORG, claudeCeiling.id, ACTOR)).resolves.toMatchObject({
      deleted: true,
    });
  });
});

describe('cap-policy DTO bounds', () => {
  const base = {
    scope: CapScopeDto.DEV,
    scopeValue: 'dev@co.example',
    providerScope: 'all',
    amountUsd: 200,
    period: CapPeriodDto.WEEK,
    mode: CapModeDto.TRACK,
  };

  const build = <T>(cls: new () => T, data: object): T => Object.assign(new cls(), data);

  it('accepts a sane create payload (negative control)', async () => {
    expect(await validate(build(CreateCapPolicyDto, base) as object)).toHaveLength(0);
  });

  it('rejects an amountUsd above the $50M numeric ceiling', async () => {
    const errs = await validate(
      build(CreateCapPolicyDto, { ...base, amountUsd: 51_000_000 }) as object,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a scopeValue longer than 255 chars', async () => {
    const errs = await validate(
      build(CreateCapPolicyDto, { ...base, scopeValue: 'x'.repeat(300) }) as object,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a coolOffHours beyond one year', async () => {
    const errs = await validate(
      build(CreateCapPolicyDto, { ...base, coolOffHours: 100_000 }) as object,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects an over-bound amount on update too', async () => {
    const errs = await validate(build(UpdateCapPolicyDto, { amountUsd: 51_000_000 }) as object);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects an over-long customerExternalId on the spend query', async () => {
    const errs = await validate(
      build(QuerySpendDto, {
        period: CapPeriodDto.WEEK,
        customerExternalId: 'x'.repeat(300),
      }) as object,
    );
    expect(errs.length).toBeGreaterThan(0);
  });
});
