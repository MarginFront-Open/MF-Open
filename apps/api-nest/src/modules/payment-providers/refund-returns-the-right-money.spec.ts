/**
 * A refund goes back in the currency the customer paid, at that currency's
 * precision.
 *
 * An amount with no currency attached is not an amount. RefundRequest carries
 * both, and PaymentProcessingService is the one place that scales, using the
 * currency on the payment row.
 *
 * BOTH LEGS. Sending the refund is half of it. What Stripe tells us afterwards
 * lands in `invoice_payments.refunded_amount`, which moves `amountPaid` and
 * therefore `amountDue`, and `amountDue` is the number the NEXT checkout
 * collects (payment-processing.service.ts). A refund read back at the wrong
 * scale is a wrong balance feeding a wrong charge, so the inbound webhook is
 * pinned here too.
 *
 * Real service, real adapter. Only the Stripe SDK and the database are stubbed.
 */
import { ConfigService } from '@nestjs/config';

const mockRefundsCreate = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
    refunds: { create: mockRefundsCreate },
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve },
    webhooks: { constructEvent: jest.fn() },
  }));
});

import { PaymentProcessingService } from './payment-processing.service';
import { PaymentAdapterFactory } from './payment-adapter.factory';
import { StripeAdapter } from './adapters/stripe.adapter';

const MERCHANT_KEY = 'sk_test_MERCHANT_MERCHANT_MERCHANT';
const CONFIG = { get: () => undefined } as unknown as ConfigService;

/** The payment row the refund is taken against. */
function serviceFor(adapter: unknown, currency: string) {
  const prisma = {
    invoice_payments: {
      findFirst: async () => ({
        id: 'pay-1',
        provider_transaction_id: 'pi_x',
        currency,
        amount: '100',
        payment_providers: { id: 'provider-1', type: 'stripe' },
        invoices: { id: 'inv-1', currency },
      }),
    },
  };
  const factory = { createAdapter: () => adapter } as unknown as PaymentAdapterFactory;
  return new PaymentProcessingService(prisma as any, CONFIG, factory);
}

beforeEach(() => {
  mockRefundsCreate.mockReset();
  mockRefundsCreate.mockImplementation(async (params: any) => ({
    id: 're_x',
    amount: params.amount ?? 0,
    currency: 'jpy',
    status: 'succeeded',
    reason: null,
  }));
});

describe('a Stripe refund', () => {
  it('sends a two-decimal amount in the currency the customer paid', async () => {
    mockRefundsCreate.mockResolvedValue({
      id: 're_x',
      amount: 4000,
      currency: 'usd',
      status: 'succeeded',
      reason: null,
    });
    const service = serviceFor(new StripeAdapter({ secretKey: MERCHANT_KEY }, CONFIG), 'USD');

    const result = await service.createRefund('pi_x', 40);

    expect(mockRefundsCreate.mock.calls[0][0].amount).toBe(4000);
    expect(result.amount).toBe(40);
  });

  it('does not multiply a zero-decimal currency by a hundred', async () => {
    const service = serviceFor(new StripeAdapter({ secretKey: MERCHANT_KEY }, CONFIG), 'JPY');

    const result = await service.createRefund('pi_x', 10000);

    // NEGATIVE CONTROL: `Math.round(10000 * 100)` is what a blanket × 100 would send —
    // a ¥1,000,000 refund against a ¥10,000 payment.
    expect(Math.round(10000 * 100)).toBe(1_000_000);
    expect(mockRefundsCreate.mock.calls[0][0].amount).toBe(10000);
    expect(result.amount).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// THE WAY BACK. Everything above sends money; everything below reads what the
// Stripe says came back, which is what actually reaches the ledger.
// ---------------------------------------------------------------------------

describe('what Stripe reports about a refund', () => {
  const stripe = () => new StripeAdapter({ secretKey: MERCHANT_KEY }, CONFIG);

  /** A refund.created / refund.updated event, shaped like Stripe sends it. */
  const refundEvent = (refund: Record<string, unknown>) =>
    ({ data: { object: { id: 're_x', status: 'succeeded', reason: null, ...refund } } }) as any;

  it('reads a two-decimal refund at two decimals', async () => {
    const data = await stripe().extractRefundCompleted(
      refundEvent({ amount: 4000, currency: 'usd', payment_intent: 'pi_x' }),
    );

    expect(data.amount).toBe(40);
    expect(data.currency).toBe('usd');
  });

  it('does not divide a zero-decimal refund by a hundred', async () => {
    const data = await stripe().extractRefundCompleted(
      refundEvent({ amount: 10000, currency: 'jpy', payment_intent: 'pi_x' }),
    );

    // NEGATIVE CONTROL: `refund.amount / 100` would write a ¥10,000 refund to
    // the ledger as ¥100, so the invoice would keep a balance the customer no
    // longer owes and the next Pay link would collect it.
    expect(10000 / 100).toBe(100);
    expect(data.amount).toBe(10000);
  });

  it('reads a three-decimal refund at three decimals', async () => {
    const data = await stripe().extractRefundCompleted(
      refundEvent({ amount: 19160, currency: 'kwd', payment_intent: 'pi_x' }),
    );

    // KWD 19.160, not KWD 191.60 — a tenfold over-credit under a fixed /100.
    expect(19160 / 100).toBe(191.6);
    expect(data.amount).toBe(19.16);
  });

  it('a partial refund of a JPY payment leaves the right balance owing', async () => {
    // The whole reason the scale matters: this number becomes refunded_amount,
    // which becomes amountDue, which is what the next checkout charges.
    const invoiceTotal = 10000;
    const data = await stripe().extractRefundCompleted(
      refundEvent({ amount: 2500, currency: 'jpy', payment_intent: 'pi_x' }),
    );

    expect(invoiceTotal - data.amount).toBe(7500);
  });
});

describe('what Stripe reports about a payment', () => {
  const stripe = () => new StripeAdapter({ secretKey: MERCHANT_KEY }, CONFIG);

  beforeEach(() => mockPaymentIntentsRetrieve.mockReset());

  it('reads a zero-decimal payment, and its fees, in that currency', async () => {
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: 'pi_x',
      amount: 10000,
      currency: 'jpy',
      status: 'succeeded',
      payment_method: { card: { last4: '4242', brand: 'visa' } },
      latest_charge: {
        receipt_url: 'https://stripe.example/receipt',
        balance_transaction: { fee: 500, net: 9500, currency: 'jpy' },
      },
    });

    const details = await stripe().getPaymentDetails('pi_x');

    expect(details.amount).toBe(10000);
    expect(details.fee).toBe(500);
    expect(details.netAmount).toBe(9500);
  });

  it('scales the fee by the currency it settled in, not the one charged', async () => {
    // Stripe denominates a balance transaction in the merchant's settlement
    // currency. A JPY charge settling to USD has a two-decimal fee against a
    // whole-yen amount, and one exponent for both gets one of them wrong.
    mockPaymentIntentsRetrieve.mockResolvedValue({
      id: 'pi_x',
      amount: 10000,
      currency: 'jpy',
      status: 'succeeded',
      payment_method: null,
      latest_charge: {
        receipt_url: null,
        balance_transaction: { fee: 259, net: 6241, currency: 'usd' },
      },
    });

    const details = await stripe().getPaymentDetails('pi_x');

    expect(details.amount).toBe(10000);
    expect(details.fee).toBe(2.59);
    expect(details.netAmount).toBe(62.41);
  });
});
