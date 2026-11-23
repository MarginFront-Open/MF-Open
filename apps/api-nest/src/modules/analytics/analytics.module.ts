import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { RevenueMetricsService } from './revenue-metrics.service';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, RevenueMetricsService],
  exports: [AnalyticsService, RevenueMetricsService],
})
export class AnalyticsModule {}
