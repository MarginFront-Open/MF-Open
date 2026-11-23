/**
 * Unit tests for StripeAdapter.
 *
 * Coverage focus:
 *
 *   1. OAuth-sourced providers (secrets carry `stripeConnectAccountId`) use the platform's
 *      STRIPE_SECRET_KEY + pass `{ stripeAccount }` on every Stripe API call. Without this
 *      the charge would run on the platform account instead of the merchant's Connect
 *      account — money would land in the wrong place.
 *   2. Secret-key-sourced providers (no `stripeConnectAccountId`) use the merchant's own
 *      secret key, no `stripeAccount` option. Confirms the adapter doesn't break the
 *      secret-key path.
 *   3. `automaticTax: true` on the checkout params adds `automatic_tax: { enabled: true }`
 *      to the Stripe session payload. `automaticTax: false` (or undefined) omits the field
 *      entirely — important because including it with `enabled: false` is NOT the same as
 *      omitting it (per Stripe docs).
 *   4. Construction errors: OAuth-sourced provider without STRIPE_SECRET_KEY throws clear
 *      error. Secret-key-sourced provider without a key throws the missing-key error.
 *
 * Pattern: jest.mock('stripe') so we can spy on every method the adapter calls without
 * touching real Stripe. The mock captures both the params (first arg) and request options
 * (second arg — which is where `stripeAccount` lives).
 */
import { ConfigService } from '@nestjs/config';
// Named because only the `Stripe` NAMESPACE carries Event, aliased because two
// helpers below bind a local `const Stripe = require('stripe')` that would shadow it.
import type { Stripe as StripeTypes } from 'stripe';

const mockCheckoutSessionsCreate = jest.fn();
const mockRefundsCreate = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();
const mockCheckoutSessionsRetrieve = jest.fn();
const mockWebhooksConstructEvent = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockCheckoutSessionsCreate,
        retrieve: mockCheckoutSessionsRetrieve,
      },
    },
    refunds: { create: mockRefundsCreate },
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve },
    webhooks: { constructEvent: mockWebhooksConstructEvent },
  }));
});

// Import AFTER jest.mock so the adapter picks up the mocked Stripe constructor.
import { StripeAdapter } from './stripe.adapter';
import { CreateCheckoutParams } from '../interfaces';
import { buildCollectibleCharge, CollectibleChargeInput } from '../collectible-charge';

const PLATFORM_KEY = 'sk_test_PLATFORM_PLATFORM_PLATFORM';
const MERCHANT_KEY = 'sk_test_MERCHANT_MERCHANT_MERCHANT';
const CONNECT_ACCOUNT_ID = 'acct_1ABC123';

function buildConfig(values: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: jest.fn((name: string) => values[name]),
  } as unknown as ConfigService;
}

/**
 * A real CollectibleCharge — the only kind there is. The type is branded, so a
 * test cannot hand the adapter a shape the production path would never build,
 * which is the point: these assertions run against the same charge a live
 * invoice produces.
 */
function chargeFor(overrides: Partial<CollectibleChargeInput> = {}) {
  return buildCollectibleCharge({
    invoiceNumber: 'INV-001',
    currency: 'USD',
    totalAmount: 249,
    lines: [],
    ...overrides,
  });
}

