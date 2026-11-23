/**
 * WHAT A PROVIDER COLLECTS MUST EQUAL WHAT THE INVOICE SAYS.
 *
 * Stripe Checkout does not accept a total. It accepts rows, and it charges the
 * customer Σ(unit_amount × quantity) over those rows. So every line the
 * calculator can emit has to survive the whole trip — calculator, the
 * invoice_line_items writer, numeric(12,2) storage, the checkout mapper, the
 * adapter — and still come back to the invoice. When it doesn't, nothing
 * errors: the customer pays the wrong number and the merchant finds out at
 * reconciliation.
 *
 * This file drives the REAL objects end to end:
 *
 *   InvoiceCalculatorService.calculateInvoice   (real, mocked Prisma)
 *     → createOrUpdateInvoiceLineItems          (real writer, invoice.utils)
 *       → numeric(12,2)                         (modelled — see storedDecimal)
 *         → PaymentProcessingService            (real, builds the charge)
 *           → StripeAdapter                     (real, only the SDK is mocked)
 *
 * Only the Stripe SDK and the database are stubs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE DOES NOT KEEP A HAND-WRITTEN LIST OF SHAPES
 *
 * A fixture table is a promise that somebody remembered, and it covers only
 * the shapes that existed the day it was written.
 *
 * So the list of shapes that MUST be covered is derived, from two sources that
 * a new pricing shape cannot avoid touching:
 *
 *   1. the Prisma enums (chargeType, pricingModel) — a new shape needs a value;
 *   2. the switch arms in invoice-calculator.service.ts — it needs math.
 *
 * And the list of shapes that ARE covered is observed at run time, from the
 * line items the fixtures actually produce. Add `credit_sub_pool` to the schema
 * and this file goes red naming it, until a fixture exists that bills one and
 * collects it.
 *
 * WHAT THAT DOES NOT SEE, stated plainly so nobody trusts it further than it
 * goes: coverage is derived at ENUM granularity, not line granularity. A brand
 * new money-moving line emitted inside an existing arm, under a config no
 * fixture uses, reuses an enum pair that is already covered and slips past. The
 * last test in the derived-coverage block is a tripwire for exactly that, and
 * it is the one declared number in this file.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '@prisma/client/runtime/library';

const mockCheckoutSessionsCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: { create: mockCheckoutSessionsCreate, retrieve: jest.fn() },
    },
    refunds: { create: jest.fn() },
    paymentIntents: { retrieve: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
  }));
});

// Imported after jest.mock so the adapter binds to the mocked Stripe constructor.
import { InvoiceCalculatorService } from '../invoice-calculator/invoice-calculator.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createOrUpdateInvoiceLineItems } from '../../common/utils/invoice/invoice.utils';
import { PaymentProcessingService } from './payment-processing.service';
import { PaymentAdapterFactory } from './payment-adapter.factory';
import { StripeAdapter } from './adapters/stripe.adapter';
import { BundleReason } from './collectible-charge';

const ORG = '11111111-1111-1111-1111-111111111111';
const SUB = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '33333333-3333-3333-3333-333333333333';
const PLAN_ID = '44444444-4444-4444-4444-444444444444';
const INVOICE_ID = '55555555-5555-5555-5555-555555555555';
const SIGNAL_A = 'sig-a-uuid';
const SIGNAL_B = 'sig-b-uuid';
const MERCHANT_KEY = 'sk_test_MERCHANT_MERCHANT_MERCHANT';

// A full calendar month, so a sub that started before it prorates to 1.0.
const PERIOD_START = new Date('2026-05-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-06-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Strategy fixtures — one per line shape the calculator can emit.
// ---------------------------------------------------------------------------

const recurringStrategy = (rate: number) => ({
  id: 'strat-recurring',
  name: 'Monthly Platform Fee',
  chargeType: 'recurring',
  pricingModel: 'flat',
  rate: new Decimal(rate),
  tiers: null,
  minimumCommitment: null,
  signalId: null,
  signals: null,
});

const onetimeStrategy = (rate: number) => ({
  id: 'strat-onetime',
  name: 'Onboarding Setup',
  chargeType: 'onetime',
  pricingModel: 'flat',
  rate: new Decimal(rate),
  tiers: null,
  minimumCommitment: null,
  signalId: null,
  signals: null,
});

const seatStrategy = (rate: number, minimumCommitment: number | null = null) => ({
  id: 'strat-seat',
  name: 'Per Seat',
  chargeType: 'seat_based',
  pricingModel: 'flat',
  rate: new Decimal(rate),
  tiers: null,
  minimumCommitment: minimumCommitment === null ? null : new Decimal(minimumCommitment),
  signalId: null,
  signals: null,
});

const flatUsageStrategy = (rate: number) => ({
  id: 'strat-usage-flat',
  name: 'Per API Call',
  chargeType: 'usage',
  pricingModel: 'flat',
  rate: new Decimal(rate),
  tiers: null,
  minimumCommitment: null,
  signalId: SIGNAL_B,
  signals: { id: SIGNAL_B, name: 'API Call', shortName: 'call' },
});

/** Graduated tiers land on a sub-cent blended per-unit price on purpose. */
const graduatedUsageStrategy = () => ({
  id: 'strat-usage-graduated',
  name: 'Tiered Calls',
  chargeType: 'usage',
  pricingModel: 'graduated',
  rate: null,
  tiers: [
    { lower: 0, upper: 100, rate: 0.07 },
    { lower: 100, upper: null, rate: 0.013 },
  ],
  minimumCommitment: null,
  signalId: SIGNAL_B,
  signals: { id: SIGNAL_B, name: 'API Call', shortName: 'call' },
});

