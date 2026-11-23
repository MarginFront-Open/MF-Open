import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

/**
 * Query shape for `GET /v1/analytics/events/aggregate`.
 *
 * Typed instead of raw `@Query` strings: malformed dates
 * and non-UUID ids are rejected with a 400 rather than queried, and the
 * window is capped at ANALYTICS_MAX_WINDOW_DAYS.
 */
export class QueryAggregateEventsDto {
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

  @ApiProperty({ description: 'Filter by customer ID', required: false })
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiProperty({ description: 'Filter by customer external ID', required: false })
  @IsString()
  @IsOptional()
  customerExternalId?: string;

  @ApiProperty({ description: 'Filter by agent ID', required: false })
  @IsUUID()
  @IsOptional()
  agentId?: string;

  @ApiProperty({ description: 'Filter by signal ID', required: false })
  @IsUUID()
  @IsOptional()
  signalId?: string;

  @ApiProperty({
    description: 'Breakdown dimension: customer | agent | signal',
    required: false,
  })
  @IsString()
  @IsOptional()
  dimension?: string;
}
