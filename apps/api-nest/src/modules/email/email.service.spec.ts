/**
 * Tests for the merchant invoice-sent notification.
 *
 * We spy on EmailService.sendEmail (the single Resend chokepoint) so we can assert the
 * composed subject / from / HTML WITHOUT hitting Resend. The key behaviors under test:
 *   - subject carries customer name + total (inbox-searchable)
 *   - NO `from` override → email goes from the default RESEND_FROM_EMAIL
 *   - line items render "first 3 + N more"
 *   - a failed/no-email customer delivery surfaces an inline warning to the merchant
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import { escapeHtml, singleLineSubject } from './email-encoding.util';

// A value that carries every HTML metacharacter plus a markup payload, so a test
// fails loudly the moment an interpolation stops being encoded at the boundary.
const RAW_WITH_METACHARS = `PWN<script>x</script>&"'`;
const ENCODED_METACHARS = `PWN&lt;script&gt;x&lt;/script&gt;&amp;&quot;&#039;`;

const BASE_CONFIG: Record<string, string> = {
  RESEND_FROM_EMAIL: 'Example Billing <team@billing.example.com>',
  FRONTEND_URL: 'https://billing.example.com',
};

// RESEND_API_KEY is absent by default → Resend client disabled; the tests spy sendEmail.
async function buildEmailService(overrides: Record<string, string | undefined> = {}) {
  const values = { ...BASE_CONFIG, ...overrides };
  const config = { get: jest.fn((key: string) => values[key]) };
  const module = await Test.createTestingModule({
    providers: [EmailService, { provide: ConfigService, useValue: config }],
  }).compile();
  return module.get(EmailService);
}

describe('EmailService.sendMerchantInvoiceSentNotification', () => {
  const baseOpts = {
    to: 'bill@acme.test',
    organizationName: 'Acme Co',
    customerName: 'Joan Customer',
    customerEmail: 'joan@example.com',
    invoiceNumber: 'INV-DISPATCH',
    amount: '249.00',
    currency: 'USD',
    invoiceDetailUrl: 'https://billing.example.com/invoices/inv-1',
    customerDetailUrl: 'https://billing.example.com/customers/cust-1',
    lineItems: [
      { description: 'API calls', quantity: 1000, unitPrice: 0.2, amount: 200 },
      { description: 'Storage GB', quantity: 49, unitPrice: 1, amount: 49 },
    ],
  };

  it('composes the spec subject and sends from team@ (no from override)', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendMerchantInvoiceSentNotification(baseOpts);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const arg = sendSpy.mock.calls[0][0];
    expect(arg.to).toBe('bill@acme.test');
    expect(arg.subject).toBe('Invoice for Joan Customer sent — $249.00');
    // No `from` → sendEmail falls back to RESEND_FROM_EMAIL (the merchant channel).
    expect(arg.from).toBeUndefined();
    expect(arg.html).toContain('View invoice');
    expect(arg.html).toContain('View customer');
    expect(arg.html).toContain('https://billing.example.com/invoices/inv-1');
    expect(arg.html).toContain('https://billing.example.com/customers/cust-1');
    expect(arg.html).toContain('Joan Customer');
  });

  it('renders "first 3 + N more" for long line-item lists', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendMerchantInvoiceSentNotification({
      ...baseOpts,
      lineItems: [
        { description: 'A', quantity: 1, unitPrice: 1, amount: 1 },
        { description: 'B', quantity: 1, unitPrice: 1, amount: 2 },
        { description: 'C', quantity: 1, unitPrice: 1, amount: 3 },
        { description: 'D', quantity: 1, unitPrice: 1, amount: 4 },
        { description: 'E', quantity: 1, unitPrice: 1, amount: 5 },
      ],
    });

    const html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain('+ 2 more');
    expect(html).toContain('A —');
    expect(html).toContain('C —');
    // The 4th/5th items are folded into "+ 2 more", not listed.
    expect(html).not.toContain('D —');
  });

  it('surfaces an inline warning when the customer email failed', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendMerchantInvoiceSentNotification({
      ...baseOpts,
      customerDeliveryIssue: 'failed',
    });

    const html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain("couldn't email this invoice");
    expect(html).toContain('joan@example.com');
  });

  it('surfaces a no-email warning when the customer has no address', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendMerchantInvoiceSentNotification({
      ...baseOpts,
      customerEmail: undefined,
      customerDeliveryIssue: 'no-email',
    });

    const html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain('no email address on file');
  });

  it('omits the warning entirely on the happy path', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendMerchantInvoiceSentNotification(baseOpts);

    const html = sendSpy.mock.calls[0][0].html;
    expect(html).not.toContain("couldn't email this invoice");
  });

  it('encodes customer-derived name + line-item description in the HTML', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendMerchantInvoiceSentNotification({
      ...baseOpts,
      customerName: RAW_WITH_METACHARS,
      organizationName: RAW_WITH_METACHARS,
      lineItems: [{ description: RAW_WITH_METACHARS, quantity: 1, unitPrice: 1, amount: 1 }],
    });

    const html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain(ENCODED_METACHARS);
    expect(html).not.toContain('<script>x</script>');
  });

  it('keeps the CRLF-injection vector out of the subject header', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendMerchantInvoiceSentNotification({
      ...baseOpts,
      customerName: 'Acme\r\nBcc: sneaky@evil.test',
    });

    const subject = sendSpy.mock.calls[0][0].subject;
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain('Acme Bcc: sneaky@evil.test');
  });
});

// The ladder-alert send path.
describe('EmailService.sendCapAlertEmail', () => {
  const capOpts = {
    to: 'owner@acme.test',
    mode: 'enforce',
    rung: 100,
    scope: 'org' as const,
    scopeValue: null,
    providerScope: 'all',
    amountUsd: 200,
    period: 'week',
    spentUsd: 210,
    percentOfCap: 105,
    asOf: new Date('2026-07-22T09:00:00.000Z'),
  };

  it('sends to the org billing contact and the CTA lands on the Internal AI Spend page', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendCapAlertEmail(capOpts);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const arg = sendSpy.mock.calls[0][0];
    expect(arg.to).toBe('owner@acme.test');
    // The alert link lands on the Internal AI Spend page, on the real
    // dashboard base URL.
    expect(arg.html).toContain('https://billing.example.com/internal-ai-spend');
  });

  it('carries the honest per-mode copy into the subject + body (enforce names the block + raise path)', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendCapAlertEmail(capOpts);
    const arg = sendSpy.mock.calls[0][0];
    expect(arg.subject.toLowerCase()).toContain('100%');
    expect(arg.html.toLowerCase()).toContain('blocked');
    expect(arg.html.toLowerCase()).toContain('to raise it');
  });

  it('track 100% says it is a notification, not a stop', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendCapAlertEmail({ ...capOpts, mode: 'track' });
    const arg = sendSpy.mock.calls[0][0];
    expect(arg.html.toLowerCase()).toContain('this is a notification, not a stop');
  });

  it('encodes scope-derived values so a hostile scopeValue cannot inject markup', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendCapAlertEmail({
      ...capOpts,
      mode: 'track',
      scope: 'dev',
      scopeValue: RAW_WITH_METACHARS,
    });
    const html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain(ENCODED_METACHARS);
    expect(html).not.toContain('<script>x</script>');
  });
});

describe('email output-encoding utilities', () => {
  describe('escapeHtml', () => {
    it('encodes all five HTML metacharacters', () => {
      expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
    });

    it('replaces ampersand first so emitted entities are not re-escaped', () => {
      // If `&` were replaced last, `<` -> `&lt;` -> `&amp;lt;`. Ampersand-first keeps it `&lt;`.
      expect(escapeHtml('<')).toBe('&lt;');
      expect(escapeHtml('&')).toBe('&amp;');
      expect(escapeHtml('&<>')).toBe('&amp;&lt;&gt;');
    });

    it('returns an empty string for empty or nullish input', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml(null)).toBe('');
    });

    it('re-encodes already-encoded input (encoding is a render-time concern, not stored state)', () => {
      expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    });

    it('leaves a metacharacter-free value byte-identical', () => {
      expect(escapeHtml('Acme Corp')).toBe('Acme Corp');
    });
  });

  describe('singleLineSubject', () => {
    it('collapses CR/LF so a value cannot open extra header lines', () => {
      expect(singleLineSubject('Acme\r\nBcc: evil@example.com')).toBe('Acme Bcc: evil@example.com');
      expect(singleLineSubject('a\nb')).toBe('a b');
    });

    it('leaves a single-line value unchanged', () => {
      expect(singleLineSubject('Acme Corp')).toBe('Acme Corp');
    });
  });
});

describe('EmailService HTML output encoding', () => {
  const receiptOpts = {
    to: 'end@customer.test',
    invoiceNumber: 'INV-100',
    amount: '10.00',
    currency: 'USD',
    paymentDate: '2026-07-01',
    invoiceTotal: '10.00',
    amountDue: '0',
    companyEmail: 'support@acme.test',
  };

  const invoiceReadyOpts = {
    to: 'end@customer.test',
    invoiceNumber: 'INV-200',
    amountDue: '20.00',
    currency: 'USD',
    dueDate: '2026-07-10',
    paymentUrl: 'https://pay.example.test/session/abc',
    companyEmail: 'support@acme.test',
  };

  it('payment receipt: encodes customerName + companyName, passes clean values through', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendPaymentReceiptEmail({
      ...receiptOpts,
      customerName: RAW_WITH_METACHARS,
      companyName: RAW_WITH_METACHARS,
      invoiceNumber: RAW_WITH_METACHARS,
      cardBrand: RAW_WITH_METACHARS,
      cardLast4: '4242',
      transactionId: `tx_${RAW_WITH_METACHARS}`,
    });
    let html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain(ENCODED_METACHARS);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain(`Receipt for Invoice ${ENCODED_METACHARS}`);
    expect(html).toContain(`${ENCODED_METACHARS} ending in 4242`);
    expect(html).toContain('tx_PWN&lt;script&gt;x&lt;/script&gt;...');

    sendSpy.mockClear();
    await service.sendPaymentReceiptEmail({
      ...receiptOpts,
      customerName: 'Acme Corp',
      companyName: 'Acme Corp',
    });
    html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain('Hi Acme Corp,');
    expect(html).toContain('You paid Acme Corp');
  });

  it('invoice ready: encodes name, invoiceNumber + line-item description, uses Stripe copy, leaves Pay Now URL intact', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendInvoiceReadyEmail({
      ...invoiceReadyOpts,
      customerName: RAW_WITH_METACHARS,
      companyName: RAW_WITH_METACHARS,
      invoiceNumber: RAW_WITH_METACHARS,
      lineItems: [{ description: RAW_WITH_METACHARS, quantity: 1, unitPrice: 1, amount: 1 }],
    });
    let html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain(ENCODED_METACHARS);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain(`>${ENCODED_METACHARS}</td>`);
    expect(html).toContain('Your payment is processed by Stripe.');
    expect(html).not.toContain('PCI-compliant');
    expect(html).not.toContain('encrypted at every step');

    sendSpy.mockClear();
    await service.sendInvoiceReadyEmail({
      ...invoiceReadyOpts,
      customerName: 'Acme Corp',
      companyName: 'Acme Corp',
      lineItems: [{ description: 'API calls', quantity: 1000, unitPrice: 0.2, amount: 200 }],
    });
    html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain('Hi Acme Corp,');
    expect(html).toContain('API calls');
    // Clean URL must survive encoding unchanged so the payment link still works.
    expect(html).toContain('https://pay.example.test/session/abc');
  });
});

// Customer-facing contact line: prints the caller-resolved companyEmail, OMITS the
// line entirely when none — that omission is what keeps owner emails off customer
// surfaces, so it's locked here.
describe('EmailService customer-facing contact line', () => {
  it('invoice ready: prints the resolved contact address', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendInvoiceReadyEmail({
      to: 'end@customer.test',
      invoiceNumber: 'INV-200',
      amountDue: '20.00',
      currency: 'USD',
      dueDate: '2026-07-10',
      paymentUrl: 'https://pay.example.test/session/abc',
      companyEmail: 'identity@acme.test',
    });
    const html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain('Questions about this invoice? Contact');
    expect(html).toContain('mailto:identity@acme.test');
  });

  it('invoice ready: no contact resolved → the line is omitted entirely', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    await service.sendInvoiceReadyEmail({
      to: 'end@customer.test',
      invoiceNumber: 'INV-200',
      amountDue: '20.00',
      currency: 'USD',
      dueDate: '2026-07-10',
      paymentUrl: 'https://pay.example.test/session/abc',
    });
    const html = sendSpy.mock.calls[0][0].html;
    expect(html).not.toContain('Questions about this invoice?');
    expect(html).not.toContain('mailto:');
  });

  it('payment receipt: prints the resolved contact address, omits the line when none', async () => {
    const service = await buildEmailService();
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });

    const receipt = {
      to: 'end@customer.test',
      invoiceNumber: 'INV-100',
      amount: '10.00',
      currency: 'USD',
      paymentDate: '2026-07-01',
      invoiceTotal: '10.00',
      amountDue: '0',
    };
    await service.sendPaymentReceiptEmail({ ...receipt, companyEmail: 'identity@acme.test' });
    let html = sendSpy.mock.calls[0][0].html;
    expect(html).toContain('mailto:identity@acme.test');

    sendSpy.mockClear();
    await service.sendPaymentReceiptEmail(receipt);
    html = sendSpy.mock.calls[0][0].html;
    expect(html).not.toContain('mailto:');
  });
});

describe('EmailService without an email provider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts with no Resend settings at all and reports email as off', async () => {
    const service = await buildEmailService({ RESEND_FROM_EMAIL: undefined });

    expect(service.isEnabled).toBe(false);
  });

  it('turns every send into a logged no-op that returns null', async () => {
    const service = await buildEmailService({ RESEND_FROM_EMAIL: undefined });

    await expect(
      service.sendEmail({ to: 'someone@example.com', subject: 'Hello', html: '<p>hi</p>' }),
    ).resolves.toBeNull();
  });

  it('refuses to start when RESEND_API_KEY is set without a sender address', async () => {
    await expect(
      buildEmailService({ RESEND_API_KEY: 're_test_key', RESEND_FROM_EMAIL: undefined }),
    ).rejects.toThrow(
      /RESEND_FROM_EMAIL is not.*remove\s+RESEND_API_KEY to run with email turned off/s,
    );
  });

  it('refuses to start without FRONTEND_URL, because every email link is built from it', async () => {
    await expect(buildEmailService({ FRONTEND_URL: undefined })).rejects.toThrow(
      /FRONTEND_URL is missing/,
    );
  });

  it('reports email as on when a key and a sender are configured', async () => {
    const service = await buildEmailService({ RESEND_API_KEY: 're_test_key' });

    expect(service.isEnabled).toBe(true);
  });
});

describe('EmailService product name in customer-facing emails', () => {
  const receipt = {
    to: 'end@customer.test',
    invoiceNumber: 'INV-1',
    amount: '10.00',
    currency: 'USD',
    paymentDate: '2026-07-01',
    invoiceTotal: '10.00',
    amountDue: '0',
  };
  const merchantNote = {
    to: 'bill@acme.test',
    organizationName: 'Acme Co',
    customerName: 'Joan',
    invoiceNumber: 'INV-2',
    amount: '1.00',
    invoiceDetailUrl: 'https://billing.example.com/invoices/inv-2',
    customerDetailUrl: 'https://billing.example.com/customers/c-1',
  };

  afterEach(() => jest.restoreAllMocks());

  async function htmlFor(overrides: Record<string, string | undefined>) {
    const service = await buildEmailService(overrides);
    const sendSpy = jest.spyOn(service, 'sendEmail').mockResolvedValue({ id: 'x' });
    await service.sendPaymentReceiptEmail(receipt);
    await service.sendMerchantInvoiceSentNotification(merchantNote);
    return sendSpy.mock.calls.map(([arg]) => `${arg.subject}\n${arg.html}`).join('\n');
  }

  it('uses a neutral default name, not the MarginFront brand', async () => {
    const html = await htmlFor({});

    expect(html).toContain('Usage Billing');
    expect(html).not.toMatch(/MarginFront/i);
  });

  it('uses PRODUCT_NAME when the operator sets it, encoded for HTML', async () => {
    const html = await htmlFor({ PRODUCT_NAME: 'Larkspur <Billing>' });

    expect(html).toContain('Larkspur &lt;Billing&gt;');
    expect(html).not.toContain('Usage Billing');
  });
});

describe('EmailService email-off startup warning', () => {
  it('warns once per process, however many instances are built', () => {
    jest.isolateModules(() => {
      const { Logger } = require('@nestjs/common');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { EmailService: FreshEmailService } = require('./email.service');
      const config = { get: (key: string) => BASE_CONFIG[key] };

      new FreshEmailService(config);
      new FreshEmailService(config);

      const emailOffWarnings = warn.mock.calls.filter(([message]) =>
        String(message).startsWith('Email is turned off'),
      );
      expect(emailOffWarnings).toHaveLength(1);
      warn.mockRestore();
    });
  });
});
