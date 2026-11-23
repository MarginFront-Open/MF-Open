import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

export enum GroupByEnum {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

export enum BreakdownByEnum {
  AGENT = 'agent',
  CUSTOMER = 'customer',
  SIGNAL = 'signal',
}

export class QueryUsageAnalyticsDto {
  @ApiProperty({ description: 'Start date in ISO format (YYYY-MM-DD)' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date in ISO format (YYYY-MM-DD)' })
  @IsDateString()
  @MaxWindowDays(ANALYTICS_MAX_WINDOW_DAYS)
  endDate: string;

  @ApiProperty({
    description: 'Time grouping',
    enum: GroupByEnum,
    default: GroupByEnum.DAILY,
    required: false,
  })
  @IsEnum(GroupByEnum)
  @IsOptional()
  groupBy?: GroupByEnum = GroupByEnum.DAILY;

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

  @ApiProperty({ description: 'Breakdown by dimension', enum: BreakdownByEnum, required: false })
  @IsEnum(BreakdownByEnum)
  @IsOptional()
  breakdownBy?: BreakdownByEnum;
}
