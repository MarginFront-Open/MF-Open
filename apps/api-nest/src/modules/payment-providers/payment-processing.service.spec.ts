/**
 * WHAT THIS FILE DOES: unit tests for PaymentProcessingService.createCheckoutSession
 *   focused on idempotent checkout init (checkout session reuse).
 * WHY IT EXISTS: clicking the email "Pay" link twice must not mint a second Stripe
 *   Checkout Session for the same invoice; completing both would double the
 *   invoice's amountPaid. Session reuse hands back the existing pending row's session.
 * CONNECTS TO:
 *   - payment-processing.service.ts (the code under test)
 *   - invoice-payment-reconciler.service.ts (the overpayment ceiling, tested separately)
 *   - public-invoice.controller.ts (the /v1/public/invoices/:id/checkout entry point)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PaymentProcessingService } from './payment-processing.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { PaymentAdapterFactory } from './payment-adapter.factory';

const INVOICE_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const CUST_ID = '33333333-3333-3333-3333-333333333333';
const PROVIDER_ID = '44444444-4444-4444-4444-444444444444';
const EXISTING_PENDING_ID = '55555555-5555-5555-5555-555555555555';
const EXISTING_SESSION_ID = 'cs_test_existing_session_id';
const EXISTING_SESSION_URL = 'https://checkout.stripe.com/c/pay/cs_test_existing_session_id';

interface MockInvoice {
  id: string;
  organizationId: string;
  customerId: string;
  status: string;
  amountPaid: string;
  amountDue: string;
  totalAmount: string;
  invoiceNumber: string;
  currency: string;
  customers: { id: string; email: string };
  organizations: { id: string; name: string; stripeAutomaticTax?: boolean };
  invoice_line_items: any[];
}

interface MockPendingPayment {
  id: string;
  invoiceId: string;
  status: string;
  provider_checkout_session_id: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  /** What that session collects. Re-use requires it to still be the answer. */
  amount: string;
  currency: string;
}

function buildInvoice(overrides: Partial<MockInvoice> = {}): MockInvoice {
  return {
    id: INVOICE_ID,
    organizationId: ORG_ID,
    customerId: CUST_ID,
    status: 'issued',
    amountPaid: '0',
    amountDue: '2.25',
    totalAmount: '2.25',
    invoiceNumber: 'INV-0001',
    currency: 'usd',
    customers: { id: CUST_ID, email: 'customer@example.com' },
    organizations: { id: ORG_ID, name: 'Example Org', stripeAutomaticTax: false },
    invoice_line_items: [],
    ...overrides,
  };
}

/** A pending row for a session that is still live and still collects 2.25. */
function livePending(overrides: Partial<MockPendingPayment> = {}): MockPendingPayment {
  return {
    id: EXISTING_PENDING_ID,
    invoiceId: INVOICE_ID,
    status: 'pending',
    provider_checkout_session_id: EXISTING_SESSION_ID,
    metadata: {
      checkoutSessionId: EXISTING_SESSION_ID,
      checkoutUrl: EXISTING_SESSION_URL,
      expiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
    },
    createdAt: new Date(Date.now() - 5 * 60 * 1000),
    amount: '2.25',
    currency: 'USD',
    ...overrides,
  };
}

function buildPrisma(opts: {
  pending?: MockPendingPayment | null;
  invoice?: Partial<MockInvoice>;
}) {
  return {
    invoices: {
      findUnique: jest.fn(async () => buildInvoice(opts.invoice ?? {})),
    },
    invoice_payments: {
      findFirst: jest.fn(async () => opts.pending ?? null),
      create: jest.fn(async ({ data }: any) => ({ ...data })),
    },
    payment_providers: {
      findFirst: jest.fn(async () => ({
        id: PROVIDER_ID,
        type: 'stripe',
        is_active: true,
        is_default: true,
        organization_id: ORG_ID,
      })),
    },
  } as any;
}

function buildAdapterFactory(mintSpy: jest.Mock) {
  return {
    createAdapter: jest.fn(() => ({
      providerType: 'stripe',
      createCheckoutSession: mintSpy,
    })),
  } as unknown as PaymentAdapterFactory;
}

function buildConfig(): ConfigService {
  return {
    get: jest.fn((k: string) => {
      if (k === 'FRONTEND_URL') return 'http://localhost:3000';
      return undefined;
    }),
  } as unknown as ConfigService;
}

