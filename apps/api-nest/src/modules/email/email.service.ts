import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import {
  SendEmailOptions,
  SendPaymentReceiptOptions,
  SendInvoiceReadyOptions,
  SendMerchantInvoiceSentOptions,
  SendCapAlertOptions,
  SendPoolAlertOptions,
  SendCustomerAlertOptions,
  SendCustomerAlertConfirmationOptions,
  SendRevokedKeyInUseOptions,
} from './interfaces/email-options.interface';
import { escapeHtml, singleLineSubject } from './email-encoding.util';
import { requireFrontendUrl, resolveProductName } from '../../common/config/app-config';
import { buildCapAlertContent } from './cap-alert-copy';
import { buildPoolAlertContent, type PoolAlertStage } from './pool-alert-copy';
import { buildCustomerAlertContent, type CustomerAlertContent } from './customer-alert-copy';
import { buildRevokedKeyNoticeContent } from './revoked-key-copy';
import type { CapMode, CapPeriod, CapScope } from '@marginfront/db';

let emailDisabledWarningShown = false;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;
  private readonly fromEmail: string;
  // End-customer emails go from a separate
  // no-reply address (RESEND_INVOICE_FROM_EMAIL), falling back to fromEmail.
  // Public so InvoicesService can pass it as the `from` override on manual sends.
  public readonly invoiceFromEmail: string;
  private readonly frontendUrl: string;
  private readonly productName: string;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY')?.trim();
    const fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL')?.trim();
    if (apiKey && !fromEmail) {
      throw new Error(
        'RESEND_API_KEY is set but RESEND_FROM_EMAIL is not, so emails have no sender address. ' +
          'Set RESEND_FROM_EMAIL to an address on a domain you verified in Resend, or remove ' +
          'RESEND_API_KEY to run with email turned off.',
      );
    }
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.fromEmail = fromEmail ?? '';
    this.invoiceFromEmail =
      this.configService.get<string>('RESEND_INVOICE_FROM_EMAIL')?.trim() || this.fromEmail;
    this.frontendUrl = requireFrontendUrl(this.configService);
    this.productName = resolveProductName(this.configService);

    if (!this.resend && !emailDisabledWarningShown) {
      emailDisabledWarningShown = true;
      this.logger.warn(
        'Email is turned off: RESEND_API_KEY is not set, so invoices, receipts and alerts ' +
          'will be logged here instead of sent. To send email, set RESEND_API_KEY and ' +
          'RESEND_FROM_EMAIL in apps/api-nest/.env and restart.',
      );
    }
  }

  get isEnabled(): boolean {
    return this.resend !== null;
  }

  /**
   * Send an email using Resend. Pass `from` to override the default
   * RESEND_FROM_EMAIL on a per-call basis (e.g. invoice-ready emails use
   * the noreply variant). Returns null without sending when email is off.
   */
  async sendEmail({ to, subject, html, from }: SendEmailOptions): Promise<any> {
    if (!this.resend) {
      this.logger.log(`Email is turned off, so "${subject}" was not sent.`);
      return null;
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: from ?? this.fromEmail,
        to,
        subject,
        html,
      });

      if (error) {
        this.logger.error(`Failed to send email to ${to}:`, error);
        throw error;
      }

      this.logger.log(`Email sent to ${to} with ID: ${data?.id}`);
      return data;
    } catch (error) {
      this.logger.error(`Unexpected error sending email to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send payment receipt email
   */
  async sendPaymentReceiptEmail(options: SendPaymentReceiptOptions): Promise<any> {
    const {
      to,
      customerName,
      invoiceNumber,
      amount,
      currency = 'USD',
      paymentDate,
      cardLast4,
      cardBrand,
      transactionId,
      invoiceTotal,
      amountDue,
      receiptUrl,
      companyName,
      companyEmail,
    } = options;

    // Lead the subject with the merchant's org name so the end
    // customer immediately sees who they paid (the merchant, not the platform).
    const subject = `Receipt from ${singleLineSubject(companyName || this.productName)} — Invoice ${singleLineSubject(invoiceNumber)}`;

    // Helper: Format currency
    const formatCurrency = (value: number | string, curr: string): string => {
      const num = parseFloat(value.toString()) || 0;
      const symbols: Record<string, string> = {
        USD: '$',
        EUR: '€',
        GBP: '£',
        INR: '₹',
      };
      const symbol = symbols[curr?.toUpperCase()] || escapeHtml(curr || '$');
      return `${symbol}${num.toFixed(2)}`;
    };

    // Helper: Format date
    const formatDate = (date: Date | string): string => {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    };

    // Helper: Format card brand
    const formatCardBrand = (brand?: string): string => {
      if (!brand) return '';
      const brands: Record<string, string> = {
        visa: 'Visa',
        mastercard: 'Mastercard',
        amex: 'American Express',
        discover: 'Discover',
        diners: 'Diners Club',
        jcb: 'JCB',
        unionpay: 'UnionPay',
      };
      return brands[brand.toLowerCase()] || brand.charAt(0).toUpperCase() + brand.slice(1);
    };

    // Build payment method display
    let paymentMethodDisplay = 'Card';
    if (cardBrand && cardLast4) {
      paymentMethodDisplay = `${formatCardBrand(cardBrand)} ending in ${cardLast4}`;
    } else if (cardLast4) {
      paymentMethodDisplay = `Card ending in ${cardLast4}`;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #003024 0%, #004d3d 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #00ff88; margin: 0; font-size: 28px; font-weight: 600;">You paid ${escapeHtml(companyName || 'us')} ${formatCurrency(amount, currency)}</h1>
            <p style="color: #ffffff; margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Receipt for Invoice ${escapeHtml(invoiceNumber)}</p>
          </div>

          <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <p style="color: #333; font-size: 16px; margin: 0 0 20px 0;">
              Hi${customerName ? ` ${escapeHtml(customerName)}` : ''},
            </p>
            <p style="color: #666; font-size: 15px; margin: 0 0 25px 0; line-height: 1.6;">
              We've received your payment for Invoice <strong>${escapeHtml(invoiceNumber)}</strong>. Here are the details of your transaction:
            </p>

            <div style="background-color: #f8faf9; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
              <div style="text-align: center; margin-bottom: 15px;">
                <span style="font-size: 36px; font-weight: 700; color: #003024;">${formatCurrency(amount, currency)}</span>
                <p style="color: #666; font-size: 14px; margin: 5px 0 0 0;">Amount Paid</p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 15px 0;">

              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #666; font-size: 14px;">Invoice Number</td>
                  <td style="padding: 8px 0; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${escapeHtml(invoiceNumber)}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #666; font-size: 14px;">Payment Date</td>
                  <td style="padding: 8px 0; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${formatDate(paymentDate)}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #666; font-size: 14px;">Payment Method</td>
                  <td style="padding: 8px 0; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${escapeHtml(paymentMethodDisplay)}</td>
                </tr>
                ${
                  transactionId
                    ? `
                <tr>
                  <td style="padding: 8px 0; color: #666; font-size: 14px;">Transaction ID</td>
                  <td style="padding: 8px 0; color: #333; font-size: 12px; text-align: right; font-family: monospace;">${escapeHtml(transactionId.substring(0, 24))}...</td>
                </tr>
                `
                    : ''
                }
              </table>
            </div>

            ${
              parseFloat(amountDue.toString()) > 0
                ? `
            <div style="background-color: #fff8e6; border: 1px solid #ffd666; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
              <p style="margin: 0; color: #8a6d3b; font-size: 14px;">
                <strong>Remaining Balance:</strong> ${formatCurrency(amountDue, currency)} of ${formatCurrency(invoiceTotal, currency)} total
              </p>
            </div>
            `
                : `
            <div style="background-color: #e6f7e6; border: 1px solid #52c41a; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
              <p style="margin: 0; color: #3c763d; font-size: 14px;">
                ✓ <strong>Paid in Full</strong> - Invoice total: ${formatCurrency(invoiceTotal, currency)}
              </p>
            </div>
            `
            }

            ${
              receiptUrl
                ? `
            <div style="text-align: center; margin: 25px 0;">
              <a href="${escapeHtml(receiptUrl)}"
                 style="display: inline-block; background-color: #003024; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">
                Download Receipt
              </a>
            </div>
            `
                : ''
            }

            ${
              companyEmail
                ? `
            <div style="border-top: 1px solid #eaeaea; padding-top: 20px; margin-top: 25px;">
              <p style="color: #666; font-size: 14px; margin: 0; line-height: 1.6;">
                If you have any questions about this payment, please contact us at
                <a href="mailto:${escapeHtml(companyEmail)}" style="color: #003024; text-decoration: none;">${escapeHtml(companyEmail)}</a>
              </p>
            </div>
            `
                : ''
            }
          </div>

          <div style="text-align: center; padding: 20px;">
            <p style="color: #888; font-size: 12px; margin: 0;">
              ${escapeHtml(companyName || this.productName)}<br>
              This is an automated receipt. Please do not reply to this email.
            </p>
            <p style="color: #aaa; font-size: 11px; margin: 8px 0 0 0;">
              Sent by ${escapeHtml(this.productName)} on behalf of ${escapeHtml(companyName || this.productName)}
            </p>
            <p style="color: #888; font-size: 12px; margin: 10px 0 0 0;">
              © ${new Date().getFullYear()} ${escapeHtml(companyName || this.productName)}. All rights reserved.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Receipts go to end-customers of the merchant, so they use the
    // no-reply sender (same as the invoice-ready path).
    return this.sendEmail({ to, subject, html, from: this.invoiceFromEmail });
  }

  /**
   * Send an "invoice ready, please pay" email to a merchant's end-customer.
   *
   * This is the email that goes out when:
   *   - The `dispatch` cron issues a usage invoice at the end of a billing period, OR
   *   - The merchant manually clicks "Send" on a draft in the dashboard.
   *
   * It is DISTINCT from sendPaymentReceiptEmail (which fires AFTER payment is received).
   * The single most important element is the "Pay Now" button → paymentUrl, which lands
   * the customer on a Stripe Checkout Session.
   */
  async sendInvoiceReadyEmail(options: SendInvoiceReadyOptions): Promise<any> {
    const {
      to,
      customerName,
      invoiceNumber,
      amountDue,
      currency = 'USD',
      dueDate,
      paymentUrl,
      companyName,
      companyEmail,
      lineItems,
    } = options;

    const subject = `Invoice ${singleLineSubject(invoiceNumber)} from ${singleLineSubject(companyName || this.productName)} — Ready to Pay`;

    const formatCurrency = (value: number | string, curr: string): string => {
      const num = parseFloat(value.toString()) || 0;
      const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };
      const symbol = symbols[curr?.toUpperCase()] || escapeHtml(curr || '$');
      return `${symbol}${num.toFixed(2)}`;
    };

    const formatDate = (date: Date | string): string => {
      const d = date instanceof Date ? date : new Date(date);
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #003024 0%, #004d3d 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #00ff88; margin: 0; font-size: 28px; font-weight: 600;">Invoice Ready</h1>
            <p style="color: #ffffff; margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Your invoice from ${escapeHtml(companyName || this.productName)} is ready to pay.</p>
          </div>

          <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <p style="color: #333; font-size: 16px; margin: 0 0 20px 0;">
              Hi${customerName ? ` ${escapeHtml(customerName)}` : ''},
            </p>
            <p style="color: #666; font-size: 15px; margin: 0 0 12px 0; line-height: 1.6;">
              <strong>${escapeHtml(companyName || this.productName)}</strong> has issued you an invoice for <strong>${formatCurrency(amountDue, currency)}</strong>.
            </p>
            <p style="color: #666; font-size: 15px; margin: 0 0 25px 0; line-height: 1.6;">
              Click the button below to pay. Your payment is processed by Stripe.
            </p>

            <div style="background-color: #f8faf9; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
              <div style="text-align: center; margin-bottom: 15px;">
                <span style="font-size: 36px; font-weight: 700; color: #003024;">${formatCurrency(amountDue, currency)}</span>
                <p style="color: #666; font-size: 14px; margin: 5px 0 0 0;">Amount Due</p>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 15px 0;">

              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #666; font-size: 14px;">Invoice Number</td>
                  <td style="padding: 8px 0; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${escapeHtml(invoiceNumber)}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #666; font-size: 14px;">Due Date</td>
                  <td style="padding: 8px 0; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${formatDate(dueDate)}</td>
                </tr>
              </table>
            </div>

            ${
              lineItems && lineItems.length > 0
                ? `
            <div style="margin: 0 0 25px 0;">
              <h3 style="color: #003024; font-size: 16px; margin: 0 0 12px 0; font-weight: 600;">What you're paying for</h3>
              <table style="width: 100%; border-collapse: collapse; border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden;">
                <thead>
                  <tr style="background-color: #f8faf9;">
                    <th style="padding: 10px 12px; color: #003024; font-size: 13px; text-align: left; font-weight: 600;">Description</th>
                    <th style="padding: 10px 12px; color: #003024; font-size: 13px; text-align: right; font-weight: 600;">Qty</th>
                    <th style="padding: 10px 12px; color: #003024; font-size: 13px; text-align: right; font-weight: 600;">Unit</th>
                    <th style="padding: 10px 12px; color: #003024; font-size: 13px; text-align: right; font-weight: 600;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${lineItems
                    .map(
                      (li) => `
                  <tr style="border-top: 1px solid #f0f0f0;">
                    <td style="padding: 10px 12px; color: #333; font-size: 14px;">${escapeHtml(li.description)}</td>
                    <td style="padding: 10px 12px; color: #666; font-size: 14px; text-align: right;">${li.quantity}</td>
                    <td style="padding: 10px 12px; color: #666; font-size: 14px; text-align: right;">${formatCurrency(li.unitPrice, currency)}</td>
                    <td style="padding: 10px 12px; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${formatCurrency(li.amount, currency)}</td>
                  </tr>`,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
            `
                : ''
            }

            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapeHtml(paymentUrl)}"
                 style="display: inline-block; background-color: #003024; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600;">
                Pay Now
              </a>
            </div>

            ${
              companyEmail
                ? `
            <div style="border-top: 1px solid #eaeaea; padding-top: 20px; margin-top: 25px;">
              <p style="color: #666; font-size: 14px; margin: 0; line-height: 1.6;">
                Questions about this invoice? Contact
                <a href="mailto:${escapeHtml(companyEmail)}" style="color: #003024; text-decoration: none;">${escapeHtml(companyEmail)}</a>
              </p>
            </div>
            `
                : ''
            }
          </div>

          <div style="text-align: center; padding: 20px;">
            <p style="color: #888; font-size: 12px; margin: 0;">
              ${escapeHtml(companyName || this.productName)}<br>
              This invoice was sent automatically. Reply to the support address above with any questions.
            </p>
            <p style="color: #888; font-size: 12px; margin: 10px 0 0 0;">
              © ${new Date().getFullYear()} ${escapeHtml(companyName || this.productName)}. All rights reserved.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Invoice-ready emails use the no-reply
    // sender (RESEND_INVOICE_FROM_EMAIL).
    return this.sendEmail({ to, subject, html, from: this.invoiceFromEmail });
  }

  /**
   * Tell the MERCHANT that an invoice was auto-issued to one of their
   * end-customers.
   *
   * This operator notification makes every auto-send visible, so the merchant
   * is never left out of an invoice that went to a customer. It fires once per
   * invoice from the `dispatch` cron, immediately after the customer's
   * "invoice ready" email.
   *
   * Sender: the default RESEND_FROM_EMAIL — NO `from` override here, unlike
   * sendInvoiceReadyEmail, so a merchant reply reaches whoever runs this deployment.
   */
  async sendMerchantInvoiceSentNotification(options: SendMerchantInvoiceSentOptions): Promise<any> {
    const {
      to,
      organizationName,
      customerName,
      customerEmail,
      invoiceNumber,
      amount,
      currency = 'USD',
      invoiceDetailUrl,
      customerDetailUrl,
      lineItems,
      customerDeliveryIssue,
    } = options;

    const formatCurrency = (value: number | string, curr: string): string => {
      const num = parseFloat(value.toString()) || 0;
      const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };
      const symbol = symbols[curr?.toUpperCase()] || escapeHtml(curr || '$');
      return `${symbol}${num.toFixed(2)}`;
    };

    const formattedTotal = formatCurrency(amount, currency);
    const customerLabel = customerName || 'your customer';

    // Subject carries the customer name + total so the merchant can search their inbox
    // by customer and the amount is visible without opening the email.
    const subject = `Invoice for ${singleLineSubject(customerLabel)} sent — ${singleLineSubject(formattedTotal)}`;

    // The first 3 line items as a bullet list, then "+ N more" when truncated.
    const items = lineItems ?? [];
    const shownItems = items.slice(0, 3);
    const remaining = items.length - shownItems.length;
    const lineItemsHtml =
      shownItems.length > 0
        ? `<ul style="margin: 8px 0 0 0; padding-left: 20px; color: #333; font-size: 14px; line-height: 1.6;">
            ${shownItems
              .map(
                (li) =>
                  `<li>${escapeHtml(li.description)} — ${formatCurrency(li.amount, currency)}</li>`,
              )
              .join('')}
            ${remaining > 0 ? `<li style="color: #888;">+ ${remaining} more</li>` : ''}
          </ul>`
        : `<p style="margin: 8px 0 0 0; color: #888; font-size: 14px;">(no line items)</p>`;

    // If the customer email couldn't be delivered, warn the merchant inline so they
    // know to follow up — the invoice still went out, only the email notification to
    // the customer failed.
    const deliveryWarningHtml = customerDeliveryIssue
      ? `<div style="background-color: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 14px 16px; margin: 0 0 20px 0;">
           <p style="color: #9a3412; font-size: 14px; margin: 0; line-height: 1.5;">
             ⚠️ Heads up: we couldn't email this invoice to ${escapeHtml(customerLabel)}${
               customerDeliveryIssue === 'no-email'
                 ? ' because they have no email address on file'
                 : customerEmail
                   ? ` at ${escapeHtml(customerEmail)}`
                   : ''
             }. The invoice was still issued — you may want to check their email address and resend, or share the invoice link manually.
           </p>
         </div>`
      : '';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #003024 0%, #004d3d 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #00ff88; margin: 0; font-size: 24px; font-weight: 600;">Invoice Sent</h1>
            <p style="color: #ffffff; margin: 10px 0 0 0; font-size: 15px; opacity: 0.9;">We just sent an invoice to one of your customers.</p>
          </div>

          <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <p style="color: #333; font-size: 16px; margin: 0 0 20px 0;">
              Hey${organizationName ? ` ${escapeHtml(organizationName)}` : ' there'},
            </p>

            ${deliveryWarningHtml}

            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">
              We just sent an invoice to your customer.
            </p>

            <div style="background-color: #f8faf9; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 6px 0; color: #666; font-size: 14px;">Customer</td>
                  <td style="padding: 6px 0; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${escapeHtml(customerLabel)}${
                    customerEmail ? ` (${escapeHtml(customerEmail)})` : ''
                  }</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #666; font-size: 14px;">Invoice</td>
                  <td style="padding: 6px 0; color: #333; font-size: 14px; text-align: right; font-weight: 500;">${escapeHtml(invoiceNumber)}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #666; font-size: 14px;">Total</td>
                  <td style="padding: 6px 0; color: #003024; font-size: 16px; text-align: right; font-weight: 700;">${formattedTotal}</td>
                </tr>
              </table>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 15px 0;">

              <p style="color: #003024; font-size: 14px; font-weight: 600; margin: 0;">Line items</p>
              ${lineItemsHtml}
            </div>

            <div style="text-align: center; margin: 25px 0;">
              <a href="${escapeHtml(invoiceDetailUrl)}"
                 style="display: inline-block; background-color: #003024; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-size: 15px; font-weight: 600; margin: 0 6px 10px 6px;">
                View invoice
              </a>
              <a href="${escapeHtml(customerDetailUrl)}"
                 style="display: inline-block; background-color: #ffffff; color: #003024; border: 1px solid #003024; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-size: 15px; font-weight: 600; margin: 0 6px 10px 6px;">
                View customer
              </a>
            </div>

            <p style="color: #666; font-size: 14px; margin: 0; line-height: 1.6;">
              If something looks wrong, you can void this invoice from the dashboard.
            </p>
          </div>

          <div style="text-align: center; padding: 20px;">
            <p style="color: #888; font-size: 12px; margin: 0;">
              — ${escapeHtml(this.productName)}
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({ to, subject, html });
  }

  /**
   * A ladder-alert email. The copy that must never
   * blur "alert" and "block" is built by the pure buildCapAlertContent (unit-
   * tested as literal strings); this method only wraps it in branded HTML,
   * output-encodes every interpolation, and points the CTA at the Spend Controls
   * money tab.
   *
   * Sender: the default RESEND_FROM_EMAIL (NO `from` override) — this is an operator
   * notification to the org's own billing contact, same channel as the merchant
   * invoice-sent notification.
   */
  async sendCapAlertEmail(options: SendCapAlertOptions): Promise<any> {
    const content = buildCapAlertContent({
      mode: options.mode as CapMode,
      rung: options.rung,
      scope: options.scope as CapScope,
      scopeValue: options.scopeValue,
      providerScope: options.providerScope,
      amountUsd: options.amountUsd,
      period: options.period as CapPeriod,
      spentUsd: options.spentUsd,
      percentOfCap: options.percentOfCap,
      asOf: options.asOf,
    });

    const spendControlsUrl = `${this.frontendUrl}/internal-ai-spend`;
    const subject = singleLineSubject(content.subject);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #003024 0%, #004d3d 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #00ff88; margin: 0; font-size: 26px; font-weight: 600;">${escapeHtml(content.headline)}</h1>
          </div>

          <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What happened</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatHappened)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What it means</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatItMeans)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What to do</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 25px 0; line-height: 1.6;">${escapeHtml(content.whatToDo)}</p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapeHtml(spendControlsUrl)}"
                 style="display: inline-block; background-color: #003024; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600;">
                Open Internal AI Spend
              </a>
            </div>
          </div>

          <div style="text-align: center; padding: 20px;">
            <p style="color: #888; font-size: 12px; margin: 0;">
              ${escapeHtml(this.productName)} Internal AI Spend<br>
              This is an automated spend alert.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({ to: options.to, subject, html });
  }

  /**
   * A staged pool-alert email, sibling of the cap
   * alert above. The track-only-truth copy (nothing stops at zero; overage
   * bills at the plan's rate) is built by the pure buildPoolAlertContent
   * (unit-tested as literal strings); this method only wraps it in branded
   * HTML, output-encodes every interpolation, and points the CTA at the
   * needs-attention page.
   *
   * Sender: the default RESEND_FROM_EMAIL (NO `from` override) — an operator notification
   * to the org's own billing contact, same channel as the cap alert. Returns null (via sendEmail) when
   * email is turned off — the evaluator counts that as NOT sent.
   */
  async sendPoolAlertEmail(options: SendPoolAlertOptions): Promise<any> {
    const content = buildPoolAlertContent({
      stage: options.stage as PoolAlertStage,
      customerName: options.customerName,
      subscriptionName: options.subscriptionName,
      poolSizeUnits: options.poolSizeUnits,
      remainingUnits: options.remainingUnits,
      percentUsed: options.percentUsed,
      overageRate: options.overageRate,
      periodClosed: options.periodClosed,
      asOf: options.asOf,
    });

    const needsAttentionUrl = `${this.frontendUrl}/metrics-events/needs-attention`;
    const subject = singleLineSubject(content.subject);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #003024 0%, #004d3d 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #00ff88; margin: 0; font-size: 26px; font-weight: 600;">${escapeHtml(content.headline)}</h1>
          </div>

          <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What happened</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatHappened)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What it means</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatItMeans)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What to do</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 25px 0; line-height: 1.6;">${escapeHtml(content.whatToDo)}</p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapeHtml(needsAttentionUrl)}"
                 style="display: inline-block; background-color: #003024; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600;">
                Open the needs-attention page
              </a>
            </div>
          </div>

          <div style="text-align: center; padding: 20px;">
            <p style="color: #888; font-size: 12px; margin: 0;">
              ${escapeHtml(this.productName)} credit pool alerts<br>
              This is an automated billing alert.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({ to: options.to, subject, html });
  }
  /**
   * A customer-watch email (trigger or confirmation), third
   * sibling of the cap and pool alerts above. The copy is built by the pure
   * buildCustomerAlertContent (unit-tested as literal strings); this method
   * only wraps it in branded HTML, output-encodes every interpolation, and
   * points the CTA at THAT customer's page (internal UUID, never externalId).
   *
   * Sender: the default RESEND_FROM_EMAIL (NO `from` override) — an operator notification
   * to the org's own staff, same channel as the cap alert. Returns null (via
   * sendEmail) when email is turned off — the evaluator counts that as NOT sent and burns nothing.
   */
  private customerAlertHtml(content: CustomerAlertContent, customerId: string): string {
    const customerUrl = `${this.frontendUrl}/customers/${customerId}`;
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #003024 0%, #004d3d 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #00ff88; margin: 0; font-size: 26px; font-weight: 600;">${escapeHtml(content.headline)}</h1>
          </div>

          <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What happened</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatHappened)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What it means</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatItMeans)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What to do</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 25px 0; line-height: 1.6;">${escapeHtml(content.whatToDo)}</p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapeHtml(customerUrl)}"
                 style="display: inline-block; background-color: #003024; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600;">
                Open the customer page
              </a>
            </div>
          </div>

          <div style="text-align: center; padding: 20px;">
            <p style="color: #888; font-size: 12px; margin: 0;">
              ${escapeHtml(this.productName)} customer alerts<br>
              This is an automated customer watch.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  async sendCustomerAlertEmail(options: SendCustomerAlertOptions): Promise<any> {
    const content = buildCustomerAlertContent({
      variant: 'trigger',
      customerName: options.customerName,
      metric: options.metric as 'cost' | 'revenue',
      thresholdUsd: options.thresholdUsd,
      windowMode: options.windowMode as 'month' | 'rolling' | 'custom',
      customStartDate: options.customStartDate,
      customEndDate: options.customEndDate,
      valueUsd: options.valueUsd,
      asOf: options.asOf,
    });
    const subject = singleLineSubject(content.subject);
    const html = this.customerAlertHtml(content, options.customerId);
    return this.sendEmail({ to: options.to, subject, html });
  }

  /**
   * The create-time confirmation ("your watch is live"). Same
   * wrap, same sender, same null-when-unconfigured contract. The create path
   * treats a failure here as non-fatal: the watch exists either way.
   */
  async sendCustomerAlertConfirmationEmail(
    options: SendCustomerAlertConfirmationOptions,
  ): Promise<any> {
    const content = buildCustomerAlertContent({
      variant: 'confirmation',
      customerName: options.customerName,
      metric: options.metric as 'cost' | 'revenue',
      thresholdUsd: options.thresholdUsd,
      windowMode: options.windowMode as 'month' | 'rolling' | 'custom',
      customStartDate: options.customStartDate,
      customEndDate: options.customEndDate,
      valueUsd: null,
      asOf: options.asOf,
    });
    const subject = singleLineSubject(content.subject);
    const html = this.customerAlertHtml(content, options.customerId);
    return this.sendEmail({ to: options.to, subject, html });
  }

  /**
   * The revoked-key-in-use owner notice, fourth sibling of the
   * cap/pool/customer alerts above. The copy is built by the pure
   * buildRevokedKeyNoticeContent (unit-tested as literal strings); this method
   * only wraps it in branded HTML, output-encodes every interpolation, and
   * points the CTA at the API keys tab (/build?tab=keys).
   *
   * Sender: the default RESEND_FROM_EMAIL (NO `from` override) — an operator notification
   * to the org's own alert recipients, same channel as the cap alert. Returns null (via sendEmail) when
   * email is turned off — the notice service counts that as NOT sent.
   */
  async sendRevokedKeyInUseEmail(options: SendRevokedKeyInUseOptions): Promise<any> {
    const content = buildRevokedKeyNoticeContent({
      keyLabel: options.keyLabel,
      revokedAt: options.revokedAt,
      attempts: options.attempts,
    });

    const apiKeysUrl = `${this.frontendUrl}/build?tab=keys`;
    const subject = singleLineSubject(content.subject);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: 'Segoe UI', Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #003024 0%, #004d3d 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #00ff88; margin: 0; font-size: 26px; font-weight: 600;">${escapeHtml(content.headline)}</h1>
          </div>

          <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What happened</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatHappened)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What it means</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 20px 0; line-height: 1.6;">${escapeHtml(content.whatItMeans)}</p>

            <p style="color: #333; font-size: 16px; margin: 0 0 8px 0; font-weight: 600;">What to do</p>
            <p style="color: #666; font-size: 15px; margin: 0 0 25px 0; line-height: 1.6;">${escapeHtml(content.whatToDo)}</p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${escapeHtml(apiKeysUrl)}"
                 style="display: inline-block; background-color: #003024; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600;">
                Open API keys
              </a>
            </div>
          </div>

          <div style="text-align: center; padding: 20px;">
            <p style="color: #888; font-size: 12px; margin: 0;">
              ${escapeHtml(this.productName)} API key alerts<br>
              This is an automated security notice.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({ to: options.to, subject, html });
  }
}