function buildParams(overrides: Partial<CreateCheckoutParams> = {}): CreateCheckoutParams {
  return {
    invoiceId: 'inv-1',
    invoiceNumber: 'INV-001',
    organizationName: 'Test Org',
    customerEmail: 'c@example.com',
    charge: chargeFor(),
    description: 'Test invoice',
    successUrl: 'http://localhost:3000/i/inv-1?paid=true',
    cancelUrl: 'http://localhost:3000/i/inv-1?canceled=true',
    metadata: {
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-001',
      organizationId: 'org-1',
      customerId: 'cust-1',
      paymentProviderId: 'pp-1',
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockCheckoutSessionsCreate.mockReset();
  mockRefundsCreate.mockReset();
  mockPaymentIntentsRetrieve.mockReset();
  mockCheckoutSessionsRetrieve.mockReset();
  mockWebhooksConstructEvent.mockReset();

  mockCheckoutSessionsCreate.mockResolvedValue({
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800,
  });
});

describe('StripeAdapter — construction', () => {
  it('OAuth-sourced (has stripeConnectAccountId) uses platform STRIPE_SECRET_KEY', () => {
    const Stripe = require('stripe') as jest.Mock;
    Stripe.mockClear();

    new StripeAdapter(
      { stripeConnectAccountId: CONNECT_ACCOUNT_ID },
      buildConfig({ STRIPE_SECRET_KEY: PLATFORM_KEY }),
    );

    // Stripe constructor must be called with the platform key, not undefined / nothing.
    expect(Stripe).toHaveBeenCalledWith(
      PLATFORM_KEY,
      expect.objectContaining({ apiVersion: expect.any(String) }),
    );
  });

  it('OAuth-sourced without STRIPE_SECRET_KEY throws a clear error', () => {
    expect(
      () => new StripeAdapter({ stripeConnectAccountId: CONNECT_ACCOUNT_ID }, buildConfig({})),
    ).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('Secret-key-sourced uses the merchant key (no platform fallback)', () => {
    const Stripe = require('stripe') as jest.Mock;
    Stripe.mockClear();

    new StripeAdapter(
      { secretKey: MERCHANT_KEY, webhookSecret: 'whsec_x' },
      buildConfig({ STRIPE_SECRET_KEY: PLATFORM_KEY }),
    );

    expect(Stripe).toHaveBeenCalledWith(MERCHANT_KEY, expect.any(Object));
  });

  it('Secret-key-sourced without any key throws the missing-key error', () => {
    expect(() => new StripeAdapter({}, buildConfig({}))).toThrow(/secret key/i);
  });
});

describe('StripeAdapter — createCheckoutSession routing options', () => {
  it('OAuth-sourced passes { stripeAccount } on the create call', async () => {
    const adapter = new StripeAdapter(
      { stripeConnectAccountId: CONNECT_ACCOUNT_ID },
      buildConfig({ STRIPE_SECRET_KEY: PLATFORM_KEY }),
    );

    await adapter.createCheckoutSession(buildParams());

    expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    const [, options] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(options).toEqual({ stripeAccount: CONNECT_ACCOUNT_ID });
  });

  it('Secret-key-sourced does NOT pass the stripeAccount option', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig({}));

    await adapter.createCheckoutSession(buildParams());

    expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    const [, options] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(options).toBeUndefined();
  });

  it('refunds also carry { stripeAccount } for OAuth-sourced providers', async () => {
    mockRefundsCreate.mockResolvedValue({
      id: 're_x',
      amount: 1000,
      currency: 'usd',
      status: 'succeeded',
      reason: null,
    });

    const adapter = new StripeAdapter(
      { stripeConnectAccountId: CONNECT_ACCOUNT_ID },
      buildConfig({ STRIPE_SECRET_KEY: PLATFORM_KEY }),
    );

    await adapter.createRefund({
      providerTransactionId: 'pi_x',
      amountMinor: 1000,
      currency: 'USD',
    });

    const [, options] = mockRefundsCreate.mock.calls[0];
    expect(options).toEqual({ stripeAccount: CONNECT_ACCOUNT_ID });
  });
});

describe('StripeAdapter — automatic_tax pass-through', () => {
  it('omits automatic_tax when params.automaticTax is undefined', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig({}));
    await adapter.createCheckoutSession(buildParams());

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload).not.toHaveProperty('automatic_tax');
  });

  it('omits automatic_tax when params.automaticTax is false (Stripe expects absence, not enabled:false)', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig({}));
    await adapter.createCheckoutSession(buildParams({ automaticTax: false }));

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload).not.toHaveProperty('automatic_tax');
  });

  it('adds automatic_tax: { enabled: true } when params.automaticTax is true', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig({}));
    await adapter.createCheckoutSession(buildParams({ automaticTax: true }));

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.automatic_tax).toEqual({ enabled: true });
  });

  it('automatic_tax + stripeAccount both apply on an OAuth-sourced provider', async () => {
    const adapter = new StripeAdapter(
      { stripeConnectAccountId: CONNECT_ACCOUNT_ID },
      buildConfig({ STRIPE_SECRET_KEY: PLATFORM_KEY }),
    );
    await adapter.createCheckoutSession(buildParams({ automaticTax: true }));

    const [payload, options] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.automatic_tax).toEqual({ enabled: true });
    expect(options).toEqual({ stripeAccount: CONNECT_ACCOUNT_ID });
  });
});

