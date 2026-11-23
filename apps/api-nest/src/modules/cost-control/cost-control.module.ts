import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { CostControlController } from './cost-control.controller';
import { CostControlService } from './cost-control.service';
import { CapAlertTriggerService } from './cap-alert-trigger.service';

// AuthModule supplies CombinedAuthGuard's dependencies; PrismaModule supplies the
// OrgRoleGuard's ba_member lookup and the service's DB access. Same wiring as SdkModule.
// EmailModule: evaluateCapAlerts sends ladder-alert emails via EmailService.
@Module({
  imports: [PrismaModule, AuthModule, EmailModule],
  controllers: [CostControlController],
  providers: [CostControlService, CapAlertTriggerService],
  exports: [CostControlService, CapAlertTriggerService],
})
export class CostControlModule {}
