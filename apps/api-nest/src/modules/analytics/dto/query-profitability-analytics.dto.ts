import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

/**
 * Query shape for `GET /v1/analytics/profitability`.
 *
 * Typed instead of raw `@Query` strings: malformed dates
 * and non-UUID ids are rejected with a 400 rather than queried, and the
 * window is capped at ANALYTICS_MAX_WINDOW_DAYS.
 */
export class QueryProfitabilityAnalyticsDto {
  @ApiProperty({ description: 'Start date in ISO format (YYYY-MM-DD)' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date in ISO format (YYYY-MM-DD)' })
  @IsDateString()
  @MaxWindowDays(ANALYTICS_MAX_WINDOW_DAYS)
  endDate: string;

  @ApiProperty({ description: 'Filter by customer ID', required: false })
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiProperty({ description: 'Filter by agent ID', required: false })
  @IsUUID()
  @IsOptional()
  agentId?: string;
}
