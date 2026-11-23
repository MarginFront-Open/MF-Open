/**
 * Validation proofs for the alert ladder on the
 * cap create DTO. Bounds: 1..100, whole integers, at most 5 rungs,
 * strictly ascending (which also dedups). Absent = the DB default {50,80,100}.
 */

import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateCapPolicyDto, CapModeDto, CapPeriodDto, CapScopeDto } from './create-cap-policy.dto';

async function validateDto(payload: unknown): Promise<ValidationError[]> {
  return validate(plainToInstance(CreateCapPolicyDto, payload as object));
}

const baseCap = {
  scope: CapScopeDto.ORG,
  providerScope: 'all',
  amountUsd: 200,
  period: CapPeriodDto.WEEK,
  mode: CapModeDto.TRACK,
};

const errorFor = (errors: ValidationError[]) =>
  errors.find((e) => e.property === 'alertThresholds');

describe('CreateCapPolicyDto.alertThresholds', () => {
  it('accepts the default ladder', async () => {
    expect(
      errorFor(await validateDto({ ...baseCap, alertThresholds: [50, 80, 100] })),
    ).toBeUndefined();
  });

  it('accepts absence (falls through to the DB default)', async () => {
    expect(errorFor(await validateDto(baseCap))).toBeUndefined();
  });

  it('rejects a non-ascending ladder (also the dedup rule)', async () => {
    expect(errorFor(await validateDto({ ...baseCap, alertThresholds: [80, 50] }))).toBeDefined();
  });

  it('rejects duplicate rungs (strictly ascending)', async () => {
    expect(
      errorFor(await validateDto({ ...baseCap, alertThresholds: [50, 50, 80] })),
    ).toBeDefined();
  });

  it('rejects a rung above 100', async () => {
    expect(errorFor(await validateDto({ ...baseCap, alertThresholds: [50, 120] }))).toBeDefined();
  });

  it('rejects a rung below 1', async () => {
    expect(errorFor(await validateDto({ ...baseCap, alertThresholds: [0, 50] }))).toBeDefined();
  });

  it('rejects more than 5 rungs', async () => {
    expect(
      errorFor(await validateDto({ ...baseCap, alertThresholds: [10, 20, 30, 40, 50, 60] })),
    ).toBeDefined();
  });

  it('rejects a non-integer rung', async () => {
    expect(errorFor(await validateDto({ ...baseCap, alertThresholds: [50.5, 80] }))).toBeDefined();
  });
});
