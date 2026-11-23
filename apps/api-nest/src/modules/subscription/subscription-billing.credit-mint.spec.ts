/**
 * WHAT THIS FILE DOES: pins the credit-pool mint hooks in
 * SubscriptionBillingService and the do-no-harm seam.
 *
 * 1. ACTIVATION MINT — functional, against mocked deps: activateSubscription
 *    mints on THIS.PRISMA (never the caller-supplied transaction — a caught
 *    failed write inside an open Postgres tx aborts the whole tx), passes the
 *    JUST-COMPUTED period explicitly (the caller's tx may not have committed
 *    the row yet), and a mint failure never breaks activation.
 *
 * 2. DISPATCH MINT PLACEMENT — source assertions (the dispatch loop needs a
 *    live DB to execute end-to-end): the mint sits AFTER the "Transaction
 *    committed" marker (never a caught write inside the interactive
 *    transaction), BEFORE the zero-usage continue (fresh
 *    no-usage periods still mint), and runs on this.prisma.
 *
 * 3. INVOICE PARITY (do-no-harm) — source assertions: the billers
 *    (invoice-calculator.service.ts, @marginfront/db revenue-calc.ts) never
 *    reference a credit-ledger table, so track-mode invoice totals CANNOT
 *    change with the ledger present. The math-level bit-for-bit fixture
 *    lives in packages/db/src/lib/credit-ledger.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { mintPeriodGrant } from '@marginfront/db';
import { SubscriptionBillingService } from './subscription-billing.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { InvoiceCalculatorService } from '../invoice-calculator/invoice-calculator.service';
import { PdfService } from '../pdf/pdf.service';
import { PaymentProcessingService } from '../payment-providers/payment-processing.service';
import { EmailService } from '../email/email.service';

jest.mock('@marginfront/db', () => ({
  ...jest.requireActual('@marginfront/db'),
  mintPeriodGrant: jest.fn(),
}));

const mintMock = mintPeriodGrant as jest.Mock;

const SUB = {
  id: 'sub-uuid',
  organizationId: 'org-uuid',
  planId: 'plan-uuid',
  startDate: new Date('2026-06-15T00:00:00.000Z'),
  billingCycle: 'monthly',
  billingModel: 'usage',
  timezone: 'UTC',
  cycleNumber: 0,
};

async function buildService(prisma: any): Promise<SubscriptionBillingService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SubscriptionBillingService,
      { provide: PrismaService, useValue: prisma },
      { provide: InvoiceCalculatorService, useValue: {} },
      { provide: PdfService, useValue: {} },
      { provide: PaymentProcessingService, useValue: {} },
      { provide: EmailService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn() } },
    ],
  }).compile();
  return module.get(SubscriptionBillingService);
}

beforeEach(() => {
  mintMock.mockReset();
  mintMock.mockResolvedValue({ minted: false, reason: 'notCreditPool' });
});

describe('activateSubscription credit-pool mint', () => {
  function freshPrisma() {
    return {
      subscriptions: {
        update: jest.fn(async ({ data }: any) => ({ ...SUB, ...data })),
      },
    };
  }

  it('mints on this.prisma with the JUST-COMPUTED period — even when a caller transaction is in play', async () => {
    const prisma = freshPrisma();
    const svc = await buildService(prisma);
    const draftsSpy = jest.spyOn(svc, 'createInitialDraftInvoices').mockResolvedValue(undefined);
    // A caller-supplied tx client: the period write goes through IT…
    const tx: any = {
      subscriptions: {
        update: jest.fn(async ({ data }: any) => ({ ...SUB, ...data })),
      },
    };

    await svc.activateSubscription({ ...SUB }, tx);

    expect(tx.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(draftsSpy).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledTimes(1);
    const [clientArg, inputArg] = mintMock.mock.calls[0];
    // …but the mint NEVER does: this.prisma only (the caught-write-inside-tx
    // trap), with the period passed explicitly because the tx hasn't
    // committed the subscription row yet.
    expect(clientArg).toBe(prisma);
    expect(inputArg.createdBy).toBe('activation');
    expect(inputArg.subscription.id).toBe(SUB.id);
    expect(inputArg.subscription.planId).toBe(SUB.planId);
    const writtenPeriod = tx.subscriptions.update.mock.calls[0][0].data;
    expect(inputArg.subscription.currentBillingPeriodStart).toEqual(
      writtenPeriod.currentBillingPeriodStart,
    );
    expect(inputArg.subscription.currentBillingPeriodEnd).toEqual(
      writtenPeriod.currentBillingPeriodEnd,
    );
  });

  it('a mint failure never breaks activation (non-fatal; lazy mint covers)', async () => {
    const prisma = freshPrisma();
    const svc = await buildService(prisma);
    jest.spyOn(svc, 'createInitialDraftInvoices').mockResolvedValue(undefined);
    mintMock.mockRejectedValue(new Error('unique index rebuild in progress'));

    const updated = await svc.activateSubscription({ ...SUB });

    expect(updated.status).toBe('active');
    expect(mintMock).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch mint placement + do-no-harm (source assertions)', () => {
  const billingSource = fs.readFileSync(
    path.join(__dirname, 'subscription-billing.service.ts'),
    'utf8',
  );

  it('the dispatch mint is POST-COMMIT: after the committed marker, before the zero-usage continue, on this.prisma', () => {
    const dispatchIdx = billingSource.indexOf('async dispatchUsageInvoices(');
    expect(dispatchIdx).toBeGreaterThan(-1);
    const markerIdx = billingSource.indexOf('── Transaction committed. ──', dispatchIdx);
    expect(markerIdx).toBeGreaterThan(dispatchIdx);
    const mintIdx = billingSource.indexOf('mintPeriodGrant(this.prisma', dispatchIdx);
    expect(mintIdx).toBeGreaterThan(markerIdx);
    const zeroUsageIdx = billingSource.indexOf('if (zeroUsage)', markerIdx);
    expect(zeroUsageIdx).toBeGreaterThan(mintIdx);
  });

  it('NO mint call inside the dispatch interactive transaction (a failed statement would abort the whole tx)', () => {
    const dispatchIdx = billingSource.indexOf('async dispatchUsageInvoices(');
    const markerIdx = billingSource.indexOf('── Transaction committed. ──', dispatchIdx);
    const insideTx = billingSource.slice(dispatchIdx, markerIdx);
    expect(insideTx).not.toContain('mintPeriodGrant');
  });

  it('do-no-harm: the invoice calculator never reads a credit-ledger table', () => {
    const calcSource = fs.readFileSync(
      path.join(__dirname, '..', 'invoice-calculator', 'invoice-calculator.service.ts'),
      'utf8',
    );
    expect(calcSource).not.toMatch(/credit_(grants|ledger_entries|pool_balances)/);
    // Matches PROSE too — cite ledger helpers by symbol name, never filename.
    expect(calcSource).not.toMatch(/credit-ledger/);
  });

  it('do-no-harm: the canonical billing math (revenue-calc.ts) never reads a credit-ledger table', () => {
    const revenueCalcPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'packages',
      'db',
      'src',
      'lib',
      'revenue-calc.ts',
    );
    const revenueSource = fs.readFileSync(revenueCalcPath, 'utf8');
    expect(revenueSource).not.toMatch(/credit_(grants|ledger_entries|pool_balances)/);
    expect(revenueSource).not.toMatch(/credit-ledger/);
  });
});