const volumeUsageStrategy = () => ({
  id: 'strat-usage-volume',
  name: 'Volume Calls',
  chargeType: 'usage',
  pricingModel: 'volume',
  rate: null,
  tiers: [
    { lower: 0, upper: 100, rate: 0.05 },
    { lower: 100, upper: null, rate: 0.02 },
  ],
  minimumCommitment: null,
  signalId: SIGNAL_B,
  signals: { id: SIGNAL_B, name: 'API Call', shortName: 'call' },
});

/** $99 buys 1,000 credits; past that, 3 cents each. */
const poolStrategy = (creditRates: unknown = null, poolPrice = 99) => ({
  id: 'strat-pool',
  name: 'Credit Pool',
  chargeType: 'usage',
  pricingModel: 'credit_pool',
  rate: null,
  tiers: [
    { lower: 0, upper: 1000, rate: poolPrice },
    { lower: 1000, upper: null, rate: 0.03 },
  ],
  minimumCommitment: null,
  signalId: SIGNAL_A,
  signals: { id: SIGNAL_A, name: 'Report', shortName: 'report' },
  creditRates,
});

/** The pool exists and still counts down; holding it costs nothing. */
const freePoolStrategy = (creditRates: unknown = null) => poolStrategy(creditRates, 0);

/** A fixed fee with no pricing model at all — the calculator's `null` arm. */
const noModelUsageStrategy = (rate: number) => ({
  id: 'strat-usage-no-model',
  name: 'Flat Per Report',
  chargeType: 'usage',
  pricingModel: null,
  rate: new Decimal(rate),
  tiers: null,
  minimumCommitment: null,
  signalId: SIGNAL_A,
  signals: { id: SIGNAL_A, name: 'Report', shortName: 'report' },
});

function makeSubscription(strategies: any[], overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    customerId: CUSTOMER,
    organizationId: ORG,
    planId: PLAN_ID,
    startDate: new Date('2026-04-01T00:00:00.000Z'),
    endDate: null,
    cycleNumber: 1,
    seatsCount: 0,
    billingCycle: 'monthly',
    customCycleDays: null,
    currentBillingPeriodStart: PERIOD_START,
    currentBillingPeriodEnd: PERIOD_END,
    ...overrides,
    pricing_plans: { id: PLAN_ID, pricing_strategies: strategies },
  };
}

// ---------------------------------------------------------------------------
// The chain. Each step is the real thing with its I/O stubbed.
// ---------------------------------------------------------------------------

async function calculateInvoice(
  strategies: any[],
  events: Array<{ signalId: string; quantity: number }>,
  subOverrides: Record<string, unknown> = {},
) {
  const subscription = makeSubscription(strategies, subOverrides);
  const prisma = {
    getClient: function () {
      return this;
    },
    subscriptions: {
      findUnique: ({ where }: any) => Promise.resolve(where.id === SUB ? subscription : null),
    },
    signal_events: {
      findMany: ({ where }: any) =>
        Promise.resolve(events.filter((e) => where.signalId.in.includes(e.signalId))),
    },
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [InvoiceCalculatorService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  const svc = module.get(InvoiceCalculatorService);
  return (await svc.calculateInvoice({ subscriptionId: SUB } as any)) as any;
}

/**
 * What Postgres actually stores for a numeric(12,2) column: half-up rounding
 * to two places. Model it here or the pin passes on precision that never
 * reaches the checkout path.
 */
function storedDecimal(value: unknown): Decimal {
  return new Decimal(new Decimal(Number(value)).toFixed(2));
}

/** Runs the real line-item writer and hands back the rows as stored. */
async function persistLineItems(calculation: any) {
  const written: any[] = [];
  const prisma = {
    invoice_line_items: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        const row = {
          ...data,
          quantity: storedDecimal(data.quantity),
          unitPrice: storedDecimal(data.unitPrice),
          amount: storedDecimal(data.amount),
          deletedAt: null,
        };
        written.push(row);
        return row;
      },
    },
  };
  await createOrUpdateInvoiceLineItems(
    { id: INVOICE_ID },
    calculation.calculationDetails,
    prisma as any,
    false,
  );
  return written;
}

interface InvoiceHeader {
  currency?: string;
  amountDue?: unknown;
  taxAmount?: unknown;
  discountAmount?: unknown;
  stripeAutomaticTax?: boolean;
}

/**
 * Runs the real checkout mapper + the real Stripe adapter over stored rows,
 * and hands back the ENTIRE session payload. Returning only `line_items` is how
 * a pin ends up blind to `automatic_tax`, `discounts` and `adjustable_quantity`
 * — every one of which changes what the customer pays.
 */
