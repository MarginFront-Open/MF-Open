import { Controller, Post, Req, Param, Headers, RawBodyRequest } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { Public } from '../auth/decorators/public.decorator';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * Receives Stripe payment webhooks. The endpoints are public (no JWT auth);
 * the Stripe adapter verifies each message's signature instead.
 *
 * Webhooks skip every rate-limit bucket. A bare @SkipThrottle() skips only the
 * default bucket, and these routes are keyed by IP, so a retry burst from
 * Stripe could trip the public bucket and drop a valid payment webhook.
 */
@ApiTags('Webhooks')
@Controller('webhooks')
@Public()
@SkipThrottle({ default: true, public: true, sdk: true })
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  // Helper to extract raw body from various request formats
  private extractRawBody(req: RawBodyRequest<Request>): Buffer {
    if (req.rawBody) return req.rawBody;
    if (Buffer.isBuffer(req.body)) return req.body;
    return Buffer.from(JSON.stringify(req.body));
  }

  @Post('stripe')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Handle generic Stripe webhook' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid webhook payload' })
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    return this.webhooksService.handleStripeWebhook(this.extractRawBody(req), signature);
  }

  @Post('stripe/:orgId')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Handle organization-specific Stripe webhook' })
  async handleStripeWebhookForOrg(
    @Req() req: RawBodyRequest<Request>,
    @Param('orgId') orgId: string,
    @Headers('stripe-signature') signature: string,
  ) {
    return this.webhooksService.handleStripeWebhook(this.extractRawBody(req), signature, orgId);
  }
}