describe('StripeAdapter — line items pass-through + Stripe-hosted success page', () => {
  // Line items: without them the customer sees one mystery "Invoice INV-xxx" row on Stripe
  // Checkout. With line items provided, they see real breakdown.
  it('builds one Stripe line_items entry per collectible line', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(
      buildParams({
        charge: chargeFor({
          totalAmount: 71,
          lines: [
            { description: 'Monthly Platform Fee', quantity: 1, unitPrice: 50, amount: 50 },
            {
              description: 'Per-event usage (10 × $0.10)',
              quantity: 10,
              unitPrice: 0.1,
              amount: 1,
            },
            { description: 'Per-seat fees (5 × $4.00)', quantity: 5, unitPrice: 4, amount: 20 },
          ],
        }),
      }),
    );

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.line_items).toHaveLength(3);
    expect(payload.line_items[0].price_data.product_data.name).toBe('Monthly Platform Fee');
    expect(payload.line_items[0].price_data.unit_amount).toBe(5000);
    expect(payload.line_items[0].quantity).toBe(1);
    expect(payload.line_items[1].quantity).toBe(10);
    expect(payload.line_items[1].price_data.unit_amount).toBe(10);
    expect(payload.line_items[2].quantity).toBe(5);
    expect(payload.line_items[2].price_data.unit_amount).toBe(400);
  });

  it('sends the charge as one row when the invoice carries no line items', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(buildParams());

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.line_items).toHaveLength(1);
    expect(payload.line_items[0].price_data.product_data.name).toBe('Invoice INV-001');
    expect(payload.line_items[0].price_data.unit_amount).toBe(24900);
    // The single mystery row is all the customer gets, so it keeps the blurb.
    expect(payload.line_items[0].price_data.product_data.description).toBe('Test invoice');
  });

  // Success page NOTE: `redirect_on_completion: 'never'` would give Stripe's
  // hosted success page, but Stripe rejects that param outside embedded UI
  // mode. Hosted mode shows a brief "Payment successful" panel for ~3s then
  // redirects to success_url.

  // Ingest accepts fractional usage quantities, which flow
  // through to invoice line items. Stripe Checkout's `quantity` must be a
  // positive integer, so a fractional quantity CANNOT be sent as-is. The
  // collapse happens in the charge, once, for every provider — the adapter
  // sends what it is given.
  it('a fractional-quantity usage line collects the true line total, not a rounded whole unit', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(
      buildParams({
        charge: chargeFor({
          totalAmount: 3.3,
          lines: [
            // 0.066 metered units @ $50/unit = $3.30
            {
              description: 'Usage (0.066 units × $50)',
              quantity: 0.066,
              unitPrice: 50,
              amount: 3.3,
            },
          ],
        }),
      }),
    );

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.line_items).toHaveLength(1);
    expect(payload.line_items[0].quantity).toBe(1);
    expect(payload.line_items[0].price_data.unit_amount).toBe(330);
    expect(payload.line_items[0].price_data.unit_amount * payload.line_items[0].quantity).toBe(330);
  });

  it('whole-quantity lines keep their itemized per-unit × qty breakdown', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(
      buildParams({
        charge: chargeFor({
          totalAmount: 33,
          lines: [
            { description: 'Fractional usage', quantity: 0.066, unitPrice: 50, amount: 3.3 },
            { description: 'Seat fees (3 × $9.90)', quantity: 3, unitPrice: 9.9, amount: 29.7 },
          ],
        }),
      }),
    );

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.line_items).toHaveLength(2);
    // Fractional row: collapsed to qty 1, full total.
    expect(payload.line_items[0].quantity).toBe(1);
    expect(payload.line_items[0].price_data.unit_amount).toBe(330);
    // Whole row: unchanged per-unit × qty breakdown.
    expect(payload.line_items[1].quantity).toBe(3);
    expect(payload.line_items[1].price_data.unit_amount).toBe(990);
    const collected = payload.line_items.reduce(
      (sum: number, li: { quantity: number; price_data: { unit_amount: number } }) =>
        sum + li.price_data.unit_amount * li.quantity,
      0,
    );
    expect(collected).toBe(3300);
  });

  it('truncates line item descriptions over 250 chars (Stripe API limit)', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    const longDesc = 'x'.repeat(500);
    await adapter.createCheckoutSession(
      buildParams({
        charge: chargeFor({
          totalAmount: 10,
          lines: [{ description: longDesc, quantity: 1, unitPrice: 10, amount: 10 }],
        }),
      }),
    );

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.line_items[0].price_data.product_data.name.length).toBe(250);
  });

  /**
   * Stripe charges unit_amount × quantity per row, so a row whose
   * stored per-unit price can't reproduce its own total makes the customer pay
   * a number the invoice never said. invoice_line_items keeps quantity and
   * unitPrice at numeric(12,2), which is not enough precision for any blended
   * price — credit pools, graduated tiers, prorated seats.
   *
   * The decision lives in collectible-charge.ts; these run it end to end
   * through the adapter, because what Stripe receives is what matters.
   */
  describe('a row bills its own total, never a rounded per-unit price × quantity', () => {
    it('collapses a row whose rounded per-unit price would overcharge', async () => {
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      await adapter.createCheckoutSession(
        buildParams({
          charge: chargeFor({
            totalAmount: 99,
            lines: [
              // A $99 pool spread over 400 credits is $0.2475 each. Stored at
              // two decimals that reads $0.25, and 400 × 25 cents is $100.00.
              {
                description: 'report: 400 × $0.2475',
                quantity: 400,
                unitPrice: 0.25,
                amount: 99,
              },
            ],
          }),
        }),
      );

      const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
      expect(payload.line_items).toHaveLength(1);
      expect(payload.line_items[0].quantity).toBe(1);
      expect(payload.line_items[0].price_data.unit_amount).toBe(9900);
      // Still the customer's own line, not the bundled "Invoice INV-001" row.
      // Those two collapse to the same numbers on a one-line invoice, so the
      // name is the only thing that tells them apart.
      expect(payload.line_items[0].price_data.product_data.name).toBe('report: 400 × $0.2475');
    });

    it('collapses a row whose rounded per-unit price would undercharge', async () => {
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      await adapter.createCheckoutSession(
        buildParams({
          charge: chargeFor({
            totalAmount: 108,
            lines: [
              // $99 pool + 300 credits of overage = $108 over 1,300 credits,
              // which is $0.0831 each. Stored as $0.08, so 1,300 of them
              // collect $104.00 and the merchant is $4 short.
              {
                description: 'report: 1,300 × $0.0831',
                quantity: 1300,
                unitPrice: 0.08,
                amount: 108,
              },
            ],
          }),
        }),
      );

      const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
      expect(payload.line_items[0].quantity).toBe(1);
      expect(payload.line_items[0].price_data.unit_amount).toBe(10800);
      expect(payload.line_items[0].price_data.product_data.name).toBe('report: 1,300 × $0.0831');
    });

    it('keeps the per-unit breakdown when it reconstructs the line total exactly', async () => {
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      await adapter.createCheckoutSession(
        buildParams({
          charge: chargeFor({
            totalAmount: 29.7,
            lines: [
              { description: 'Seats (3 × $9.90)', quantity: 3, unitPrice: 9.9, amount: 29.7 },
            ],
          }),
        }),
      );

      const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
      expect(payload.line_items[0].quantity).toBe(3);
      expect(payload.line_items[0].price_data.unit_amount).toBe(990);
    });

    it('bills the invoice total as one row when the itemized rows do not add up to it', async () => {
      // The safety net. Per-line rounding can still drift against a total that
      // was rounded once, and no breakdown is worth collecting the wrong
      // amount over.
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      await adapter.createCheckoutSession(
        buildParams({
          charge: chargeFor({
            totalAmount: 75,
            lines: [
              { description: 'Platform fee', quantity: 1, unitPrice: 50, amount: 50 },
              { description: 'Usage', quantity: 10, unitPrice: 0.1, amount: 1 },
            ],
          }),
        }),
      );

      const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
      expect(payload.line_items).toHaveLength(1);
      expect(payload.line_items[0].price_data.product_data.name).toBe('Invoice INV-001');
      expect(payload.line_items[0].price_data.unit_amount).toBe(7500);
      expect(payload.line_items[0].quantity).toBe(1);
    });

    it('a zero-decimal currency is not multiplied by a hundred', async () => {
      // A blanket × 100 would send ¥10,000 to Stripe as 1,000,000 minor units —
      // and the yen has no smaller unit, so that is a ¥1,000,000 charge.
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      await adapter.createCheckoutSession(
        buildParams({
          charge: chargeFor({
            currency: 'JPY',
            totalAmount: 10000,
            lines: [{ description: 'Monthly plan', quantity: 1, unitPrice: 10000, amount: 10000 }],
          }),
        }),
      );

      const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
      expect(payload.line_items[0].price_data.currency).toBe('jpy');
      expect(payload.line_items[0].price_data.unit_amount).toBe(10000);
      expect(payload.line_items[0].quantity).toBe(1);
    });

    it("the $0.50 pre-flight reads the balance being collected, not the invoice's total", async () => {
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      await expect(
        adapter.createCheckoutSession(
          buildParams({
            charge: chargeFor({
              totalAmount: 100,
              amountDue: 0.25,
              lines: [{ description: 'Platform fee', quantity: 1, unitPrice: 100, amount: 100 }],
            }),
          }),
        ),
      ).rejects.toThrow(/0\.25 USD.*\$0\.50 minimum/);
    });

    it('a nearly-paid invoice is told to settle the remainder, not to raise its own total', async () => {
      // The consequence of collecting the balance: a $100 invoice with $99.60
      // already in is unpayable online. That is correct (Stripe will not take
      // 40 cents) but it is a dead end for the customer, so the copy has to
      // name the real situation. "Increase the invoice amount" is nonsense here.
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      const attempt = () =>
        adapter.createCheckoutSession(
          buildParams({
            invoiceNumber: 'INV-0042',
            charge: chargeFor({
              totalAmount: 100,
              amountDue: 0.4,
              lines: [{ description: 'Platform fee', quantity: 1, unitPrice: 100, amount: 100 }],
            }),
          }),
        );

      await expect(attempt()).rejects.toThrow(/INV-0042 has 0\.40 USD left to pay/);
      await expect(attempt()).rejects.toThrow(/Mark the invoice paid/);
      await expect(attempt()).rejects.not.toThrow(/Increase the invoice amount/);
    });

    it('a genuinely tiny invoice still gets the raise-the-amount advice', async () => {
      const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
      await expect(
        adapter.createCheckoutSession(
          buildParams({
            charge: chargeFor({
              totalAmount: 0.25,
              lines: [{ description: 'Rounding', quantity: 1, unitPrice: 0.25, amount: 0.25 }],
            }),
          }),
        ),
      ).rejects.toThrow(/Increase the invoice amount/);
    });
  });
});

