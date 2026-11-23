import { Module } from '@nestjs/common';
import { PricingStrategiesService } from './pricing-strategies.service';
import { PricingStrategiesController } from './pricing-strategies.controller';

@Module({
  controllers: [PricingStrategiesController],
  providers: [PricingStrategiesService],
  exports: [PricingStrategiesService],
})
export class PricingStrategiesModule {}
