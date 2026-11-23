import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsDateString, IsEnum } from 'class-validator';

export enum SdkGroupByEnum {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

export class QuerySdkUsageDto {
  @ApiProperty({ description: 'Start date (ISO format)', example: '2024-01-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date (ISO format)', example: '2024-01-31' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({
    description: 'Group by period',
    enum: SdkGroupByEnum,
    default: SdkGroupByEnum.DAILY,
  })
  @IsOptional()
  @IsEnum(SdkGroupByEnum)
  groupBy?: SdkGroupByEnum = SdkGroupByEnum.DAILY;

  @ApiPropertyOptional({ description: 'Filter by customer ID' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Filter by customer external ID' })
  @IsOptional()
  @IsString()
  customerExternalId?: string;

  @ApiPropertyOptional({ description: 'Filter by agent ID' })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ description: 'Filter by signal ID' })
  @IsOptional()
  @IsString()
  signalId?: string;

  // Scope the analytics window to a single subscription's activity, the
  // same filter the other canonical endpoints take.
  @ApiPropertyOptional({ description: 'Filter by subscription ID' })
  @IsOptional()
  @IsString()
  subscriptionId?: string;
}