describe('StripeAdapter — customer_email omission (checkout email hardening)', () => {
  it('passes customer_email through when a valid email is present', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(buildParams({ customerEmail: 'c@example.com' }));

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload.customer_email).toBe('c@example.com');
  });

  it('omits customer_email when null (customers.email is a nullable column)', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(buildParams({ customerEmail: null }));

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload).not.toHaveProperty('customer_email');
  });

  it('omits customer_email when an empty string', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(buildParams({ customerEmail: '' }));

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload).not.toHaveProperty('customer_email');
  });

  it('omits customer_email when whitespace-only', async () => {
    const adapter = new StripeAdapter({ secretKey: MERCHANT_KEY }, buildConfig());
    await adapter.createCheckoutSession(buildParams({ customerEmail: '   ' }));

    const [payload] = mockCheckoutSessionsCreate.mock.calls[0];
    expect(payload).not.toHaveProperty('customer_email');
  });
});

/**
 * Stripe refund event handling.
 *
 * Stripe API version 2026-04-22.dahlia has no embedded `refunds.data[]` in
 * the `charge.refunded` event payload. The adapter subscribes to
 * `refund.created` + `refund.updated` instead, where the event payload's
 * `data.object` IS the Refund directly. These tests pin that behavior:
 *
 *   - `verifyWebhook` normalizes the two refund event types correctly
 *   - `charge.refunded`, which the adapter does not subscribe to, falls through
 *     to the no-op default so a stray delivery can't crash the handler
 *   - `extractRefundCompleted` pulls fields off the Refund object — id,
 *     payment_intent, amount/100, currency, status, reason — and passes the
 *     status through unchanged so the status-aware webhook handler can
 *     dispatch pending vs succeeded vs failed correctly.
 */
