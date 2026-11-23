import { Module } from '@nestjs/common';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { InvoiceCalculatorModule } from '../invoice-calculator/invoice-calculator.module';
import { PdfModule } from '../pdf/pdf.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';
// Subscription detail revenue endpoint pulls canonical RevenueMetrics
// via the analytics wrapper service.
import { AnalyticsModule } from '../analytics/analytics.module';
// SubscriptionBillingService's dispatch cron sends the "invoice ready" email to the
// end-customer and notifies the merchant. Pull EmailModule so that
// SubscriptionBillingService can inject EmailService.
import { EmailModule } from '../email/email.module';
// The single cron dispatch (SubscriptionController.cronDispatch) also
// runs the cap ladder-alert evaluation, so it needs CostControlService.
import { CostControlModule } from '../cost-control/cost-control.module';
// Same cron, third job — the staged pool-alert evaluation (plus the
// expired-grant sweep) needs PoolAlertEvaluator.
import { CreditPoolModule } from '../credit-pool/credit-pool.module';
// Same cron, fourth job — the customer-watch backstop sweep needs
// CustomerAlertsService.
import { CustomerAlertsModule } from '../customer-alerts/customer-alerts.module';

@Module({
  imports: [
    PrismaModule,
    InvoiceCalculatorModule,
    PdfModule,
    PaymentProvidersModule,
    AnalyticsModule,
    EmailModule,
    CostControlModule,
    CreditPoolModule,
    CustomerAlertsModule,
  ],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, SubscriptionBillingService],
  exports: [SubscriptionService, SubscriptionBillingService],
})
export class SubscriptionModule {}
