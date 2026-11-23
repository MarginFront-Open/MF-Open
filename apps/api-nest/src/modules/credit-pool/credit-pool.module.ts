import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { CreditLedgerService } from './credit-ledger.service';
import { CreditPoolController } from './credit-pool.controller';
import { CreditPoolService } from './credit-pool.service';
import { PoolAlertEvaluator } from './pool-alert-evaluator.service';
import { PoolAlertTriggerService } from './pool-alert-trigger.service';

// AuthModule supplies CombinedAuthGuard's dependencies — the controller's guard
// resolves at BOOT, not in unit tests, so dropping it kills every environment
// while jest stays green (the boot spec pins this).
// PrismaModule supplies DB access; EmailModule lets the pool-alert
// evaluator send staged emails. The HTTP surface lives here rather
// than on the subscription controller, so every credit-pool route, its service,
// and its ledger seam live in one module. SdkModule imports this so recordUsage
// can draw after event storage and poke the pool-alert trigger; SubscriptionModule
// imports it so the single cron dispatch runs the daily evaluator sweep.
@Module({
  imports: [AuthModule, PrismaModule, EmailModule],
  controllers: [CreditPoolController],
  providers: [CreditLedgerService, CreditPoolService, PoolAlertEvaluator, PoolAlertTriggerService],
  exports: [CreditLedgerService, CreditPoolService, PoolAlertEvaluator, PoolAlertTriggerService],
})
export class CreditPoolModule {}
