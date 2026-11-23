import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookDedupeService } from './webhook-dedupe.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { InvoicesModule } from '../invoices/invoices.module';

/**
 * Webhooks module. Imports InvoicesModule to inject the canonical payment
 * and refund reconcilers. All invoice.amountPaid writes triggered by webhook
 * events flow through InvoicePaymentReconciler / InvoiceRefundFinalizer
 * on purpose.
 *
 * WebhookDedupeService provides Redis-backed in-flight dedupe in
 * front of the existing DB-layer dedupe in WebhooksService.createWebhookRecord.
 */
@Module({
  imports: [PrismaModule, ConfigModule, EmailModule, PaymentProvidersModule, InvoicesModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDedupeService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
