import { forwardRef, Module } from '@nestjs/common';
import { SdkService } from './sdk.service';
import { SdkController } from './sdk.controller';
import { SdkPublicAliasesController } from './sdk-public-aliases.controller';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EventProcessingModule } from '../event-processing/event-processing.module';
import { AnalyticsModule } from '../analytics/analytics.module';
// InvoicesModule exports InvoicesService. SdkController needs it so the
// SDK-facing POST /v1/sdk/invoices/generate route can delegate to the same
// generateInvoice() that the public POST /v1/invoices/generate route uses.
// forwardRef keeps the import working if InvoicesModule and SdkModule form a cycle.
import { InvoicesModule } from '../invoices/invoices.module';
// CostControlModule exports CapAlertTriggerService: recordUsage pokes it after a
// successful code-cost-clarity event so cap alerts evaluate at the point of spend.
import { CostControlModule } from '../cost-control/cost-control.module';
// CreditPoolModule exports CreditLedgerService: recordUsage draws from the
// credit pool after event storage, non-fatal (track-only).
import { CreditPoolModule } from '../credit-pool/credit-pool.module';
// CustomerAlertsModule exports CustomerAlertTriggerService: recordUsage pokes it
// after a successful REAL-customer event so customer watches evaluate at the
// point of spend — the inverse gate of the cap trigger above.
import { CustomerAlertsModule } from '../customer-alerts/customer-alerts.module';

@Module({
  // AnalyticsModule exports RevenueMetricsService, the canonical
  // cost/revenue/MRR library wrapper. getUsageAnalytics delegates to
  // it instead of hand-rolling per-event metadata sums.
  imports: [
    PrismaModule,
    AuthModule,
    EventProcessingModule,
    AnalyticsModule,
    forwardRef(() => InvoicesModule),
    CostControlModule,
    CreditPoolModule,
    CustomerAlertsModule,
  ],
  controllers: [SdkController, SdkPublicAliasesController],
  providers: [SdkService],
  exports: [SdkService],
})
export class SdkModule {}
