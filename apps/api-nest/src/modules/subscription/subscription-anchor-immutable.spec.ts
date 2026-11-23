/**
 * Billing-anchor immutability tests.
 *
 * PATCH /v1/subscriptions/{id} must not return 200 while silently discarding
 * startDate / currentBillingPeriodStart / currentBillingPeriodEnd: the global
 * pipe runs whitelist:false, so those fields ride onto the DTO, and the service's
 * field-by-field spread never reads them. A caller moving a billing window would
 * get a 200 with no change.
 *
 * The anchors are immutable after creation because the dispatch cron selects usage
 * events BY PERIOD (subscription-billing.service.ts) — moving a live subscription's
 * window re-bills or orphans events. So both layers reject loudly instead of
 * making them mutable:
 *   1. DTO layer  — RejectsBillingAnchorMutation returns a 400 at the HTTP boundary.
 *   2. Service layer — updateSubscription throws BadRequestException for any non-HTTP
 *      caller, so the silent drop can never happen from any path.
 * Both layers share one message (billingAnchorImmutableMessage) so the text can't drift.
 *
 * Convention matches subscription-xtenant.service.spec.ts: in-memory mock Prisma +
 * NestJS Testing module for the service, plain class-validator for the DTO.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SubscriptionService } from './subscription.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import {
  UpdateSubscriptionDto,
  BILLING_ANCHOR_FIELDS,
  billingAnchorImmutableMessage,
} from './dto/update-subscription.dto';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUB_A = '11111111-1111-1111-1111-111111111111';
const ACTING_USER = '99999999-9999-9999-9999-999999999999';

// Fixed anchor values seeded on the subscription so tests can prove they are
// untouched after a normal (non-anchor) PATCH.
const SEEDED_PERIOD_START = new Date('2026-01-01T00:00:00.000Z');
const SEEDED_PERIOD_END = new Date('2026-02-01T00:00:00.000Z');
const SEEDED_START_DATE = new Date('2026-01-01T00:00:00.000Z');

describe('UpdateSubscriptionDto — rejects billing-anchor mutation', () => {
  // Mirrors the global pipe in main.ts (whitelist:false, transform:true), the exact
  // config under which a silent drop would happen.
  const toDto = (payload: Record<string, unknown>) =>
    plainToInstance(UpdateSubscriptionDto, payload, { enableImplicitConversion: true });

  it('PASSES a normal PATCH with no anchor fields', async () => {
    const errors = await validate(toDto({ name: 'Renamed', changeReason: 'rename' }), {
      whitelist: false,
      forbidNonWhitelisted: false,
    });
    expect(errors).toHaveLength(0);
  });

  it.each(BILLING_ANCHOR_FIELDS)(
    'REJECTS a PATCH carrying %s with the immutable message',
    async (field) => {
      const errors = await validate(
        toDto({ [field]: new Date().toISOString(), changeReason: 'move window' }),
        { whitelist: false, forbidNonWhitelisted: false },
      );
      const anchorError = errors.find((e) => e.constraints?.rejectsBillingAnchorMutation);
      expect(anchorError).toBeDefined();
      expect(anchorError!.constraints!.rejectsBillingAnchorMutation).toBe(
        billingAnchorImmutableMessage([field]),
      );
    },
  );

  it('names every submitted anchor when several are sent at once', async () => {
    const errors = await validate(
      toDto({
        startDate: new Date().toISOString(),
        currentBillingPeriodStart: new Date().toISOString(),
        currentBillingPeriodEnd: new Date().toISOString(),
        changeReason: 'move window',
      }),
      { whitelist: false, forbidNonWhitelisted: false },
    );
    const message = errors.find((e) => e.constraints?.rejectsBillingAnchorMutation)!.constraints!
      .rejectsBillingAnchorMutation;
    expect(message).toBe(billingAnchorImmutableMessage([...BILLING_ANCHOR_FIELDS]));
  });
});

describe('SubscriptionService.updateSubscription — billing-anchor backstop', () => {
  let service: SubscriptionService;
  let prisma: any;
  let subscriptionRow: any;

  beforeEach(async () => {
    subscriptionRow = {
      id: SUB_A,
      organizationId: ORG_A,
      name: 'Sub A',
      status: 'active',
      startDate: SEEDED_START_DATE,
      currentBillingPeriodStart: SEEDED_PERIOD_START,
      currentBillingPeriodEnd: SEEDED_PERIOD_END,
    };

    prisma = {
      subscriptions: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === subscriptionRow.id && where.organizationId === subscriptionRow.organizationId
            ? subscriptionRow
            : null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          if (where.id !== subscriptionRow.id) throw new Error('record not found');
          Object.assign(subscriptionRow, data);
          return subscriptionRow;
        }),
      },
      subscription_change_logs: {
        create: jest.fn(async ({ data }: any) => data),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: SubscriptionBillingService, useValue: {} },
      ],
    }).compile();

    service = module.get(SubscriptionService);
  });

  it.each(BILLING_ANCHOR_FIELDS)('REJECTS %s with a 400 and writes nothing', async (field) => {
    await expect(
      service.updateSubscription(SUB_A, ORG_A, ACTING_USER, {
        [field]: new Date('2026-06-01T00:00:00.000Z'),
        changeReason: 'move window',
      } as any),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateSubscription(SUB_A, ORG_A, ACTING_USER, {
        [field]: new Date('2026-06-01T00:00:00.000Z'),
        changeReason: 'move window',
      } as any),
    ).rejects.toThrow(billingAnchorImmutableMessage([field]));
    expect(prisma.subscriptions.update).not.toHaveBeenCalled();
    expect(prisma.subscription_change_logs.create).not.toHaveBeenCalled();
  });

  it('a normal PATCH still works and the response reflects stored state — anchors unchanged', async () => {
    const result = await service.updateSubscription(SUB_A, ORG_A, ACTING_USER, {
      name: 'Renamed',
      status: 'canceled',
      changeReason: 'rename + cancel',
    } as any);

    // Requested fields applied.
    expect(result.name).toBe('Renamed');
    expect(result.status).toBe('canceled');

    // Anchors are exactly what was stored — never touched by the write.
    const writeData = prisma.subscriptions.update.mock.calls[0][0].data;
    for (const field of BILLING_ANCHOR_FIELDS) {
      expect(writeData).not.toHaveProperty(field);
    }
    expect(result.startDate).toEqual(SEEDED_START_DATE);
    expect(result.currentBillingPeriodStart).toEqual(SEEDED_PERIOD_START);
    expect(result.currentBillingPeriodEnd).toEqual(SEEDED_PERIOD_END);

    // The returned object IS the persisted row (response mirrors DB, no phantom values).
    expect(result).toBe(subscriptionRow);
    expect(prisma.subscription_change_logs.create).toHaveBeenCalled();
  });
});
