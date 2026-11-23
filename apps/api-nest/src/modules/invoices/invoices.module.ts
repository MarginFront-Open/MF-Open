import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentReconciler } from './invoice-payment-reconciler.service';
import { InvoiceRefundFinalizer } from './invoice-refund-finalizer.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PdfModule } from '../pdf/pdf.module';
import { EmailModule } from '../email/email.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
import { RevenueMetricsService } from '../analytics/revenue-metrics.service';
// SubscriptionModule wraps SubscriptionBillingService which knows how to build a draft invoice
// from a subscription's usage events. POST /v1/invoices/generate delegates to it.
// forwardRef defends against a future cycle if subscription ever imports invoices.
import { SubscriptionModule } from '../subscription/subscription.module';

/**
 * Invoices module. Houses the CRUD controller + the two canonical
 * payment-and-refund reconciler services (InvoicePaymentReconciler and
 * InvoiceRefundFinalizer) that are also consumed from the Webhooks module.
 *
 * `RevenueMetricsService` is registered here (and exported) so consumer
 * modules (webhooks, portal-api) can inject the reconcilers without having
 * to also register the revenue-metrics wrapper themselves. Same pattern the
 * Dashboard module uses.
 */
@Module({
  imports: [
    PrismaModule,
    PdfModule,
    EmailModule,
    ConfigModule,
    PaymentProvidersModule,
    forwardRef(() => SubscriptionModule),
  ],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoicePaymentReconciler,
    InvoiceRefundFinalizer,
    RevenueMetricsService,
  ],
  exports: [InvoicesService, InvoicePaymentReconciler, InvoiceRefundFinalizer],
})
export class InvoicesModule {}