function buildRefundEvent(overrides: {
  type: 'refund.created' | 'refund.updated' | 'charge.refunded';
  refund?: Partial<{
    id: string;
    amount: number;
    currency: string;
    payment_intent: string | null;
    charge: string | null;
    status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
    reason: string | null;
  }>;
  eventId?: string;
}): StripeTypes.Event {
  // For charge.refunded, the data.object is a Charge; for refund.* it is a
  // Refund. Tests below for charge.refunded route to the default case so the
  // object shape inside it doesn't matter — we use a stripped Refund-shaped
  // stub to keep the test fixture simple.
  return {
    id: overrides.eventId || 'evt_test_refund',
    type: overrides.type,
    data: {
      object: {
        id: overrides.refund?.id ?? 're_test_123',
        object: overrides.type === 'charge.refunded' ? 'charge' : 'refund',
        amount: overrides.refund?.amount ?? 5000,
        currency: overrides.refund?.currency ?? 'usd',
        payment_intent: overrides.refund?.payment_intent ?? 'pi_test_123',
        charge: overrides.refund?.charge ?? 'ch_test_123',
        status: overrides.refund?.status ?? 'succeeded',
        reason: overrides.refund?.reason ?? null,
      },
    },
  } as unknown as StripeTypes.Event;
}

