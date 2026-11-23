import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

export class QuerySubscriptionAnalyticsDto {
  @ApiProperty({ description: 'Billing period start date in ISO format', required: false })
  @IsDateString()
  @IsOptional()
  billingPeriodStart?: string;

  @ApiProperty({ description: 'Billing period end date in ISO format', required: false })
  @IsDateString()
  @IsOptional()
  @MaxWindowDays(ANALYTICS_MAX_WINDOW_DAYS, 'billingPeriodStart')
  billingPeriodEnd?: string;
}
