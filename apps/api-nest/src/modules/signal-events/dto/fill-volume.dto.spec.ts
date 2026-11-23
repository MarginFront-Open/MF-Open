/**
 * Validation tests for FillVolumeDto.
 *
 * quantity accepts any non-negative number (@IsNumber() + @Min(0)) so a
 * caller backfilling a fractionally-billed non-LLM service (e.g. 0.5 GB) can
 * send the real quantity. Every non-negative integer validates too.
 */

import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { FillVolumeDto } from './fill-volume.dto';

async function validateDto(payload: unknown): Promise<ValidationError[]> {
  const instance = plainToInstance(FillVolumeDto, payload as object);
  return await validate(instance);
}

const baseNonLlm = {
  sourceModel: 'google-maps-places',
  sourceProvider: 'google',
};

describe('FillVolumeDto.quantity', () => {
  it('accepts a fractional quantity', async () => {
    const errors = await validateDto({ ...baseNonLlm, quantity: 0.066 });
    expect(errors).toEqual([]);
  });

  it('still accepts an integer quantity (widen, not narrow)', async () => {
    const errors = await validateDto({ ...baseNonLlm, quantity: 5 });
    expect(errors).toEqual([]);
  });

  it('accepts zero (explicit zero is a valid quantity)', async () => {
    const errors = await validateDto({ ...baseNonLlm, quantity: 0 });
    expect(errors).toEqual([]);
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a negative number', -1],
  ])('rejects %s', async (_label, badValue) => {
    const errors = await validateDto({ ...baseNonLlm, quantity: badValue });
    expect(errors.some((e) => e.property === 'quantity')).toBe(true);
  });

  it('rejects a non-numeric string', async () => {
    const errors = await validateDto({ ...baseNonLlm, quantity: 'not-a-number' });
    expect(errors.some((e) => e.property === 'quantity')).toBe(true);
  });

  it('still requires inputTokens/outputTokens to be integers', async () => {
    const errors = await validateDto({
      sourceModel: 'claude-sonnet-4-6',
      sourceProvider: 'anthropic',
      inputTokens: 1.5,
      outputTokens: 500,
    });
    expect(errors.some((e) => e.property === 'inputTokens')).toBe(true);
  });
});
