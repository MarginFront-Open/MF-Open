import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

/**
 * Query shape for `GET /v1/analytics/cost`.
 *
 * Wraps the canonical `getCostMetrics` function. Set `includePriorWindow=true`
 * to get period-over-period trend data in the `prior` response field (one
 * extra DB query). All filters scope within the authenticated organization.
 */
export class QueryCostMetricsDto {
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

  @ApiProperty({ description: 'Filter by signal ID', required: false })
  @IsUUID()
  @IsOptional()
  signalId?: string;

  @ApiProperty({ description: 'Filter by subscription ID', required: false })
  @IsUUID()
  @IsOptional()
  subscriptionId?: string;

  @ApiProperty({
    description:
      'When true, includes a `prior` field in the response with symmetric-span trend data.',
    required: false,
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includePriorWindow?: boolean = false;
}
