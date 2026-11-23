/**
 * Cross-tenant WRITE tests for OnboardingController.
 *
 * The three create handlers (createFromEnhancedPreview / onboardFromWebsite / quickOnboard)
 * write customers/pricing/agents/subscriptions keyed off the request body's `organizationId`,
 * so the caller must belong to that org, not only name an org that exists.
 *
 * These tests drive the controller's assertOrgMembership gate (every write route funnels
 * through it) and prove: a caller whose active org IS the target passes without a DB hit; a
 * ba_member of the target passes; a non-member is denied 403 and the service is never called;
 * an api-key (no userId) on another org fails closed without an undefined-userId query.
 */

import { ForbiddenException } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';

const TARGET_ORG = 'org-target';

function makePrisma(membership: { role: string } | null) {
  return {
    ba_member: { findFirst: jest.fn().mockResolvedValue(membership) },
  } as any;
}

function makeService() {
  return {
    createFromPreview: jest.fn().mockResolvedValue({ ok: 'create' }),
    onboardFromWebsite: jest.fn().mockResolvedValue({ ok: 'website' }),
    quickOnboard: jest.fn().mockResolvedValue({ ok: 'quick' }),
  } as any;
}

const previewDto = () => ({ organizationId: TARGET_ORG, previewData: {} }) as any;
const websiteDto = () => ({ organizationId: TARGET_ORG, websiteUrl: 'https://x.com' }) as any;
const quickDto = () => ({ organizationId: TARGET_ORG }) as any;

describe('OnboardingController cross-tenant write gate', () => {
  it('ALLOWS the just-signed-up owner whose active org IS the target — no DB hit', async () => {
    const prisma = makePrisma(null);
    const service = makeService();
    const c = new OnboardingController(service, prisma);
    const user = { userId: 'human-1', organizationId: TARGET_ORG, authMethod: 'session' } as any;

    await expect(c.createFromEnhancedPreview(user, previewDto())).resolves.toEqual({
      ok: 'create',
    });
    expect(service.createFromPreview).toHaveBeenCalledTimes(1);
    expect(prisma.ba_member.findFirst).not.toHaveBeenCalled();
  });

  it('ALLOWS a ba_member of the target org even when it is not their active org', async () => {
    const prisma = makePrisma({ role: 'admin' });
    const service = makeService();
    const c = new OnboardingController(service, prisma);
    const user = { userId: 'human-2', organizationId: 'other-org', authMethod: 'session' } as any;

    await expect(c.quickOnboard(user, quickDto())).resolves.toEqual({ ok: 'quick' });
    expect(prisma.ba_member.findFirst).toHaveBeenCalledWith({
      where: { organizationId: TARGET_ORG, userId: 'human-2' },
      select: { role: true },
    });
    expect(service.quickOnboard).toHaveBeenCalledTimes(1);
  });

  it('DENIES a non-member with 403 and never calls the service (cross-tenant write blocked)', async () => {
    const prisma = makePrisma(null);
    const service = makeService();
    const c = new OnboardingController(service, prisma);
    const user = { userId: 'attacker', organizationId: 'other-org', authMethod: 'session' } as any;

    await expect(c.onboardFromWebsite(user, websiteDto())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(service.onboardFromWebsite).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: an api-key (no userId) on another org is denied without an undefined-userId query', async () => {
    const prisma = makePrisma({ role: 'owner' });
    const service = makeService();
    const c = new OnboardingController(service, prisma);
    const user = { userId: undefined, organizationId: 'key-own-org', authMethod: 'api-key' } as any;

    await expect(c.createFromEnhancedPreview(user, previewDto())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.ba_member.findFirst).not.toHaveBeenCalled();
    expect(service.createFromPreview).not.toHaveBeenCalled();
  });

  it('ALLOWS a same-org api-key (no userId) — the fast-path covers a valid own-org key', async () => {
    const prisma = makePrisma(null);
    const service = makeService();
    const c = new OnboardingController(service, prisma);
    const user = { userId: undefined, organizationId: TARGET_ORG, authMethod: 'api-key' } as any;

    await expect(c.quickOnboard(user, quickDto())).resolves.toEqual({ ok: 'quick' });
    expect(prisma.ba_member.findFirst).not.toHaveBeenCalled();
    expect(service.quickOnboard).toHaveBeenCalledTimes(1);
  });
});