describe('StripeAdapter — refund event normalization (Stripe API 2026-04-22.dahlia)', () => {
  function buildAdapterWithWebhookSecret() {
    return new StripeAdapter(
      { secretKey: MERCHANT_KEY, webhookSecret: 'whsec_test_secret' },
      buildConfig(),
    );
  }

  it('verifyWebhook maps refund.created to normalized refund.created', async () => {
    const event = buildRefundEvent({ type: 'refund.created', refund: { status: 'pending' } });
    mockWebhooksConstructEvent.mockReturnValue(event);
    const adapter = buildAdapterWithWebhookSecret();

    const normalized = await adapter.verifyWebhook(Buffer.from(JSON.stringify(event)), 'sig_test');

    expect(normalized.eventType).toBe('refund.created');
    expect(normalized.rawEventType).toBe('refund.created');
  });

  it('verifyWebhook maps refund.updated to normalized refund.updated', async () => {
    const event = buildRefundEvent({ type: 'refund.updated', refund: { status: 'succeeded' } });
    mockWebhooksConstructEvent.mockReturnValue(event);
    const adapter = buildAdapterWithWebhookSecret();

    const normalized = await adapter.verifyWebhook(Buffer.from(JSON.stringify(event)), 'sig_test');

    expect(normalized.eventType).toBe('refund.updated');
    expect(normalized.rawEventType).toBe('refund.updated');
  });

  it('verifyWebhook marks charge.refunded, which it does not handle, as ignored', async () => {
    const event = buildRefundEvent({ type: 'charge.refunded' });
    mockWebhooksConstructEvent.mockReturnValue(event);
    const adapter = buildAdapterWithWebhookSecret();

    const normalized = await adapter.verifyWebhook(Buffer.from(JSON.stringify(event)), 'sig_test');

    expect(normalized.eventType).toBe('ignored');
    expect(normalized.rawEventType).toBe('charge.refunded');
  });

  it('extractRefundCompleted reads fields directly off the Refund object', async () => {
    const event = buildRefundEvent({
      type: 'refund.updated',
      refund: {
        id: 're_test_refund_1',
        amount: 50, // 50 cents = $0.50
        currency: 'usd',
        payment_intent: 'pi_test_payment_1',
        status: 'succeeded',
        reason: 'requested_by_customer',
      },
    });
    const adapter = buildAdapterWithWebhookSecret();

    const data = await adapter.extractRefundCompleted(event);

    expect(data).toEqual({
      providerRefundId: 're_test_refund_1',
      providerTransactionId: 'pi_test_payment_1',
      amount: 0.5, // 50 / 100
      currency: 'usd',
      status: 'succeeded',
      reason: 'requested_by_customer',
    });
  });

  it('extractRefundCompleted passes status=pending through (refund.created for slow processors)', async () => {
    // A refund.created event for a card payment usually has status=succeeded
    // immediately, but ACH / bank-funded refunds can stay pending. The
    // status-aware handler relies on this exact string to decide whether to
    // record-only vs finalize.
    const event = buildRefundEvent({ type: 'refund.created', refund: { status: 'pending' } });
    const adapter = buildAdapterWithWebhookSecret();

    const data = await adapter.extractRefundCompleted(event);

    expect(data.status).toBe('pending');
  });

  it('extractRefundCompleted passes status=failed through (issuer-declined refund)', async () => {
    // A refund.updated with status=failed means the issuer rejected the
    // refund. The handler must mark the refunds row failed WITHOUT touching
    // invoice_payments.refunded_amount — otherwise collected revenue would
    // get reduced for a refund that never actually returned money.
    const event = buildRefundEvent({ type: 'refund.updated', refund: { status: 'failed' } });
    const adapter = buildAdapterWithWebhookSecret();

    const data = await adapter.extractRefundCompleted(event);

    expect(data.status).toBe('failed');
  });

  it('extractRefundCompleted falls back to charge id when payment_intent is null', async () => {
    // Some refunds (direct-charge flows) carry only a charge ID, no
    // PI. The downstream handler joins on invoice_payments.provider_transaction_id
    // which can hold either, so the adapter has to surface whichever the
    // refund object actually has. Builder uses ??-defaults, so inline the
    // event to exercise an explicit null payment_intent.
    const event = {
      id: 'evt_legacy_charge',
      type: 'refund.updated',
      data: {
        object: {
          id: 're_legacy',
          object: 'refund',
          amount: 100,
          currency: 'usd',
          payment_intent: null,
          charge: 'ch_legacy_only',
          status: 'succeeded',
          reason: null,
        },
      },
    } as unknown as StripeTypes.Event;
    const adapter = buildAdapterWithWebhookSecret();

    const data = await adapter.extractRefundCompleted(event);

    expect(data.providerTransactionId).toBe('ch_legacy_only');
  });
});
