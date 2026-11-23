import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsUUID, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { GroupByEnum } from './query-usage-analytics.dto';
import { ANALYTICS_MAX_WINDOW_DAYS, MaxWindowDays } from '../analytics-bounds';

export class QueryCostAnalyticsDto {
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

  @ApiProperty({
    description: 'Include service-level cost breakdown',
    default: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeServiceBreakdown?: boolean = true;
}
