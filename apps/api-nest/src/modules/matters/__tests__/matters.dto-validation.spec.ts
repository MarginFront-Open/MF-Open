/**
 * Pins the DTO-level 400s for malformed inputs that would otherwise
 * slip past @IsOptional and reach Prisma as 500s: an explicit null rule
 * matterId, a non-UUID responsibleUserId on PATCH, and a garbage audit window
 * date. class-validator runs directly here; the app's global ValidationPipe
 * turns any constraint violation these tests assert into the 400.
 */

import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MatterAuditQueryDto, UpdateMatterDto, UpdateMatterRuleDto } from '../dto';

// A real v4 — isUUID rejects the spec suite's all-b fixture ids (version nibble).
const MATTER_ID = '3f8e8f04-2b8e-4b57-9d5a-1a2b3c4d5e6f';

async function violationsFor(dto: object): Promise<string[]> {
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('UpdateMatterRuleDto.matterId — explicit null is a 400, not a Prisma 500', () => {
  it('rejects an explicit null (a rule always targets a matter)', async () => {
    const dto = plainToInstance(UpdateMatterRuleDto, { matterId: null });
    expect(await violationsFor(dto)).not.toHaveLength(0);
  });

  it('rejects a non-UUID string', async () => {
    const dto = plainToInstance(UpdateMatterRuleDto, { matterId: 'bob' });
    expect(await violationsFor(dto)).not.toHaveLength(0);
  });

  it('accepts an omitted matterId (PATCH keeps the current target) and a real UUID', async () => {
    expect(await violationsFor(plainToInstance(UpdateMatterRuleDto, {}))).toHaveLength(0);
    expect(
      await violationsFor(plainToInstance(UpdateMatterRuleDto, { matterId: MATTER_ID })),
    ).toHaveLength(0);
  });
});

describe('UpdateMatterDto.responsibleUserId — junk 400s, null still clears', () => {
  it('rejects a non-UUID string, matching what POST already did', async () => {
    const dto = plainToInstance(UpdateMatterDto, { responsibleUserId: 'bob' });
    expect(await violationsFor(dto)).not.toHaveLength(0);
  });

  it('accepts explicit null (the documented "clear it" value) and omission', async () => {
    expect(
      await violationsFor(plainToInstance(UpdateMatterDto, { responsibleUserId: null })),
    ).toHaveLength(0);
    expect(await violationsFor(plainToInstance(UpdateMatterDto, {}))).toHaveLength(0);
  });
});

describe('MatterAuditQueryDto window dates — garbage 400s naming the accepted formats', () => {
  it.each([
    ['a loose phrase', 'lastweek'],
    ['a US-style date', '9/1/2026'],
    ['an empty string', ''],
  ])('rejects %s on start', async (_label, value) => {
    const violations = await violationsFor(plainToInstance(MatterAuditQueryDto, { start: value }));
    expect(violations).not.toHaveLength(0);
    expect(violations.join(' ')).toContain('YYYY-MM-DD');
  });

  it.each([
    ['a rollover date (V8 reads it as Mar 3)', '2026-02-31'],
    ['a year-month fragment (V8 reads it as Aug 1)', '2026-08'],
  ])(
    'accepts %s — V8 parses it, so the dashboard parser does too (parity, no 500)',
    async (_label, value) => {
      // The validator's only contract is "nothing that passes can 500 in
      // parseAuditWindow"; it deliberately mirrors the parser's leniency rather
      // than second-guessing it, or REST would 400 windows the dashboard accepts.
      expect(
        await violationsFor(plainToInstance(MatterAuditQueryDto, { start: value })),
      ).toHaveLength(0);
    },
  );

  it('rejects garbage on end with the format-naming message too', async () => {
    const violations = await violationsFor(plainToInstance(MatterAuditQueryDto, { end: 'soon' }));
    expect(violations.join(' ')).toContain('YYYY-MM-DD');
  });

  it('accepts the two documented formats and full omission', async () => {
    for (const query of [
      { start: '2026-08-01' },
      { start: '2026-08-01T14:30:00Z', end: '2026-08-31' },
      {},
    ]) {
      expect(await violationsFor(plainToInstance(MatterAuditQueryDto, query))).toHaveLength(0);
    }
  });
});
