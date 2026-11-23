import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  IsDate,
  IsBoolean,
  IsOptional,
  IsIn,
  IsNumber,
  IsObject,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSubscriptionDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsUUID()
  planId: string;

  @ApiProperty()
  @IsUUID()
  agentId: string;

  @ApiProperty()
  @IsUUID()
  customerId: string;

  @ApiProperty()
  @IsDate()
  @Type(() => Date)
  startDate: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endDate?: Date;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isForever?: boolean;

  @ApiPropertyOptional({ enum: ['upcoming', 'active', 'ended'], default: 'upcoming' })
  @IsOptional()
  @IsIn(['upcoming', 'active', 'ended'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  subscriptionDetails?: any;

  @ApiPropertyOptional({ enum: ['monthly', 'yearly', 'custom'], default: 'monthly' })
  @IsOptional()
  @IsIn(['monthly', 'yearly', 'custom'])
  billingCycle?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  seatsCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  customCycleDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  proratedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  billingDay?: number;

  @ApiPropertyOptional({ enum: ['subscription', 'usage', 'hybrid'], default: 'subscription' })
  @IsOptional()
  @IsIn(['subscription', 'usage', 'hybrid'])
  billingModel?: string;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  netTerms?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  autoCollectPayment?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  invoiceMemo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: any;
}