async function createCheckoutSession(rows: any[], subtotal: number, header: InvoiceHeader = {}) {
  // A real invoice header is subtotal + tax - discount (invoices.service.ts),
  // and amountDue starts at that figure. Model it, or the fixture would be
  // asserting against a header shape production never writes.
  const total = subtotal + Number(header.taxAmount ?? 0) - Number(header.discountAmount ?? 0);
  const storedTotal = storedDecimal(total);
  const savedPayments: any[] = [];
  const prisma = {
    invoices: {
      findUnique: async () => ({
        id: INVOICE_ID,
        invoiceNumber: 'INV-1001',
        organizationId: ORG,
        customerId: CUSTOMER,
        status: 'sent',
        currency: header.currency ?? 'USD',
        amountDue: header.amountDue === undefined ? storedTotal : storedDecimal(header.amountDue),
        totalAmount: storedTotal,
        taxAmount: header.taxAmount === undefined ? null : storedDecimal(header.taxAmount),
        discountAmount:
          header.discountAmount === undefined ? null : storedDecimal(header.discountAmount),
        customers: { id: CUSTOMER, email: 'customer@example.com' },
        organizations: {
          id: ORG,
          name: 'Test Org',
          stripeAutomaticTax: header.stripeAutomaticTax === true,
        },
        invoice_line_items: rows,
      }),
    },
    payment_providers: {
      findFirst: async () => ({
        id: 'provider-1',
        type: 'stripe',
        encrypted_secrets: JSON.stringify({ secretKey: MERCHANT_KEY }),
        settings: {},
      }),
    },
    invoice_payments: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        savedPayments.push(data);
        return data;
      },
    },
  };
  const config = {
    get: (key: string) => (key === 'FRONTEND_URL' ? 'https://billing.example.com' : undefined),
  } as unknown as ConfigService;
  const adapterFactory = {
    createAdapter: () => new StripeAdapter({ secretKey: MERCHANT_KEY }, config),
  } as unknown as PaymentAdapterFactory;

  const service = new PaymentProcessingService(prisma as any, config, adapterFactory);
  await service.createCheckoutSession(INVOICE_ID);

  const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
  return { payload, payment: savedPayments[0] };
}

/** The whole trip, for one plan configuration. */
async function billThrough(
  strategies: any[],
  events: Array<{ signalId: string; quantity: number }> = [],
  subOverrides: Record<string, unknown> = {},
  header: InvoiceHeader = {},
) {
  const calculation = await calculateInvoice(strategies, events, subOverrides);
  const rows = await persistLineItems(calculation);
  const total = calculation.calculationDetails.total;
  const session =
    rows.length > 0 || header.amountDue !== undefined
      ? await createCheckoutSession(rows, total, header)
      : { payload: null as any, payment: undefined };
  return { calculation, rows, total, ...session };
}

// ---------------------------------------------------------------------------
// The oracle. Deliberately its own arithmetic: if this file computed the
// expected number the way the code under test computes it, it would only be
// checking that the code agrees with itself.
// ---------------------------------------------------------------------------

const MINOR_UNIT_FACTOR: Record<string, number> = { USD: 100, JPY: 1 };

function expectedMinor(amount: number, currency = 'USD'): number {
  const factor = MINOR_UNIT_FACTOR[currency];
  if (!factor) throw new Error(`This test has no minor-unit factor for ${currency}`);
  return Math.round(Math.abs(amount) * factor) * Math.sign(amount);
}

/** What Stripe will charge for this session: it bills the rows, nothing else. */
function collectedFrom(payload: any): number {
  return payload.line_items.reduce(
    (sum: number, li: any) => sum + li.price_data.unit_amount * li.quantity,
    0,
  );
}

// ---------------------------------------------------------------------------
// Every line shape, and the mixes.
// ---------------------------------------------------------------------------

interface Case {
  label: string;
  strategies: any[];
  events?: Array<{ signalId: string; quantity: number }>;
  subOverrides?: Record<string, unknown>;
  header?: InvoiceHeader;
  /** How many line items the invoice should carry. Guards silent no-ops. */
  expectedLines: number;
  /**
   * Set when this invoice's rows cannot be shown as a breakdown, with the
   * reason. Naming it per case keeps a change that silently bundled EVERY
   * invoice from passing: the money would still be right, but the customer
   * would lose the itemization.
   */
  bundles?: BundleReason;
  /** Defaults to USD. */
  currency?: string;
  /**
   * Whether Stripe's own tax engine should be switched on for this session.
   * Declared per fixture rather than derived from the header, so the rule that
   * decides it has to actually produce this answer.
   */
  expectsStripeTax?: boolean;
}

