import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { ModelPricingService } from './model-pricing.service';

@Module({
  imports: [PrismaModule],
  providers: [ModelPricingService],
  exports: [ModelPricingService],
})
export class EventProcessingModule {}
