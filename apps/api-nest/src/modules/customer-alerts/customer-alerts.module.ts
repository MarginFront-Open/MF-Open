import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CustomerAlertsController } from './customer-alerts.controller';
import { CustomerAlertsService } from './customer-alerts.service';
import { CustomerAlertTriggerService } from './customer-alert-trigger.service';

/**
 * WHAT THIS FILE DOES: wires Customer Watch Alerts, the cap/pool alert
 * engine pointed at real customers.
 * CONNECTS TO: app.module.ts (root registration, the controller-bearing
 * CostControlModule precedent), SdkModule (ingest trigger), and
 * SubscriptionModule (cron job 4).
 */
// AuthModule supplies CombinedAuthGuard's dependencies; PrismaModule supplies
// the OrgRoleGuard's ba_member lookup and the service's DB access (same wiring
// as CostControlModule). EmailModule: trigger + confirmation sends.
// AnalyticsModule exports RevenueMetricsService, the canonical
// per-customer cost/revenue path the evaluator reads through.
@Module({
  imports: [PrismaModule, AuthModule, EmailModule, AnalyticsModule],
  controllers: [CustomerAlertsController],
  providers: [CustomerAlertsService, CustomerAlertTriggerService],
  exports: [CustomerAlertsService, CustomerAlertTriggerService],
})
export class CustomerAlertsModule {}