describe('PaymentProcessingService.createCheckoutSession — reuses a live session', () => {
  async function build(prisma: any, adapterFactory: PaymentAdapterFactory) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentProcessingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: buildConfig() },
        { provide: PaymentAdapterFactory, useValue: adapterFactory },
      ],
    }).compile();
    return module.get<PaymentProcessingService>(PaymentProcessingService);
  }

  it('first click — no pending row → mints a new Stripe session and creates a pending row', async () => {
    const prisma = buildPrisma({ pending: null });
    const mintSpy = jest.fn(async () => ({
      sessionId: 'cs_test_first',
      url: 'https://checkout.stripe.com/c/pay/cs_test_first',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }));
    const factory = buildAdapterFactory(mintSpy);
    const svc = await build(prisma, factory);

    const result = await svc.createCheckoutSession(INVOICE_ID);

    expect(mintSpy).toHaveBeenCalledTimes(1); // we DID hit the adapter
    expect(result.sessionId).toBe('cs_test_first');
    expect(prisma.invoice_payments.create).toHaveBeenCalledTimes(1); // new pending row stored
    // The findFirst was called (the idempotency check fires every time).
    expect(prisma.invoice_payments.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoiceId: INVOICE_ID,
          status: 'pending',
        }),
      }),
    );
  });

  it('second click — live session collecting the same money → returns SAME session, no adapter call', async () => {
    const pending = livePending();
    const prisma = buildPrisma({ pending });
    const mintSpy = jest.fn();
    const factory = buildAdapterFactory(mintSpy);
    const svc = await build(prisma, factory);

    const result = await svc.createCheckoutSession(INVOICE_ID);

    // The whole point: adapter NOT called the second time.
    expect(mintSpy).not.toHaveBeenCalled();
    // No second pending row created.
    expect(prisma.invoice_payments.create).not.toHaveBeenCalled();
    // We hand back the SAME session URL the first call minted.
    expect(result.sessionId).toBe(EXISTING_SESSION_ID);
    expect(result.url).toBe(EXISTING_SESSION_URL);
    // The provider's own expiry, carried through — not one we guessed.
    expect(result.expiresAt).toBe((pending.metadata as any).expiresAt);
  });

  it('the customer part-paid in between → the cached link would charge the old total, so mint a new one', async () => {
    // The invoice was $2.25 when the first link was minted; $2.00 of
    // it arrived off-platform since. Re-using that link charges $2.25 against a
    // $0.25 balance — the exact over-charge collecting the balance exists to
    // stop, walked back in by the cache in front of it.
    const prisma = buildPrisma({
      pending: livePending(),
      invoice: { amountDue: '0.25', amountPaid: '2.00' },
    });
    const mintSpy = jest.fn(async (_args: { charge: { totalMinor: number } }) => ({
      sessionId: 'cs_test_balance',
      url: 'https://checkout.stripe.com/c/pay/cs_test_balance',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }));
    const svc = await build(prisma, buildAdapterFactory(mintSpy));

    const result = await svc.createCheckoutSession(INVOICE_ID);

    expect(result.sessionId).toBe('cs_test_balance');
    expect(mintSpy).toHaveBeenCalledTimes(1);
    // And the new session collects the BALANCE, not the header total.
    expect(mintSpy.mock.calls[0][0].charge.totalMinor).toBe(25);
  });

  it('the cached session already expired → mint a new one rather than hand out a dead link', async () => {
    // Stripe sets expires_at to 30 minutes (stripe.adapter.ts), so a row
    // younger than a day can still hold a dead session.
    const prisma = buildPrisma({
      pending: livePending({
        metadata: {
          checkoutSessionId: EXISTING_SESSION_ID,
          checkoutUrl: EXISTING_SESSION_URL,
          expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
        },
        createdAt: new Date(Date.now() - 40 * 60 * 1000),
      }),
    });
    const mintSpy = jest.fn(async () => ({
      sessionId: 'cs_test_fresh',
      url: 'https://checkout.stripe.com/c/pay/cs_test_fresh',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }));
    const svc = await build(prisma, buildAdapterFactory(mintSpy));

    const result = await svc.createCheckoutSession(INVOICE_ID);

    expect(result.sessionId).toBe('cs_test_fresh');
    expect(mintSpy).toHaveBeenCalledTimes(1);
  });

  it('records the provider expiry on the pending row, so the next call can read a real TTL', async () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const prisma = buildPrisma({ pending: null });
    const mintSpy = jest.fn(async () => ({
      sessionId: 'cs_test_first',
      url: 'https://checkout.stripe.com/c/pay/cs_test_first',
      expiresAt,
    }));
    const svc = await build(prisma, buildAdapterFactory(mintSpy));

    await svc.createCheckoutSession(INVOICE_ID);

    expect(prisma.invoice_payments.create.mock.calls[0][0].data.metadata.expiresAt).toBe(expiresAt);
  });

  it('falls through to a new session if the existing pending row has malformed metadata', async () => {
    // Defensive: a pending row may lack the checkoutSessionId/checkoutUrl
    // fields in metadata. Don't 500; mint a fresh session.
    const pending = livePending({
      provider_checkout_session_id: 'cs_test_no_metadata',
      metadata: null,
      createdAt: new Date(Date.now() - 60 * 1000),
    });
    const prisma = buildPrisma({ pending });
    const mintSpy = jest.fn(async () => ({
      sessionId: 'cs_test_fallback',
      url: 'https://checkout.stripe.com/c/pay/cs_test_fallback',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }));
    const factory = buildAdapterFactory(mintSpy);
    const svc = await build(prisma, factory);

    const result = await svc.createCheckoutSession(INVOICE_ID);

    expect(mintSpy).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe('cs_test_fallback');
  });
});
