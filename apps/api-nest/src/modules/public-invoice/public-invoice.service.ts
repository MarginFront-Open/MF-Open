import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentProcessingService } from '../payment-providers/payment-processing.service';

/**
 * Public Invoice Service
 *
 * The unauthenticated invoice endpoints behind an invoice link: the PDF
 * download and the checkout session. No authentication required.
 *
 * Payment processing is delegated to PaymentProcessingService, which
 * talks to Stripe through the payment adapter.
 */
@Injectable()
export class PublicInvoiceService {
  constructor(
    private prisma: PrismaService,
    private paymentProcessingService: PaymentProcessingService,
  ) {}

  // There is no hosted invoice view: Stripe sends its own receipt and status
  // emails. createCheckoutSession is called by the `/i/[id]/pay` dashboard route
  // handler and getPublicInvoicePdf by the manual-send "Attach PDF" path.

  /**
   * Get public invoice PDF URL or buffer
   */
  async getPublicInvoicePdf(invoiceId: string) {
    const invoice = await this.prisma.invoices.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        pdfUrl: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${invoiceId} not found`);
    }

    if (invoice.pdfUrl) {
      return {
        url: invoice.pdfUrl,
        invoiceNumber: invoice.invoiceNumber,
      };
    }

    return {
      url: null,
      invoiceNumber: invoice.invoiceNumber,
      message:
        'No PDF has been stored for this invoice yet, so there is nothing to download. ' +
        'Ask the sender for a copy, or try again after the invoice has been issued.',
    };
  }

  /**
   * Create a checkout session for invoice payment.
   *
   * This delegates to PaymentProcessingService, which redirects the customer
   * to the Stripe Checkout page.
   *
   * CANONICAL STATUS:
   *   Checkout amount comes from the single invoice's stored
   *   `totalAmount` and `amountDue` columns. Those columns ARE the
   *   canonical per-invoice source (CANON.md rule I2 reads them directly;
   *   getInvoiceTotals in @marginfront/db sums THESE values across
   *   invoices). No aggregated math happens in this path, so no library
   *   call is required. PaymentProcessingService re-reads the same
   *   columns for validation before creating the provider session.
   */
  async createCheckoutSession(invoiceId: string) {
    const invoice = await this.prisma.invoices.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        totalAmount: true,
        currency: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${invoiceId} not found`);
    }

    if (invoice.status === 'paid') {
      throw new BadRequestException('Invoice has already been paid');
    }

    if (invoice.status === 'void') {
      throw new BadRequestException(`Invoice is ${invoice.status} and cannot be paid`);
    }

    // PaymentProcessingService picks the org's provider and creates its checkout.
    const result = await this.paymentProcessingService.createCheckoutSession(invoiceId);

    return {
      success: true,
      session: {
        sessionId: result.sessionId,
        url: result.url,
        expiresAt: result.expiresAt,
      },
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.totalAmount,
      currency: invoice.currency,
    };
  }
}
