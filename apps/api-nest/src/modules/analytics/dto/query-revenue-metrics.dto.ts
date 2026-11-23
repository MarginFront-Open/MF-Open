import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

/**
 * Shape selector for `GET /v1/analytics/revenue`.
 *
 * legacy    - MRR trio + per-period / per-customer / per-agent breakdown
 *             (the org-wide shape the dashboard reads).
 * canonical - Canonical `RevenueMetrics` (revenue, cost, margin,
 *             marginPercent, usage/recurring/seat/onetime breakdown,
 *             bySubscription, byStrategy). Canon R1 + R2.
 *
 * When the caller passes `customerId`, `subscriptionId`, or `signalId`,
 * the canonical branch is selected regardless of this flag. Narrowing to
 * one entity only ever makes sense in the canonical shape. The variant
 * selector is for the org-wide case (no filters): the SDK reads canonical
 * RevenueMetrics; the dashboard reads the legacy breakdown.
 */
export enum RevenueVariantEnum {
  LEGACY = 'legacy',
  CANONICAL = 'canonical',
}

/**
 * Query shape for `GET /v1/analytics/revenue`.
 *
 * Wraps the canonical `getRevenueMetrics` function. Filters are optional
 * and ANDed. Passing `customerId` narrows to one customer, passing
 * `agentId` narrows to one agent, etc. All filters scope within the
 * authenticated organization (never cross-org).
 */
export class QueryRevenueMetricsDto {
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
      'Response shape. "canonical" returns RevenueMetrics; "legacy" keeps the dashboard breakdown (default).',
    enum: RevenueVariantEnum,
    required: false,
    default: RevenueVariantEnum.LEGACY,
  })
  @IsEnum(RevenueVariantEnum)
  @IsOptional()
  variant?: RevenueVariantEnum;
}
