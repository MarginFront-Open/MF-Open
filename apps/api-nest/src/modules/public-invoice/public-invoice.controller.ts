import { Controller, Get, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiExcludeEndpoint } from '@nestjs/swagger';
import { PublicInvoiceService } from './public-invoice.service';
import { Public } from '../auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';

/**
 * Public Invoice Controller
 *
 * IMPORTANT: These are PUBLIC endpoints - NO authentication required
 * Accessed via direct invoice ID from email links or public shares
 */
// Public bucket (60/60s per IP) applies to all routes by default. Sensitive
// routes below override with even tighter limits via method-level @Throttle —
// PDF generation (Chromium spawn, expensive) and checkout (triggers payment
// processing) are the obvious abuse targets.
@ApiTags('Public Invoice')
@Controller('public/invoices')
@Public() // All endpoints in this controller are public - no authentication required
@Throttle({ public: { limit: 60, ttl: 60_000 } })
export class PublicInvoiceController {
  constructor(private readonly publicInvoiceService: PublicInvoiceService) {}

  // There is no hosted invoice page: Stripe emails its own receipt and status.
  // `POST :id/checkout` is called by the dashboard `/i/[id]/pay` route handler and
  // `GET :id/pdf` by the manual-send dialog.

  /**
   * Get invoice PDF
   * Returns PDF URL or redirects to PDF download
   */
  // Tighter limit: each PDF render spawns a Chromium worker. 20/60s/IP keeps
  // a legit user able to retry a few times without letting a scraper trigger
  // expensive Chromium spawns at scale.
  @Throttle({ public: { limit: 20, ttl: 60_000 } })
  @Get(':invoiceId/pdf')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get invoice PDF',
    description: 'Download or get PDF URL for the invoice. No authentication required.',
  })
  @ApiParam({
    name: 'invoiceId',
    description: 'The unique invoice ID',
    example: 'inv_1234567890',
  })
  @ApiResponse({
    status: 200,
    description: 'PDF URL retrieved successfully',
    schema: {
      example: {
        url: 'https://files.example.com/invoices/inv_1234567890/invoice-INV-2024-001.pdf',
        invoiceNumber: 'INV-2024-001',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Invoice not found',
  })
  @ApiExcludeEndpoint() // Hide from main Swagger docs (public endpoint)
  async getPublicInvoicePdf(@Param('invoiceId') invoiceId: string) {
    return this.publicInvoiceService.getPublicInvoicePdf(invoiceId);
  }

  /**
   * Create checkout session
   * Creates a Stripe checkout session for invoice payment
   */
  // Tightest limit on this controller: 10/60s/IP. This route triggers actual
  // payment-processor calls (Stripe checkout session create). Nobody legit
  // hits this more than a few times — repeat hits are either a confused user
  // or someone trying to spam the payment system.
  @Throttle({ public: { limit: 10, ttl: 60_000 } })
  @Post(':invoiceId/checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create checkout session',
    description: 'Create a Stripe checkout session to pay the invoice. No authentication required.',
  })
  @ApiParam({
    name: 'invoiceId',
    description: 'The unique invoice ID',
    example: 'inv_1234567890',
  })
  @ApiResponse({
    status: 201,
    description: 'Checkout session created successfully',
    schema: {
      example: {
        id: 'cs_test_1234567890',
        url: 'https://checkout.stripe.com/pay/cs_test_inv_1234567890_1234567890',
        invoiceId: 'inv_1234567890',
        invoiceNumber: 'INV-2024-001',
        amount: 11000,
        currency: 'USD',
        customerEmail: 'john@example.com',
        expiresAt: '2024-01-01T12:30:00.000Z',
        createdAt: '2024-01-01T12:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Invoice not found or already paid',
  })
  @ApiExcludeEndpoint() // Hide from main Swagger docs (public endpoint)
  async createCheckoutSession(@Param('invoiceId') invoiceId: string) {
    return this.publicInvoiceService.createCheckoutSession(invoiceId);
  }
}