const CASES: Case[] = [
  // --- one shape at a time ---
  {
    label: 'recurring flat fee, full cycle',
    strategies: [recurringStrategy(50)],
    expectedLines: 1,
  },
  {
    label: 'recurring flat fee, prorated mid-cycle start',
    strategies: [recurringStrategy(50)],
    subOverrides: { startDate: new Date('2026-05-12T00:00:00.000Z') },
    expectedLines: 1,
  },
  {
    // A one-time fee only bills in the cycle the subscription started in, so
    // the start date has to sit inside the window for this line to exist.
    label: 'one-time setup fee',
    strategies: [onetimeStrategy(500)],
    subOverrides: { startDate: new Date('2026-05-12T00:00:00.000Z') },
    expectedLines: 1,
  },
  {
    label: 'seat-based, whole seats',
    strategies: [seatStrategy(9.9)],
    subOverrides: { seatsCount: 3 },
    expectedLines: 1,
  },
  {
    label: 'seat-based, minimum commitment above entered seats',
    strategies: [seatStrategy(9.9, 5)],
    subOverrides: { seatsCount: 2 },
    expectedLines: 1,
  },
  {
    label: 'seat-based, prorated mid-cycle start',
    strategies: [seatStrategy(9.9)],
    subOverrides: { seatsCount: 3, startDate: new Date('2026-05-12T00:00:00.000Z') },
    expectedLines: 1,
  },
  {
    label: 'flat usage, whole quantity',
    strategies: [flatUsageStrategy(0.1)],
    events: [{ signalId: SIGNAL_B, quantity: 250 }],
    expectedLines: 1,
  },
  {
    label: 'flat usage, fractional quantity',
    strategies: [flatUsageStrategy(50)],
    events: [{ signalId: SIGNAL_B, quantity: 0.07 }],
    expectedLines: 1,
  },
  {
    label: 'usage with no pricing model at all, billing rate x quantity',
    strategies: [noModelUsageStrategy(0.5)],
    events: [{ signalId: SIGNAL_A, quantity: 40 }],
    expectedLines: 1,
  },
  {
    label: 'graduated usage across two tiers',
    strategies: [graduatedUsageStrategy()],
    events: [{ signalId: SIGNAL_B, quantity: 1300 }],
    expectedLines: 1,
  },
  {
    label: 'volume usage in the second tier',
    strategies: [volumeUsageStrategy()],
    events: [{ signalId: SIGNAL_B, quantity: 1300 }],
    expectedLines: 1,
  },
  {
    label: 'credit pool, usage inside the pool',
    strategies: [poolStrategy()],
    events: [{ signalId: SIGNAL_A, quantity: 400 }],
    expectedLines: 1,
  },
  {
    label: 'credit pool, usage past the pool (fee + overage)',
    strategies: [poolStrategy()],
    events: [{ signalId: SIGNAL_A, quantity: 1300 }],
    expectedLines: 1,
  },
  {
    label: 'credit pool, rated members, usage past the pool',
    strategies: [poolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 })],
    events: [
      { signalId: SIGNAL_A, quantity: 200 },
      { signalId: SIGNAL_B, quantity: 250 },
    ],
    expectedLines: 1,
  },
  {
    label: 'credit pool, ZERO usage — the fee still bills',
    strategies: [poolStrategy()],
    events: [],
    expectedLines: 1,
  },
  {
    label: 'credit pool, rated members, ZERO usage',
    strategies: [poolStrategy({ [SIGNAL_A]: 4, [SIGNAL_B]: 2 })],
    events: [],
    expectedLines: 1,
  },

  // --- mixes: the shape where a dropped line hides behind a real charge ---
  {
    label: 'MIXED: recurring + zero-usage pool',
    strategies: [recurringStrategy(50), poolStrategy()],
    events: [],
    expectedLines: 2,
  },
  {
    label: 'MIXED: recurring + used pool',
    strategies: [recurringStrategy(50), poolStrategy()],
    events: [{ signalId: SIGNAL_A, quantity: 400 }],
    expectedLines: 2,
  },
  {
    label: 'MIXED: recurring + pool past the pool',
    strategies: [recurringStrategy(50), poolStrategy()],
    events: [{ signalId: SIGNAL_A, quantity: 1300 }],
    expectedLines: 2,
  },
  {
    label: 'MIXED: seats + zero-usage pool',
    strategies: [seatStrategy(9.9), poolStrategy()],
    events: [],
    subOverrides: { seatsCount: 3 },
    expectedLines: 2,
  },
  {
    label: 'MIXED: flat usage + zero-usage pool',
    strategies: [flatUsageStrategy(0.1), poolStrategy()],
    events: [{ signalId: SIGNAL_B, quantity: 250 }],
    expectedLines: 2,
  },
  {
    label: 'MIXED: graduated usage + zero-usage pool',
    strategies: [graduatedUsageStrategy(), poolStrategy()],
    events: [{ signalId: SIGNAL_B, quantity: 1300 }],
    expectedLines: 2,
  },
  {
    label: 'MIXED: one-time + recurring + seats + usage + zero-usage pool',
    strategies: [
      onetimeStrategy(500),
      recurringStrategy(50),
      seatStrategy(9.9),
      flatUsageStrategy(0.1),
      poolStrategy(),
    ],
    events: [{ signalId: SIGNAL_B, quantity: 250 }],
    subOverrides: { seatsCount: 3, startDate: new Date('2026-05-12T00:00:00.000Z') },
    expectedLines: 5,
  },
  {
    label: 'MIXED: everything, prorated mid-cycle start',
    strategies: [
      onetimeStrategy(500),
      recurringStrategy(50),
      seatStrategy(9.9, 5),
      graduatedUsageStrategy(),
      poolStrategy(),
    ],
    events: [{ signalId: SIGNAL_B, quantity: 1300 }],
    subOverrides: { seatsCount: 2, startDate: new Date('2026-05-12T00:00:00.000Z') },
    expectedLines: 5,
    bundles: 'rounding-drift',
  },
  {
    label: 'MIXED: free pool + recurring — the pool contributes no line at all',
    strategies: [recurringStrategy(50), freePoolStrategy()],
    events: [],
    expectedLines: 1,
  },
  {
    label: 'MIXED: free pool past the pool + recurring — overage only',
    strategies: [recurringStrategy(50), freePoolStrategy()],
    events: [{ signalId: SIGNAL_A, quantity: 1300 }],
    expectedLines: 2,
  },

  // --- invoice-header shapes: not things the calculator emits, but every one
  // --- of them changes what the customer owes.
  {
    label: 'HEADER: sales tax on the invoice',
    strategies: [recurringStrategy(100)],
    header: { taxAmount: 8.25 },
    expectedLines: 1,
  },
  {
    label: 'HEADER: a discount on the invoice',
    strategies: [recurringStrategy(100)],
    header: { discountAmount: 15 },
    expectedLines: 1,
    bundles: 'header-discount',
  },
  {
    label: 'HEADER: the customer already part-paid it',
    strategies: [recurringStrategy(100)],
    header: { amountDue: 40 },
    expectedLines: 1,
    bundles: 'partially-settled',
  },
  {
    label: 'HEADER: a credit was applied',
    strategies: [recurringStrategy(100)],
    header: { amountDue: 60 },
    expectedLines: 1,
    bundles: 'partially-settled',
  },
  {
    label: 'HEADER: a zero-decimal currency',
    strategies: [recurringStrategy(10000)],
    header: { currency: 'JPY' },
    currency: 'JPY',
    expectedLines: 1,
  },
  {
    // The merchant has opted into Stripe Tax and this invoice states no tax of
    // its own, so Stripe computes it. The rows still collect the invoice; what
    // Stripe adds on top is the merchant's deliberate arrangement with Stripe.
    label: 'HEADER: the org runs Stripe Tax and the invoice states no tax',
    strategies: [recurringStrategy(100)],
    header: { stripeAutomaticTax: true },
    expectedLines: 1,
    expectsStripeTax: true,
  },
  {
    // Both tax sources configured at once. Ours is on the invoice, so ours is
    // the bill, and Stripe's engine stays off — otherwise the session carries a
    // "Sales tax" row AND a Stripe-computed tax on top of it.
    label: 'HEADER: the org runs Stripe Tax but the invoice already states tax',
    strategies: [recurringStrategy(100)],
    header: { stripeAutomaticTax: true, taxAmount: 8.25 },
    expectedLines: 1,
    expectsStripeTax: false,
  },
];

