import { Module } from '@nestjs/common';
import { ServicePricingController } from './service-pricing.controller';
import { ServicePricingService } from './service-pricing.service';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ServicePricingController],
  providers: [ServicePricingService],
  exports: [ServicePricingService],
})
export class ServicePricingModule {}
