import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

/**
 * Query shape for `GET /v1/analytics/customer`.
 *
 * Typed instead of raw `@Query` strings: malformed dates
 * and non-UUID ids are rejected with a 400 rather than queried, and the
 * window is capped at ANALYTICS_MAX_WINDOW_DAYS.
 */
export class QueryCustomerAnalyticsDto {
  @ApiProperty({ description: 'Customer ID' })
  @IsUUID()
  customerId: string;

  @ApiProperty({ description: 'Start date in ISO format (YYYY-MM-DD)' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date in ISO format (YYYY-MM-DD)' })
  @IsDateString()
  @MaxWindowDays(ANALYTICS_MAX_WINDOW_DAYS)
  endDate: string;

  @ApiProperty({
    description: 'Time grouping: daily | weekly | monthly (default daily)',
    required: false,
  })
  @IsString()
  @IsOptional()
  groupBy?: string;
}