beforeEach(() => {
  mockCheckoutSessionsCreate.mockReset();
  mockCheckoutSessionsCreate.mockResolvedValue({
    id: 'cs_test_collect',
    url: 'https://checkout.stripe.com/c/pay/cs_test_collect',
    expires_at: Math.floor(Date.now() / 1000) + 86400,
  });
});

describe('Stripe collects exactly what the invoice says, on every line shape', () => {
  it.each(CASES)('$label', async (testCase) => {
    const { calculation, rows, total, payload } = await billThrough(
      testCase.strategies,
      testCase.events ?? [],
      testCase.subOverrides ?? {},
      testCase.header ?? {},
    );
    const currency = testCase.currency ?? 'USD';
    const header = testCase.header ?? {};

    // The fixture bills what it says it bills. Without this, a case that
    // stopped emitting a line would still satisfy the sum below at $0.
    expect(rows).toHaveLength(testCase.expectedLines);
    expect(calculation.calculationDetails.lineItems).toHaveLength(testCase.expectedLines);

    // THE INVARIANT, against an oracle built from the fixture's own numbers:
    // what the customer still owes, in this currency's minor unit.
    const headerTotal = total + Number(header.taxAmount ?? 0) - Number(header.discountAmount ?? 0);
    const expectedCollected = expectedMinor(
      header.amountDue === undefined ? headerTotal : Number(header.amountDue),
      currency,
    );
    expect(expectedCollected).toBeGreaterThan(0);
    expect(collectedFrom(payload)).toBe(expectedCollected);

    // The customer still gets their breakdown. Collecting the right total by
    // bundling everything into one mystery row would satisfy the sum above and
    // quietly undo the itemization, so pin it here.
    const names = payload.line_items.map((li: any) => li.price_data.product_data.name);
    if (testCase.bundles) {
      expect(payload.line_items).toHaveLength(1);
      expect(names).toEqual(['Invoice INV-1001']);
    } else {
      const expectedNames = rows.map((row: any) => row.description.slice(0, 250));
      if (header.taxAmount) expectedNames.push('Sales tax');
      expect(names).toEqual(expectedNames);

      // Every itemized row bills the amount its stored row says it bills.
      // A row rebuilt from its stored unit price fails here.
      rows.forEach((row: any, index: number) => {
        const li = payload.line_items[index];
        expect(li.price_data.unit_amount * li.quantity).toBe(
          expectedMinor(Number(row.amount), currency),
        );
      });
    }

    // Stripe's own row rules. A violation here is a 400 at checkout time,
    // which the customer sees as a payment link that does not work.
    for (const li of payload.line_items) {
      expect(Number.isInteger(li.price_data.unit_amount)).toBe(true);
      expect(li.price_data.unit_amount).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(li.quantity)).toBe(true);
      expect(li.quantity).toBeGreaterThanOrEqual(1);
      expect(li.price_data.currency).toBe(currency.toLowerCase());
    }

    // Nothing else in the session may move money. Stripe adds tax on top when
    // `automatic_tax` is on, takes money off for `discounts`, and lets the
    // customer change what they buy with `adjustable_quantity` — none of which
    // a pin that only reads line_items would ever notice. `automatic_tax` is
    // the one of those we ever send, and only where the fixture says so.
    expect(Object.keys(payload).sort()).toEqual(
      [
        'cancel_url',
        'client_reference_id',
        'customer_email',
        'expires_at',
        'line_items',
        'metadata',
        'mode',
        'payment_intent_data',
        'success_url',
        ...(testCase.expectsStripeTax ? ['automatic_tax'] : []),
      ].sort(),
    );
    for (const li of payload.line_items) {
      expect(Object.keys(li).sort()).toEqual(['price_data', 'quantity']);
      expect(Object.keys(li.price_data).sort()).toEqual([
        'currency',
        'product_data',
        'unit_amount',
      ]);
      expect(Object.keys(li.price_data.product_data).sort()).toEqual(
        testCase.bundles ? ['description', 'name'] : ['name'],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage is derived, not remembered.
// ---------------------------------------------------------------------------

const SCHEMA = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'prisma');
const CALCULATOR = join(__dirname, '..', 'invoice-calculator', 'invoice-calculator.service.ts');

/** The members of a Prisma enum, read from the schema itself. */
function prismaEnumValues(name: string): string[] {
  const schema = readFileSync(join(SCHEMA, 'schema.prisma'), 'utf8');
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema);
  if (!block) throw new Error(`enum ${name} is gone from schema.prisma — this test needs it`);
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

/** The source of one switch in the calculator, from `switch` to its closing brace. */
function calculatorSwitchBody(discriminator: string): string {
  const source = readFileSync(CALCULATOR, 'utf8');
  const start = source.indexOf(`switch (${discriminator})`);
  if (start === -1) {
    throw new Error(
      `invoice-calculator.service.ts no longer switches on ${discriminator}. If the ` +
        `dispatch moved, point this test at its new home — do not delete the check.`,
    );
  }
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** The string cases of one switch in the calculator, read from its source. */
function calculatorSwitchArms(discriminator: string): string[] {
  return [...calculatorSwitchBody(discriminator).matchAll(/case '([a-z_]+)':/g)].map(
    (match) => match[1],
  );
}

/** How many statements in the chargeType switch can put a charge on an invoice. */
function calculatorLineSites(): number {
  return [...calculatorSwitchBody('strategy.chargeType').matchAll(/lineItem = \{/g)].length;
}

/**
 * Which shapes the fixtures above actually billed. Observed from the line items
 * they produced, never declared: a fixture cannot claim coverage it does not
 * have.
 */
async function observedShapes() {
  const chargeTypes = new Set<string>();
  const pricingModels = new Set<string>();

  for (const testCase of CASES) {
    const calculation = await calculateInvoice(
      testCase.strategies,
      testCase.events ?? [],
      testCase.subOverrides ?? {},
    );
    for (const line of calculation.calculationDetails.lineItems) {
      chargeTypes.add(line.chargeType);
      const strategy = testCase.strategies.find((s) => s.id === line.pricingStrategyId);
      pricingModels.add(strategy?.pricingModel ?? 'null');
    }
  }

  return { chargeTypes, pricingModels };
}

describe('the coverage list is derived, so a new shape cannot slip past', () => {
  it('bills every chargeType the schema and the calculator both know about', async () => {
    const required = new Set([
      ...prismaEnumValues('enum_pricing_strategies_chargeType'),
      ...calculatorSwitchArms('strategy.chargeType'),
    ]);
    const { chargeTypes } = await observedShapes();

    const missing = [...required].filter((value) => !chargeTypes.has(value)).sort();
    expect({ missing, hint: HINT }).toEqual({ missing: [], hint: HINT });
  });

  it('bills every pricingModel the schema and the calculator both know about', async () => {
    const required = new Set([
      ...prismaEnumValues('enum_pricing_strategies_pricingModel'),
      ...calculatorSwitchArms('strategy.pricingModel'),
    ]);
    const { pricingModels } = await observedShapes();

    const missing = [...required].filter((value) => !pricingModels.has(value)).sort();
    expect({ missing, hint: HINT }).toEqual({ missing: [], hint: HINT });
  });

  it('the calculator handles every value the schema allows', () => {
    // The other direction: a schema value with no math is an invoice that
    // throws at billing time (deliberately — see the calculator's default
    // arms), which is a shape nobody can bill at all.
    expect(calculatorSwitchArms('strategy.chargeType').sort()).toEqual(
      prismaEnumValues('enum_pricing_strategies_chargeType').sort(),
    );
    expect(calculatorSwitchArms('strategy.pricingModel').sort()).toEqual(
      prismaEnumValues('enum_pricing_strategies_pricingModel').sort(),
    );
  });

  it('the calculator has not grown a line shape this file cannot see', () => {
    // THE HOLE THIS COVERS, and its limits.
    //
    // Everything above derives coverage from the two ENUMS. That catches a new
    // pricing shape, because a new shape needs a value in one of them. It does
    // NOT catch a new money-moving line emitted inside an EXISTING arm under a
    // config no fixture uses — a shortfall credit on usage strategies carrying
    // a minimumCommitment, say. Such a line reuses `usage` + `flat` and claims
    // coverage the fixtures do not have, and every check above stays green.
    //
    // The money still cannot go wrong: whatever the calculator emits, the rows
    // either reconcile with the header or the charge bundles and collects the
    // header. What is lost is the customer's itemization and the honesty of
    // this file's claim.
    //
    // This is the one number here that is declared rather than derived, and it
    // is a tripwire, not proof. A new emission site turns it red. The fix is a
    // fixture that bills the new line end to end, and then this number — in
    // that order. Bumping it alone puts the claim back to being untrue.
    expect(calculatorLineSites()).toBe(4);
  });
});

const HINT =
  'Add a fixture to CASES in checkout-collects-invoice-total.spec.ts that bills this ' +
  'shape end to end. It is not covered until an invoice carrying it has been collected ' +
  'through the real adapter.';

// ---------------------------------------------------------------------------
// The safety net, proven rather than assumed.
// ---------------------------------------------------------------------------

describe('rows that do not add up never decide what is collected', () => {
  /** Persisted rows, hand-built, so they can be made to disagree on purpose. */
  function storedRow(description: string, quantity: number, unitPrice: number, amount: number) {
    return {
      description,
      quantity: storedDecimal(quantity),
      unitPrice: storedDecimal(unitPrice),
      amount: storedDecimal(amount),
      deletedAt: null,
    };
  }

  it('NEGATIVE CONTROL: garbage rows still collect the invoice, and say so', async () => {
    const { payload, payment } = await createCheckoutSession(
      [storedRow('Nonsense A', 1, 812.4, 812.4), storedRow('Nonsense B', 1, -5000, -5000)],
      99,
    );

    expect(collectedFrom(payload)).toBe(9900);
    expect(payload.line_items).toHaveLength(1);
    expect(payload.line_items[0].price_data.product_data.name).toBe('Invoice INV-1001');
    // And it is not silent: the payment row carries why, for month-end.
    expect(payment.metadata.collectedAsSingleRow).toBe('negative-line');
  });

  it('rows that disagree with the header by real money are marked as a defect', async () => {
    const { payload, payment } = await createCheckoutSession(
      [storedRow('Platform fee', 1, 50, 50), storedRow('Usage', 10, 0.1, 1)],
      75,
    );

    expect(collectedFrom(payload)).toBe(7500);
    expect(payment.metadata.collectedAsSingleRow).toBe('lines-do-not-reconcile');
    expect(payment.metadata.lineRowsMinor).toBe(5100);
  });

  it('the pending payment records what the session collects, not the invoice total', async () => {
    // The reconciler carries this figure into the succeeded row, so an invoice
    // part-paid off-platform would otherwise be credited with money nobody sent.
    const { payment } = await createCheckoutSession([storedRow('Platform fee', 1, 100, 100)], 100, {
      amountDue: 40,
    });

    expect(Number(payment.amount)).toBe(40);
  });
});

describe('only one tax engine may run against one payment', () => {
  it('off by default, and absent from the payload rather than disabled', async () => {
    const { payload } = await billThrough([recurringStrategy(100)]);
    expect(payload).not.toHaveProperty('automatic_tax');
  });

  it('on when the organization asked for it and the invoice states no tax', async () => {
    const { payload } = await billThrough(
      [recurringStrategy(100)],
      [],
      {},
      {
        stripeAutomaticTax: true,
      },
    );

    expect(payload.automatic_tax).toEqual({ enabled: true });
    expect(collectedFrom(payload)).toBe(10000);
  });

  it('off when the invoice already carries tax, whatever the org flag says', async () => {
    // The rows already include OUR 8.25 of tax. Leaving Stripe's engine on too
    // makes Stripe compute a second tax against the 108.25 and add it on top —
    // the customer pays sales tax twice and neither system is wrong on its own.
    const { payload } = await billThrough(
      [recurringStrategy(100)],
      [],
      {},
      {
        stripeAutomaticTax: true,
        taxAmount: 8.25,
      },
    );

    expect(payload).not.toHaveProperty('automatic_tax');
    expect(collectedFrom(payload)).toBe(10825);
    expect(payload.line_items.map((li: any) => li.price_data.product_data.name)).toContain(
      'Sales tax',
    );
  });

  it('a bundled charge still reports the tax it carries, so the interlock holds there too', async () => {
    // A header discount collapses the rows, tax row included. The tax did not
    // stop existing, and neither did the reason to keep Stripe's engine off.
    const { payload } = await billThrough(
      [recurringStrategy(100)],
      [],
      {},
      {
        stripeAutomaticTax: true,
        taxAmount: 8.25,
        discountAmount: 15,
      },
    );

    expect(payload).not.toHaveProperty('automatic_tax');
    expect(payload.line_items).toHaveLength(1);
    expect(collectedFrom(payload)).toBe(9325);
  });
});

describe('the zero-usage pool row, end to end', () => {
  it('a pool-only invoice with no usage collects the fee instead of $0.00', async () => {
    const { rows, total, payload } = await billThrough([poolStrategy()], []);

    expect(total).toBe(99);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('report: credit pool fee (no usage this period)');
    expect(Number(rows[0].quantity)).toBe(1);
    expect(Number(rows[0].unitPrice)).toBe(99);
    expect(Number(rows[0].amount)).toBe(99);

    expect(payload.line_items).toHaveLength(1);
    expect(payload.line_items[0].price_data.unit_amount).toBe(9900);
    expect(payload.line_items[0].quantity).toBe(1);
  });

  it('on a mixed invoice the pool fee reaches Stripe as its own row, not as nothing', async () => {
    const { total, payload } = await billThrough([recurringStrategy(50), poolStrategy()], []);

    expect(total).toBe(149);
    const byName = Object.fromEntries(
      payload.line_items.map((li: any) => [
        li.price_data.product_data.name,
        li.price_data.unit_amount * li.quantity,
      ]),
    );
    expect(byName['Monthly Platform Fee']).toBe(5000);
    expect(byName['report: credit pool fee (no usage this period)']).toBe(9900);
  });

  it('a free pool with no usage still produces no invoice and no session', async () => {
    const { rows, total } = await billThrough([freePoolStrategy()], []);
    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A LEDGER, NOT A CLAIM.
// ---------------------------------------------------------------------------

/**
 * The invoice email, the dashboard detail page, the portal and the PDF all
 * print Description / Qty / Unit / Amount straight off the row, so a row that
 * doesn't multiply out reads as an arithmetic error to the customer even when
 * the money is right.
 *
 * Most rows do multiply out. Blended-price rows can't: unitPrice is stored at
 * numeric(12,2), and a credit pool's real per-unit price on 400 credits is
 * $0.2475. Stored as $0.25 it prints "400 × $0.25 = $99.00". Fixing that would
 * mean throwing away the quantity the customer most wants to see (how many
 * credits they burned), so the divergence stands — but it is written down here
 * rather than left to be rediscovered, and the PDF prints the tier
 * breakdown beside these rows so the arithmetic has an explanation.
 *
 * If this list grows, a new shape started printing arithmetic that doesn't add
 * up, and somebody has to decide whether that is acceptable.
 */
describe('the rows that do not multiply out on a human surface', () => {
  it('are exactly the known blended-price ones, and the money is right on all of them', async () => {
    const divergent: string[] = [];

    for (const testCase of CASES) {
      const { rows, total } = await billThrough(
        testCase.strategies,
        testCase.events ?? [],
        testCase.subOverrides ?? {},
      );

      const summedAmountCents = rows.reduce(
        (sum, row) => sum + expectedMinor(Number(row.amount)),
        0,
      );
      expect(Math.abs(summedAmountCents - expectedMinor(total))).toBeLessThanOrEqual(1);

      for (const row of rows) {
        const product = Math.round(Number(row.quantity) * Number(row.unitPrice) * 100) / 100;
        if (product !== Number(row.amount)) {
          divergent.push(`${testCase.label} → ${row.description}`);
        }
      }
    }

    expect([...new Set(divergent)].sort()).toEqual([
      'MIXED: everything, prorated mid-cycle start → Per Seat (5 seats × $9.90; minimum commitment, 2 entered, prorated)',
      'MIXED: everything, prorated mid-cycle start → call: 1,300 × $0.0174',
      'MIXED: free pool past the pool + recurring — overage only → report: 1,300 × $0.0069',
      'MIXED: graduated usage + zero-usage pool → call: 1,300 × $0.0174',
      'MIXED: one-time + recurring + seats + usage + zero-usage pool → Per Seat (3 seats × $9.90, prorated)',
      'MIXED: recurring + pool past the pool → report: 1,300 × $0.0831',
      'MIXED: recurring + used pool → report: 400 × $0.2475',
      'credit pool, rated members, usage past the pool → report: 1,300 × $0.0831',
      'credit pool, usage inside the pool → report: 400 × $0.2475',
      'credit pool, usage past the pool (fee + overage) → report: 1,300 × $0.0831',
      'graduated usage across two tiers → call: 1,300 × $0.0174',
      'seat-based, prorated mid-cycle start → Per Seat (3 seats × $9.90, prorated)',
    ]);
  });

  /**
   * The one cent the ledger above tolerates, on its own so it is a known
   * quantity rather than a mystery. Every line amount is stored rounded, but
   * the invoice total is the sum of the UNROUNDED amounts rounded once, so two
   * sub-cent lines on one invoice can land a cent off the whole. The customer
   * still pays what the invoice says — the charge bundles rather than itemize
   * rows that do not add up — and the gap is named `rounding-drift` so it never
   * raises the alarm reserved for an invoice that is genuinely wrong.
   */
  it('the rounded line amounts can sit one cent off the total, and only on known shapes', async () => {
    const drifting: Array<{ label: string; driftCents: number }> = [];

    for (const testCase of CASES) {
      const { rows, total } = await billThrough(
        testCase.strategies,
        testCase.events ?? [],
        testCase.subOverrides ?? {},
      );
      const summedAmountCents = rows.reduce(
        (sum, row) => sum + expectedMinor(Number(row.amount)),
        0,
      );
      const driftCents = summedAmountCents - expectedMinor(total);
      if (driftCents !== 0) drifting.push({ label: testCase.label, driftCents });
    }

    expect(drifting).toEqual([
      { label: 'MIXED: everything, prorated mid-cycle start', driftCents: 1 },
    ]);
  });
});

describe('checkout redirects come from FRONTEND_URL, never a hard-coded host', () => {
  it('sends success to the dashboard /thanks page and cancel to the dashboard root', async () => {
    const { payload } = await billThrough([recurringStrategy(100)]);

    expect(payload.success_url).toMatch(/^https:\/\/billing\.example\.com\/thanks\?/);
    expect(payload.cancel_url).toBe('https://billing.example.com');
  });
});
